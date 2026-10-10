import fs from 'node:fs'
import path from 'node:path'

const ARCH_BY_BUILDER_VALUE = {
  1: 'x64',
  3: 'arm64',
}

const REQUIRED_NODE_PTY_FILES = [
  'lib/index.js',
  'lib/windowsTerminal.js',
  'lib/windowsPtyAgent.js',
  'lib/windowsConoutConnection.js',
  'lib/worker/conoutSocketWorker.js',
  'lib/shared/conout.js',
]

const ensureFileExists = (filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing unpacked Windows node-pty runtime file: ${filePath}`)
  }
}

export default async function validateWindowsNodePtyRuntime(context) {
  if (context?.electronPlatformName !== 'win32') {
    return
  }

  const arch = ARCH_BY_BUILDER_VALUE[context.arch]
  if (!arch) {
    throw new Error(`Unsupported Windows pack architecture: ${context.arch}`)
  }

  const nodePtyRoot = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty'
  )

  REQUIRED_NODE_PTY_FILES.forEach((relativePath) => {
    ensureFileExists(path.join(nodePtyRoot, relativePath))
  })

  const windowsAssets = [
    `prebuilds/win32-${arch}/pty.node`,
    `prebuilds/win32-${arch}/winpty-agent.exe`,
    `prebuilds/win32-${arch}/winpty.dll`,
    `prebuilds/win32-${arch}/conpty.node`,
    `prebuilds/win32-${arch}/conpty/conpty.dll`,
    `prebuilds/win32-${arch}/conpty/OpenConsole.exe`,
  ]

  windowsAssets.forEach((relativePath) => {
    ensureFileExists(path.join(nodePtyRoot, relativePath))
  })

  const workerBootstrapPath = path.join(nodePtyRoot, 'lib', 'windowsConoutConnection.js')
  const workerBootstrapSource = fs.readFileSync(workerBootstrapPath, 'utf8')
  if (!workerBootstrapSource.includes("app.asar.unpacked")) {
    throw new Error(`node-pty worker bootstrap was not patched for app.asar: ${workerBootstrapPath}`)
  }

  const ptyAgentPath = path.join(nodePtyRoot, 'lib', 'windowsPtyAgent.js')
  const ptyAgentSource = fs.readFileSync(ptyAgentPath, 'utf8')
  if (!ptyAgentSource.includes('if (this._useConpty === undefined) {')) {
    throw new Error(
      `node-pty ConPTY selection was not patched to honor explicit useConpty: ${ptyAgentPath}`
    )
  }
}
