import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LEGACY_LAUNCHER_MARKER = 'GYLL_BIN'
const LEGACY_POSIX_LAUNCHERS = ['gyll', 'gyll-tui']
const LEGACY_WINDOWS_LAUNCHERS = ['gyll.cmd', 'gyll-tui.cmd']
const LEGACY_PROFILE_FILES = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile']
const LEGACY_PATH_BLOCK = /(^|\r?\n)# >>> Gyll CLI >>>\r?\n[\s\S]*?\r?\n# <<< Gyll CLI <<<(?:\r?\n|$)/g

type Logger = Pick<Console, 'info' | 'warn'>

export interface DeprecatedCliCleanupOptions {
  homeDir?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  logger?: Logger
}

export interface DeprecatedCliCleanupResult {
  removedPaths: string[]
  updatedProfiles: string[]
}

// Remove only artifacts carrying the historical desktop installer's explicit
// ownership markers. The current CLI never writes shell profiles or these paths.
export function cleanupDeprecatedCliLaunchers(options: DeprecatedCliCleanupOptions = {}): DeprecatedCliCleanupResult {
  const logger = options.logger ?? console
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? os.homedir()
  const env = options.env ?? process.env
  const removedPaths: string[] = []
  const updatedProfiles: string[] = []

  for (const launcherPath of resolveLegacyLauncherPaths(platform, homeDir, env)) {
    if (!isLegacyLauncherFile(launcherPath, logger)) continue
    try {
      fs.rmSync(launcherPath, { force: true })
      removedPaths.push(launcherPath)
    } catch (error) {
      logger.warn(`[CLI] Failed to remove deprecated gyll launcher: ${launcherPath}`, error)
    }
  }

  removeEmptyLegacyBinDirs(homeDir, logger)
  if (platform !== 'win32') {
    updatedProfiles.push(...removeLegacyProfileBlocks(homeDir, logger))
  }

  if (removedPaths.length > 0) {
    logger.info(`[CLI] Removed deprecated gyll launchers: ${removedPaths.join(', ')}`)
  }
  if (updatedProfiles.length > 0) {
    logger.info(`[CLI] Removed deprecated gyll PATH blocks: ${updatedProfiles.join(', ')}`)
  }
  return { removedPaths, updatedProfiles }
}

function removeLegacyProfileBlocks(homeDir: string, logger: Logger): string[] {
  const updatedProfiles: string[] = []
  for (const fileName of LEGACY_PROFILE_FILES) {
    const filePath = path.join(homeDir, fileName)
    let effectivePath: string
    let content: string
    let mode: number
    let originalStat: fs.Stats | undefined
    try {
      const linkStat = fs.lstatSync(filePath)
      effectivePath = linkStat.isSymbolicLink() ? fs.realpathSync(filePath) : filePath
      originalStat = fs.statSync(effectivePath)
      if (!originalStat.isFile()) continue
      mode = originalStat.mode
      content = fs.readFileSync(effectivePath, 'utf8')
    } catch (error) {
      if (isMissing(error)) continue
      logger.warn(`[CLI] Unable to inspect deprecated PATH block: ${filePath}`, error)
      continue
    }
    if (!originalStat) continue
    const next = content.replace(LEGACY_PATH_BLOCK, '$1')
    if (next === content) continue
    const temporaryPath = path.join(
      path.dirname(effectivePath),
      `.${path.basename(effectivePath)}.gyshell-cli-cleanup-${process.pid}-${randomUUID()}`
    )
    try {
      fs.writeFileSync(temporaryPath, next, {
        encoding: 'utf8',
        flag: 'wx',
        mode,
      })
      const currentStat = fs.statSync(effectivePath)
      if (currentStat.dev !== originalStat.dev || currentStat.ino !== originalStat.ino) {
        throw new Error(`Profile changed while it was being cleaned: ${filePath}`)
      }
      fs.renameSync(temporaryPath, effectivePath)
      updatedProfiles.push(filePath)
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true })
      logger.warn(`[CLI] Failed to remove deprecated PATH block: ${filePath}`, error)
    }
  }
  return updatedProfiles
}

function resolveLegacyLauncherPaths(platform: NodeJS.Platform, homeDir: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    return resolveWindowsLegacyBinDirs(homeDir, env).flatMap((binDir) =>
      LEGACY_WINDOWS_LAUNCHERS.map((fileName) => path.join(binDir, fileName))
    )
  }

  const binDir = path.join(homeDir, '.gyll', 'bin')
  return LEGACY_POSIX_LAUNCHERS.map((fileName) => path.join(binDir, fileName))
}

function resolveWindowsLegacyBinDirs(homeDir: string, env: NodeJS.ProcessEnv): string[] {
  const dirs = [path.join(homeDir, '.gyll', 'bin')]
  const localAppData = (env.LOCALAPPDATA || '').trim()
  if (localAppData) {
    dirs.unshift(path.join(localAppData, 'Microsoft', 'WindowsApps'))
  }
  return [...new Set(dirs)]
}

function isLegacyLauncherFile(filePath: string, logger: Logger): boolean {
  if (!isFile(filePath)) return false
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return content.includes(LEGACY_LAUNCHER_MARKER)
  } catch (error) {
    logger.warn(`[CLI] Unable to inspect deprecated gyll launcher: ${filePath}`, error)
    return false
  }
}

function removeEmptyLegacyBinDirs(homeDir: string, logger: Logger): void {
  const dirs = [path.join(homeDir, '.gyll', 'bin')]
  for (const dir of dirs) {
    removeDirectoryIfEmpty(dir, logger)
  }
  removeDirectoryIfEmpty(path.join(homeDir, '.gyll'), logger)
}

function removeDirectoryIfEmpty(dirPath: string, logger: Logger): void {
  try {
    fs.rmdirSync(dirPath)
  } catch (error) {
    if (isExpectedRmdirFailure(error)) return
    logger.warn(`[CLI] Failed to remove empty deprecated gyll directory: ${dirPath}`, error)
  }
}

function isExpectedRmdirFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST'
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT'
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}
