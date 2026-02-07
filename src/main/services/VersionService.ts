import https from 'node:https'
import Store from 'electron-store'
import { app } from 'electron'

interface VersionManifest {
  version: string
  download?: string
  notes?: string
}

interface VersionCache {
  etag?: string
  lastCheckedAt?: number
  latestVersion?: string
  downloadUrl?: string
  releaseNotes?: string
}

export interface VersionCheckResult {
  status: 'up-to-date' | 'update-available' | 'error'
  currentVersion: string
  latestVersion?: string
  downloadUrl: string
  releaseNotes?: string
  note: string
  checkedAt: number
  sourceUrl: string
  warning?: string
}

const VERSION_MANIFEST_URL = 'https://raw.githubusercontent.com/MrOrangeJJ/GyShell/main/version.json'
const FALLBACK_DOWNLOAD_URL = 'https://github.com/MrOrangeJJ/GyShell/releases/latest'
const VERSION_NOTE =
  'Version checks are sent only to this project GitHub repository (version.json). No third-party websites are contacted. This is the only network request the app may perform automatically in the background.'

export class VersionService {
  private readonly store: Store<VersionCache>
  private lastResult: VersionCheckResult | null = null

  constructor() {
    this.store = new Store<VersionCache>({
      name: 'gyshell-version-cache',
      defaults: {}
    })
  }

  getState(): VersionCheckResult {
    if (this.lastResult) {
      return this.lastResult
    }

    const currentVersion = this.normalizeVersion(app.getVersion())
    const cachedVersion = this.store.get('latestVersion')
    const checkedAt = this.store.get('lastCheckedAt') ?? 0
    const downloadUrl = this.store.get('downloadUrl') ?? FALLBACK_DOWNLOAD_URL
    const releaseNotes = this.store.get('releaseNotes')

    const status = cachedVersion
      ? this.compareVersions(cachedVersion, currentVersion) > 0
        ? 'update-available'
        : 'up-to-date'
      : 'up-to-date'

    return {
      status,
      currentVersion,
      latestVersion: cachedVersion,
      downloadUrl,
      releaseNotes,
      note: VERSION_NOTE,
      checkedAt,
      sourceUrl: VERSION_MANIFEST_URL
    }
  }

  async checkForUpdates(): Promise<VersionCheckResult> {
    const currentVersion = this.normalizeVersion(app.getVersion())
    const cachedEtag = this.store.get('etag')
    const now = Date.now()

    try {
      const response = await this.requestManifest(cachedEtag)
      let latestVersion = this.store.get('latestVersion')
      let downloadUrl = this.store.get('downloadUrl') ?? FALLBACK_DOWNLOAD_URL
      let releaseNotes = this.store.get('releaseNotes')

      if (response.statusCode === 200) {
        latestVersion = this.normalizeVersion(response.manifest.version)
        downloadUrl = response.manifest.download || FALLBACK_DOWNLOAD_URL
        releaseNotes = response.manifest.notes
        this.store.set('latestVersion', latestVersion)
        this.store.set('downloadUrl', downloadUrl)
        this.store.set('releaseNotes', releaseNotes)
        if (response.etag) {
          this.store.set('etag', response.etag)
        }
      } else if (response.statusCode !== 304) {
        throw new Error(`Unexpected status code: ${response.statusCode}`)
      }

      if (!latestVersion) {
        throw new Error('Remote version.json is missing a version field')
      }

      this.store.set('lastCheckedAt', now)

      const status = this.compareVersions(latestVersion, currentVersion) > 0 ? 'update-available' : 'up-to-date'

      const result: VersionCheckResult = {
        status,
        currentVersion,
        latestVersion,
        downloadUrl,
        releaseNotes,
        note: VERSION_NOTE,
        checkedAt: now,
        sourceUrl: VERSION_MANIFEST_URL
      }
      this.lastResult = result
      return result
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error)
      const result: VersionCheckResult = {
        status: 'error',
        currentVersion,
        latestVersion: this.store.get('latestVersion'),
        downloadUrl: this.store.get('downloadUrl') ?? FALLBACK_DOWNLOAD_URL,
        releaseNotes: this.store.get('releaseNotes'),
        note: VERSION_NOTE,
        checkedAt: now,
        sourceUrl: VERSION_MANIFEST_URL,
        warning
      }
      this.lastResult = result
      this.store.set('lastCheckedAt', now)
      return result
    }
  }

  private requestManifest(etag?: string): Promise<{ statusCode: number; manifest: VersionManifest; etag?: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(VERSION_MANIFEST_URL)
      const req = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': `GyShell/${app.getVersion()}`,
            ...(etag ? { 'If-None-Match': etag } : {})
          },
          timeout: 6000
        },
        (res) => {
          const statusCode = res.statusCode ?? 0
          const nextEtag = typeof res.headers.etag === 'string' ? res.headers.etag : undefined

          if (statusCode === 304) {
            resolve({ statusCode, manifest: { version: '' }, etag: nextEtag })
            res.resume()
            return
          }

          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`HTTP ${statusCode}`))
            res.resume()
            return
          }

          let rawData = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            rawData += chunk
          })
          res.on('end', () => {
            try {
              const parsed = JSON.parse(rawData) as VersionManifest
              if (!parsed || typeof parsed.version !== 'string') {
                reject(new Error('Invalid version manifest format'))
                return
              }
              resolve({ statusCode, manifest: parsed, etag: nextEtag })
            } catch {
              reject(new Error('Failed to parse version manifest JSON'))
            }
          })
        }
      )

      req.on('timeout', () => {
        req.destroy(new Error('Version check timeout'))
      })

      req.on('error', (err) => {
        reject(err)
      })

      req.end()
    })
  }

  private normalizeVersion(version: string): string {
    return String(version || '').trim().replace(/^v/i, '')
  }

  private compareVersions(a: string, b: string): number {
    const aParts = this.normalizeVersion(a)
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
    const bParts = this.normalizeVersion(b)
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
    const maxLen = Math.max(aParts.length, bParts.length)
    for (let i = 0; i < maxLen; i += 1) {
      const left = aParts[i] ?? 0
      const right = bParts[i] ?? 0
      if (left > right) return 1
      if (left < right) return -1
    }
    return 0
  }
}
