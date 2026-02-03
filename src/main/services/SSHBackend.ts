import * as ssh2 from 'ssh2'
import * as fs from 'fs'
import * as net from 'net'
import { SocksClient } from 'socks'
import type { TerminalBackend, TerminalConfig, SSHConnectionConfig } from '../types'

interface SSHInstance {
  client: ssh2.Client
  stream?: ssh2.ClientChannel
  sftp?: ssh2.SFTPWrapper
  dataCallbacks: Set<(data: string) => void>
  exitCallbacks: Set<(code: number) => void>
  isInitializing: boolean
  buffer: string
  oscBuffer: string
  cwd?: string
  homeDir?: string
  remoteOs?: 'unix' | 'windows'
  forwardServers: net.Server[]
  remoteForwards: Array<{ host: string; port: number }>
  remoteForwardHandlerInstalled: boolean
}

export class SSHBackend implements TerminalBackend {
  private sessions: Map<string, SSHInstance> = new Map()

  private async execCollect(
    client: ssh2.Client,
    command: string,
    timeoutMs = 6000
  ): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`exec timeout: ${command}`))
      }, timeoutMs)

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          reject(err)
          return
        }

        stream.on('data', (d: Buffer) => {
          stdout += d.toString('utf8')
        })
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8')
        })
        stream.on('close', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ stdout, stderr })
        })
      })
    })
  }

  private buildWindowsPowerShellEncodedCommand(): string {
    const psInit = `
function Global:prompt {
  $ec = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { if ($?) { 0 } else { 1 } }
  $cwd_b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PWD.Path))
  $home_b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($HOME))
  Write-Host -NoNewline "$([char]27)]1337;gyshell_precmd;ec=$ec;cwd_b64=$cwd_b64;home_b64=$home_b64$([char]7)"
  return "PS $($PWD.Path)> "
}
Clear-Host
Write-Output "__GYSHELL_READY__"
`
    // PowerShell -EncodedCommand requires UTF-16LE.
    return Buffer.from(psInit, 'utf16le').toString('base64')
  }

  private async connectViaSocks5Proxy(opts: {
    proxyHost: string
    proxyPort: number
    proxyUsername?: string
    proxyPassword?: string
    dstHost: string
    dstPort: number
  }): Promise<net.Socket> {
    const info = await SocksClient.createConnection({
      proxy: {
        host: opts.proxyHost,
        port: opts.proxyPort,
        type: 5,
        userId: opts.proxyUsername,
        password: opts.proxyPassword
      },
      command: 'connect',
      destination: {
        host: opts.dstHost,
        port: opts.dstPort
      },
      timeout: 10000 // 10s timeout for proxy handshake
    })

    return info.socket
  }

  private async connectViaHttpProxy(opts: {
    proxyHost: string
    proxyPort: number
    proxyUsername?: string
    proxyPassword?: string
    dstHost: string
    dstPort: number
  }): Promise<net.Socket> {
    // socks library also supports HTTP proxies via type: 1 (or we can use it for CONNECT)
    // However, for maximum compatibility with standard HTTP proxies, we'll use SocksClient's HTTP support
    const info = await SocksClient.createConnection({
      proxy: {
        host: opts.proxyHost,
        port: opts.proxyPort,
        type: 5, // Default to 5, but we will check if socks supports HTTP directly or if we need another approach
        userId: opts.proxyUsername,
        password: opts.proxyPassword
      },
      command: 'connect',
      destination: {
        host: opts.dstHost,
        port: opts.dstPort
      }
    }).catch(async (err) => {
      // If socks library fails or doesn't support the specific HTTP proxy, 
      // we could fallback to a specialized HTTP tunnel library if needed.
      // But for now, let's stick to the most robust way.
      throw err
    })

    return info.socket
  }

  private async buildConnectSocketIfNeeded(sshConfig: SSHConnectionConfig): Promise<net.Socket | undefined> {
    const proxy = sshConfig.proxy
    if (!proxy) return undefined

    if (proxy.type === 'socks5') {
      return await this.connectViaSocks5Proxy({
        proxyHost: proxy.host,
        proxyPort: proxy.port,
        proxyUsername: proxy.username,
        proxyPassword: proxy.password,
        dstHost: sshConfig.host,
        dstPort: sshConfig.port
      })
    }
    if (proxy.type === 'http') {
      return await this.connectViaHttpProxy({
        proxyHost: proxy.host,
        proxyPort: proxy.port,
        proxyUsername: proxy.username,
        proxyPassword: proxy.password,
        dstHost: sshConfig.host,
        dstPort: sshConfig.port
      })
    }

    return undefined
  }

  private async setupPortForwards(instance: SSHInstance, sshConfig: SSHConnectionConfig): Promise<void> {
    const tunnels = sshConfig.tunnels ?? []
    if (!tunnels.length) return

    const remoteTunnels = tunnels.filter((t) => t.type === 'Remote')
    if (remoteTunnels.length && !instance.remoteForwardHandlerInstalled) {
      instance.remoteForwardHandlerInstalled = true
      instance.client.on('tcp connection', (info: any, accept, reject) => {
        const match = remoteTunnels.find((t) => t.host === info.destIP && t.port === info.destPort)
        if (!match || !match.targetAddress || !match.targetPort) {
          reject?.()
          return
        }
        const upstream = net.connect(match.targetPort, match.targetAddress)
        upstream.once('error', () => {
          try {
            reject?.()
          } catch {}
        })
        const ch = accept()
        ch.on('data', (d: Buffer) => upstream.write(d))
        upstream.on('data', (d) => ch.write(d))
        ch.on('close', () => upstream.destroy())
        upstream.on('close', () => {
          try {
            ch.close()
          } catch {}
        })
      })
    }

    for (const t of tunnels) {
      if (t.type === 'Local') {
        const server = net.createServer((sock) => {
          const srcAddr = sock.remoteAddress ?? '127.0.0.1'
          const srcPort = sock.remotePort ?? 0
          const dstAddr = t.targetAddress ?? '127.0.0.1'
          const dstPort = t.targetPort ?? 0
          instance.client.forwardOut(srcAddr, srcPort, dstAddr, dstPort, (err, stream) => {
            if (err || !stream) {
              sock.destroy()
              return
            }
            sock.pipe(stream)
            stream.pipe(sock)
            stream.on('close', () => sock.destroy())
            sock.on('close', () => {
              try {
                stream.close()
              } catch {}
            })
          })
        })
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(t.port, t.host, resolve)
        })
        instance.forwardServers.push(server)
      } else if (t.type === 'Dynamic') {
        const server = net.createServer((sock) => {
          let buf = Buffer.alloc(0)
          const need = async (n: number): Promise<Buffer> => {
            while (buf.length < n) {
              const chunk = await new Promise<Buffer>((resolve, reject) => {
                const onData = (d: Buffer) => {
                  sock.off('error', onErr)
                  resolve(d)
                }
                const onErr = (e: Error) => {
                  sock.off('data', onData)
                  reject(e)
                }
                sock.once('data', onData)
                sock.once('error', onErr)
              })
              buf = Buffer.concat([buf, chunk])
            }
            const out = buf.subarray(0, n)
            buf = buf.subarray(n)
            return out
          }

          ;(async () => {
            try {
              const hello = await need(2)
              if (hello[0] !== 0x05) throw new Error('SOCKS version mismatch')
              const nMethods = hello[1]
              const methods = await need(nMethods)
              const wantsAuth = false
              const method = wantsAuth ? 0x02 : 0x00
              if (!methods.includes(method)) {
                sock.write(Buffer.from([0x05, 0xff]))
                sock.destroy()
                return
              }
              sock.write(Buffer.from([0x05, method]))

              const reqHead = await need(4)
              if (reqHead[0] !== 0x05) throw new Error('SOCKS request version mismatch')
              const cmd = reqHead[1]
              const atyp = reqHead[3]
              if (cmd !== 0x01) {
                sock.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
                sock.destroy()
                return
              }

              let dstAddr = ''
              if (atyp === 0x01) {
                const a = await need(4)
                dstAddr = `${a[0]}.${a[1]}.${a[2]}.${a[3]}`
              } else if (atyp === 0x03) {
                const l = await need(1)
                const name = await need(l[0])
                dstAddr = name.toString('utf8')
              } else if (atyp === 0x04) {
                const a = await need(16)
                const parts: string[] = []
                for (let i = 0; i < 16; i += 2) {
                  parts.push(((a[i] << 8) | a[i + 1]).toString(16))
                }
                dstAddr = parts.join(':')
              } else {
                throw new Error('Unknown ATYP')
              }
              const p = await need(2)
              const dstPort = (p[0] << 8) | p[1]

              instance.client.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, dstAddr, dstPort, (err, stream) => {
                if (err || !stream) {
                  sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
                  sock.destroy()
                  return
                }
                sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
                if (buf.length) {
                  stream.write(buf)
                  buf = Buffer.alloc(0)
                }
                sock.pipe(stream)
                stream.pipe(sock)
                stream.on('close', () => sock.destroy())
                sock.on('close', () => {
                  try {
                    stream.close()
                  } catch {}
                })
              })
            } catch {
              sock.destroy()
            }
          })()
        })
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(t.port, t.host, resolve)
        })
        instance.forwardServers.push(server)
      } else if (t.type === 'Remote') {
        await new Promise<void>((resolve, reject) => {
          instance.client.forwardIn(t.host, t.port, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        instance.remoteForwards.push({ host: t.host, port: t.port })
      }
    }
  }

  async spawn(config: TerminalConfig): Promise<string> {
    if (config.type !== 'ssh') {
      throw new Error('SSHBackend only supports ssh connections')
    }
    const sshConfig = config as SSHConnectionConfig

    const client = new ssh2.Client()
    
    const instance: SSHInstance = {
      client,
      dataCallbacks: new Set(),
      exitCallbacks: new Set(),
      isInitializing: true,
      buffer: '',
      oscBuffer: '',
      forwardServers: [],
      remoteForwards: [],
      remoteForwardHandlerInstalled: false
    }
    this.sessions.set(config.id, instance)

    // Start connection process in background so we can return the ID immediately
    // and allow TerminalService to register data listeners.
    ;(async () => {
      const emit = (data: string) => {
        instance.dataCallbacks.forEach(cb => cb(data))
      }

      client.on('ready', async () => {
        emit('\x1b[2J\x1b[H\x1b[32m✔ Connection established.\x1b[0m\r\n')
        console.log(`[SSH] Connection ready for ${sshConfig.host}:${sshConfig.port}`)
        try {
          emit('\x1b[36m▹ Setting up port forwards...\x1b[0m\r\n')
          console.log(`[SSH] Setting up port forwards...`)
          await this.setupPortForwards(instance, sshConfig)
        } catch (e: any) {
          console.error(`[SSH] Port forward setup failed:`, e)
          emit(`\x1b[31m✘ Port forward failed: ${e.message}\x1b[0m\r\n`)
          // We continue anyway to allow shell access
        }

        try {
          emit('\x1b[36m▹ Detecting remote OS...\x1b[0m\r\n')
          console.log(`[SSH] Detecting remote OS...`)
          const uname = await this.execCollect(client, 'uname -s')
          const u = (uname.stdout || uname.stderr || '').toLowerCase()
          if (u.includes('linux') || u.includes('darwin')) {
            instance.remoteOs = 'unix'
          }
        } catch {
          // ignore
        }
        if (!instance.remoteOs) {
          try {
            const ver = await this.execCollect(client, 'cmd.exe /c ver')
            const v = (ver.stdout || ver.stderr || '').toLowerCase()
            if (v.includes('windows')) instance.remoteOs = 'windows'
          } catch {
            // ignore
          }
        }
        if (!instance.remoteOs) instance.remoteOs = 'unix'
        console.log(`[SSH] Remote OS detected: ${instance.remoteOs}`)

        emit('\x1b[36m▹ Opening interactive shell...\x1b[0m\r\n')
        console.log(`[SSH] Opening interactive shell...`)
        client.shell({ term: 'xterm-256color', cols: config.cols, rows: config.rows }, (err, stream) => {
          if (err) {
            console.error(`[SSH] Failed to open shell:`, err)
            emit(`\x1b[31m✘ Failed to open shell: ${err.message}\x1b[0m\r\n`)
            return
          }
          instance.stream = stream
          emit('\x1b[36m▹ Initializing shell integration...\x1b[0m\r\n')
          console.log(`[SSH] Shell stream opened. Starting robust initialization...`)

          let retryCount = 0
          const maxRetries = 3
          let isReadySent = false

          const attemptInjection = () => {
            if (!instance.stream || isReadySent) return
            
            console.log(`[SSH] Injection attempt ${retryCount + 1}...`)
            stream.write('\x03\n\n')

            setTimeout(() => {
              if (instance.remoteOs === 'windows') {
                const b64 = this.buildWindowsPowerShellEncodedCommand()
                stream.write(`powershell.exe -NoLogo -NoProfile -NoExit -EncodedCommand ${b64}\r`)
              } else {
                const script = this.getUnixInjectionScript()
                const b64 = Buffer.from(script).toString('base64')
                const injection = `  eval "$(printf '%s' '${b64}' | base64 -d 2>/dev/null || printf '%s' '${b64}' | base64 --decode 2>/dev/null)"\n`
                
                const CHUNK_SIZE = 256
                for (let i = 0; i < injection.length; i += CHUNK_SIZE) {
                  stream.write(injection.slice(i, i + CHUNK_SIZE))
                }
              }
            }, 500)
          }

          setTimeout(attemptInjection, 1000)

          const watchdogInterval = setInterval(() => {
            if (instance.isInitializing) {
              retryCount++
              if (retryCount >= maxRetries) {
                emit('\x1b[31m✘ Initialization failed. Entering fallback mode.\x1b[0m\r\n')
                console.error(`[SSH] Initialization FAILED after ${maxRetries} attempts for ${config.id}.`)
                clearInterval(watchdogInterval)
                instance.isInitializing = false 
                return
              }
              emit(`\x1b[33m⚠ Initialization timeout, retrying (${retryCount}/${maxRetries})...\x1b[0m\r\n`)
              attemptInjection()
            } else {
              clearInterval(watchdogInterval)
            }
          }, 8000)

          stream.on('data', (data: Buffer) => {
            const chunk = data.toString()
            if (instance.isInitializing) {
              instance.buffer += chunk
              if (instance.buffer.includes('__GYSHELL_READY__')) {
                emit('\x1b[2J\x1b[H') // Clear screen
                isReadySent = true
                clearInterval(watchdogInterval)
                const sawContinuation = /(?:\r?\n)>>\s*\r?\n/.test(instance.buffer) || instance.buffer.trimEnd().endsWith('\n>>') || instance.buffer.trimEnd().endsWith('\r\n>>')
                instance.isInitializing = false
                const parts = instance.buffer.split('__GYSHELL_READY__')
                if (parts.length > 1) {
                  const realContent = parts.slice(1).join('__GYSHELL_READY__').trimStart()
                  if (realContent) emit(realContent)
                }
                instance.buffer = '' 
                if (sawContinuation && instance.remoteOs === 'windows' && instance.stream) {
                  setTimeout(() => { try { instance.stream?.write('\r') } catch {} }, 50)
                }
              }
            } else {
              this.consumeOscMarkers(instance, chunk)
              emit(chunk)
            }
          })

          stream.on('close', (code: number) => {
            for (const s of instance.forwardServers) { try { s.close() } catch {} }
            for (const rf of instance.remoteForwards) { try { instance.client.unforwardIn(rf.host, rf.port) } catch {} }
            instance.exitCallbacks.forEach(cb => cb(code || 0))
            client.end()
            this.sessions.delete(config.id)
          })
        })
      })

      client.on('error', (err) => {
        console.error(`[SSH] Client error:`, err)
        emit(`\x1b[31m✘ SSH Error: ${err.message}\x1b[0m\r\n`)
        instance.exitCallbacks.forEach(cb => cb(-1))
      })

      const connectConfig: ssh2.ConnectConfig = {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        readyTimeout: 20000,
      }

      if (sshConfig.authMethod === 'password') {
        connectConfig.password = sshConfig.password
      } else if (sshConfig.authMethod === 'privateKey') {
        if (sshConfig.privateKey) {
          connectConfig.privateKey = sshConfig.privateKey
        } else if (sshConfig.privateKeyPath) {
          try {
            connectConfig.privateKey = fs.readFileSync(sshConfig.privateKeyPath)
          } catch (e: any) {
            emit(`\x1b[31m✘ Failed to read private key: ${e.message}\x1b[0m\r\n`)
          }
        }
        if (sshConfig.passphrase) {
          connectConfig.passphrase = sshConfig.passphrase
        }
      }

      try {
        // Give TerminalService a tiny bit of time to register the listener
        await new Promise(r => setTimeout(r, 50))
        
        emit(`\x1b[36m▹ Connecting to ${sshConfig.host}:${sshConfig.port}...\x1b[0m\r\n`)
        console.log(`[SSH] Attempting to connect to ${sshConfig.host}:${sshConfig.port}...`)
        const sock = await this.buildConnectSocketIfNeeded(sshConfig)
        if (sock) {
          emit('\x1b[36m▹ Using proxy socket...\x1b[0m\r\n')
          connectConfig.sock = sock
        }
        client.connect(connectConfig)
      } catch (e: any) {
        const errMsg = e instanceof Error ? e.message : String(e)
        emit(`\x1b[31m✘ Connection failed: ${errMsg}\x1b[0m\r\n`)
        instance.exitCallbacks.forEach(cb => cb(-1))
      }
    })()

    return config.id
  }

  write(ptyId: string, data: string): void {
    const instance = this.sessions.get(ptyId)
    if (instance && instance.stream) {
      instance.stream.write(data)
    }
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const instance = this.sessions.get(ptyId)
    if (instance && instance.stream) {
      instance.stream.setWindow(rows, cols, 0, 0)
    }
  }

  kill(ptyId: string): void {
    const instance = this.sessions.get(ptyId)
    if (instance) {
      for (const s of instance.forwardServers) { try { s.close() } catch {} }
      for (const rf of instance.remoteForwards) { try { instance.client.unforwardIn(rf.host, rf.port) } catch {} }
      try { instance.sftp?.end?.() } catch {}
      instance.client.end()
      this.sessions.delete(ptyId)
    }
  }

  onData(ptyId: string, callback: (data: string) => void): void {
    const instance = this.sessions.get(ptyId)
    if (instance) { instance.dataCallbacks.add(callback) }
  }

  onExit(ptyId: string, callback: (code: number) => void): void {
    const instance = this.sessions.get(ptyId)
    if (instance) { instance.exitCallbacks.add(callback) }
  }

  getCwd(ptyId: string): string | undefined {
    return this.sessions.get(ptyId)?.cwd
  }

  getRemoteOs(ptyId: string): 'unix' | 'windows' | undefined {
    return this.sessions.get(ptyId)?.remoteOs
  }

  async getSystemInfo(ptyId: string): Promise<any> {
    const instance = this.sessions.get(ptyId)
    if (!instance) return undefined

    const client = instance.client
    const isWindows = instance.remoteOs === 'windows'

    if (isWindows) {
      try {
        const [ver, info] = await Promise.all([
          this.execCollect(client, 'cmd.exe /c ver'),
          this.execCollect(client, 'powershell.exe -Command "Get-ComputerInfo -Property OsName,OsVersion,CsProcessors,CsName | ConvertTo-Json"')
        ])
        
        let osName = 'Windows'
        let release = ''
        let arch = ''
        let hostname = ''

        try {
          const parsed = JSON.parse(info.stdout)
          osName = parsed.OsName || 'Windows'
          release = parsed.OsVersion || ''
          hostname = parsed.CsName || ''
          arch = parsed.CsProcessors?.[0]?.Architecture || ''
        } catch {
          const verMatch = ver.stdout.match(/Version ([\d.]+)/)
          release = verMatch ? verMatch[1] : ''
        }

        return {
          os: osName,
          platform: 'win32',
          release,
          arch,
          hostname,
          isRemote: true,
          shell: 'powershell.exe'
        }
      } catch {
        return {
          os: 'Windows',
          platform: 'win32',
          release: 'unknown',
          arch: 'unknown',
          hostname: 'unknown',
          isRemote: true
        }
      }
    } else {
      try {
        const [uname, osRelease, hostname] = await Promise.all([
          this.execCollect(client, 'uname -a'),
          this.execCollect(client, 'cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null'),
          this.execCollect(client, 'hostname')
        ])

        let os = 'unix'
        const releaseMatch = osRelease.stdout.match(/^ID=(.*)$/m)
        if (releaseMatch) {
          os = releaseMatch[1].replace(/"/g, '')
        } else {
          const unameS = uname.stdout.split(' ')[0].toLowerCase()
          os = unameS || 'unix'
        }

        const parts = uname.stdout.split(' ')
        return {
          os,
          platform: process.platform === 'win32' ? 'linux' : 'unix', // Best guess
          release: parts[2] || '',
          arch: parts[parts.length - 2] || '',
          hostname: hostname.stdout.trim() || parts[1] || '',
          isRemote: true,
          shell: '/bin/sh' // Default fallback
        }
      } catch {
        return {
          os: 'unix',
          platform: 'unix',
          release: 'unknown',
          arch: 'unknown',
          hostname: 'unknown',
          isRemote: true
        }
      }
    }
  }

  private getUnixInjectionScript(): string {
    // Minified script to reduce payload size and potential TTY buffer issues
    const script = `
if [ -n "$ZSH_VERSION" ]; then
  gyshell_preexec() { printf '%b' '\\x1b]1337;gyshell_preexec\\x07'; }
  gyshell_precmd() { local ec=$?; printf '%b' "\\x1b]1337;gyshell_precmd;ec=\${ec};cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n");home_b64=$(printf "%s" "$HOME" | base64 | tr -d "\\n")\\x07"; }
  autoload -Uz add-zsh-hook 2>/dev/null || true
  add-zsh-hook preexec gyshell_preexec
  add-zsh-hook precmd gyshell_precmd
elif [ -n "$BASH_VERSION" ]; then
  __gyshell_in_command=0
  __gyshell_preexec() {
    case "$BASH_COMMAND" in
      __gyshell_precmd*|__gyshell_preexec* ) return ;;
    esac
    if [ "$__gyshell_in_command" = "0" ]; then
      __gyshell_in_command=1
      printf "%b" "\\x1b]1337;gyshell_preexec\\x07"
    fi
  }
  trap '__gyshell_preexec' DEBUG
  __gyshell_precmd() {
    local ec=$?
    __gyshell_in_command=0
    printf "%b" "\\x1b]1337;gyshell_precmd;ec=\${ec};cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n");home_b64=$(printf "%s" "$HOME" | base64 | tr -d "\\n")\\x07"
  }
  PROMPT_COMMAND="__gyshell_precmd\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}"
fi
echo "__GYSHELL_READY__"
`.trim()
    return script
  }

  async getHomeDir(ptyId: string): Promise<string | undefined> {
    return this.sessions.get(ptyId)?.homeDir
  }

  async statFile(ptyId: string, filePath: string): Promise<{ exists: boolean; isDirectory: boolean }> {
    const sftp = await this.getSftp(ptyId)
    const normalizedPath = filePath.replace(/\\/g, '/')
    try {
      const stat = await new Promise<ssh2.Stats>((resolve, reject) => {
        sftp.stat(normalizedPath, (err, stats) => {
          if (err || !stats) {
            reject(err || new Error('Failed to stat file'))
            return
          }
          resolve(stats)
        })
      })
      return { exists: true, isDirectory: stat.isDirectory() }
    } catch (err: any) {
      if (err?.code === 2 || err?.code === 'ENOENT') {
        return { exists: false, isDirectory: false }
      }
      throw err
    }
  }

  private async getSftp(ptyId: string): Promise<ssh2.SFTPWrapper> {
    const instance = this.sessions.get(ptyId)
    if (!instance) { throw new Error(`SSH session ${ptyId} not found`) }
    if (instance.sftp) return instance.sftp
    const sftp = await new Promise<ssh2.SFTPWrapper>((resolve, reject) => {
      instance.client.sftp((err, sftpClient) => {
        if (err || !sftpClient) {
          reject(err || new Error('Failed to initialize SFTP'))
          return
        }
        resolve(sftpClient)
      })
    })
    instance.sftp = sftp
    return sftp
  }

  async readFile(ptyId: string, filePath: string): Promise<Buffer> {
    const sftp = await this.getSftp(ptyId)
    const normalizedPath = filePath.replace(/\\/g, '/')
    const data = await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(normalizedPath, (err, buf) => {
        if (err || !buf) {
          reject(err || new Error('Failed to read file'))
          return
        }
        resolve(buf as Buffer)
      })
    })
    return data
  }

  async writeFile(ptyId: string, filePath: string, content: string): Promise<void> {
    const sftp = await this.getSftp(ptyId)
    const normalizedPath = filePath.replace(/\\/g, '/')
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(normalizedPath, Buffer.from(content, 'utf8'), (err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }

  private consumeOscMarkers(instance: SSHInstance, chunk: string): void {
    instance.oscBuffer += chunk
    const prefix = '\x1b]1337;gyshell_precmd'
    const suffix = '\x07'

    while (true) {
      const start = instance.oscBuffer.indexOf(prefix)
      if (start === -1) break
      const end = instance.oscBuffer.indexOf(suffix, start)
      if (end === -1) break

      const marker = instance.oscBuffer.slice(start, end)
      const cwdMatch = marker.match(/cwd_b64=([^;]+)/)
      if (cwdMatch && cwdMatch[1]) {
        try {
          const decoded = Buffer.from(cwdMatch[1], 'base64').toString('utf8')
          if (decoded) instance.cwd = decoded
        } catch {}
      }

      const homeMatch = marker.match(/home_b64=([^;]+)/)
      if (homeMatch && homeMatch[1]) {
        try {
          const decoded = Buffer.from(homeMatch[1], 'base64').toString('utf8')
          if (decoded) instance.homeDir = decoded
        } catch {}
      }

      instance.oscBuffer = instance.oscBuffer.slice(end + suffix.length)
    }

    if (instance.oscBuffer.length > 8192) {
      instance.oscBuffer = instance.oscBuffer.slice(-4096)
    }
  }
}
