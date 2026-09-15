import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import prunePackagedRuntime from './prune-packaged-runtime.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gyshell-prune-runtime-'))
const resourcesRoot = path.join(root, 'GyShell.app', 'Contents', 'Resources')
const nodePtyRoot = path.join(
  resourcesRoot,
  'app.asar.unpacked',
  'node_modules',
  'node-pty',
)
const helperPath = path.join(
  nodePtyRoot,
  'prebuilds',
  'darwin-arm64',
  'spawn-helper',
)

await fs.mkdir(path.dirname(helperPath), { recursive: true })
await fs.writeFile(helperPath, 'helper')
await fs.chmod(helperPath, 0o644)

await prunePackagedRuntime({
  electronPlatformName: 'darwin',
  arch: 3,
  appOutDir: root,
  packager: { appInfo: { productFilename: 'GyShell' } },
})

const mode = (await fs.stat(helperPath)).mode & 0o777
assert.equal(mode & 0o111, 0o111)

await fs.rm(root, { recursive: true, force: true })
console.log('prune-packaged-runtime extreme tests passed')
