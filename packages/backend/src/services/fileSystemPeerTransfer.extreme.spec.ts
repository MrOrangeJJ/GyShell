import type { TerminalService } from './TerminalService'
import {
  DIRECT_SSH_TRANSFER_MIN_BYTES,
  FileSystemService,
} from './FileSystemService'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const createHarness = (input?: {
  fileSizes?: Record<string, number>
  directoryPath?: string
  sourceType?: 'ssh' | 'local'
  targetType?: 'ssh' | 'local'
  sourceOs?: 'unix' | 'windows'
  targetOs?: 'unix' | 'windows'
  sameIdentity?: boolean
  existingTargetDirectory?: boolean
  peerResult?: 'transferred' | 'fallback' | 'abort'
}) => {
  const fileSizes = new Map(
    Object.entries(
      input?.fileSizes || {
        '/src/big.bin': DIRECT_SSH_TRANSFER_MIN_BYTES + 1,
      }
    )
  )
  const calls = {
    peer: 0,
    relayReads: 0,
    deleted: [] as Array<{ terminalId: string; path: string }>,
  }
  let targetExists = input?.existingTargetDirectory === true
  const terminalService = {
    statFile: async (terminalId: string, filePath: string) => {
      if (terminalId === 'target' && filePath === '/dst') {
        return { exists: true, isDirectory: true }
      }
      if (terminalId === 'source' && filePath === input?.directoryPath) {
        return { exists: true, isDirectory: true }
      }
      if (terminalId === 'source' && fileSizes.has(filePath)) {
        return {
          exists: true,
          isDirectory: false,
          size: fileSizes.get(filePath),
        }
      }
      if (terminalId === 'target' && targetExists && filePath !== '/dst') {
        return { exists: true, isDirectory: true }
      }
      return { exists: false, isDirectory: false }
    },
    listDirectory: async (_terminalId: string, directoryPath: string) => ({
      path: directoryPath,
      entries: Array.from(fileSizes, ([path, size]) => ({
        name: path.split('/').at(-1) || 'file.bin',
        path,
        isDirectory: false,
        isSymbolicLink: false,
        size,
      })),
    }),
    getRemoteOs: (terminalId: string) =>
      terminalId === 'source'
        ? input?.sourceOs || ('unix' as const)
        : input?.targetOs || ('unix' as const),
    getTerminalType: (terminalId: string) =>
      terminalId === 'source'
        ? input?.sourceType || ('ssh' as const)
        : input?.targetType || ('ssh' as const),
    getFileSystemIdentity: (terminalId: string) =>
      input?.sameIdentity ? 'ssh://same' : `ssh://${terminalId}`,
    resolvePathForFileSystem: async (_terminalId: string, filePath: string) => filePath,
    tryPeerFileTransfer: async (
      _sourceTerminalId: string,
      _sourcePath: string,
      _targetTerminalId: string,
      _targetPath: string,
      options: { expectedBytes: number; onProgress?: (bytes: number) => void }
    ) => {
      calls.peer += 1
      options.onProgress?.(Math.floor(options.expectedBytes / 2))
      if (input?.peerResult === 'abort') {
        const error = new Error('cancelled')
        error.name = 'AbortError'
        throw error
      }
      if (input?.peerResult === 'fallback') {
        return { status: 'fallback' as const, reason: 'direct-copy-failed' as const }
      }
      options.onProgress?.(options.expectedBytes)
      return { status: 'transferred' as const, transferredBytes: options.expectedBytes }
    },
    uploadFileFromLocalPath: async () => null,
    downloadFileToLocalPath: async () => null,
    readFileChunk: async (_terminalId: string, sourcePath: string, offset: number) => {
      calls.relayReads += 1
      const totalSize = fileSizes.get(sourcePath) || 0
      return {
        chunk: Buffer.from([1]),
        bytesRead: offset === 0 ? totalSize : 0,
        totalSize,
        nextOffset: totalSize,
        eof: true,
      }
    },
    writeFileChunk: async (
      _terminalId: string,
      _targetPath: string,
      offset: number,
      chunk: Buffer
    ) => ({ writtenBytes: chunk.length, nextOffset: offset + chunk.length }),
    createDirectory: async () => {},
    deletePath: async (terminalId: string, filePath: string) => {
      calls.deleted.push({ terminalId, path: filePath })
      if (terminalId === 'target') targetExists = false
    },
  }
  return {
    calls,
    service: new FileSystemService(terminalService as unknown as TerminalService),
  }
}

const run = async (): Promise<void> => {
  await runCase('eligible user-owned SSH files use peer transfer', async () => {
    const { calls, service } = createHarness()
    const result = await service.transferEntries(
      'source',
      ['/src/big.bin'],
      'target',
      '/dst',
      { allowPeerDirect: true }
    )
    assertEqual(calls.peer, 1, 'eligible transfer should attempt peer route')
    assertEqual(calls.relayReads, 0, 'successful peer route should bypass relay')
    assertEqual(result.transferredFiles, 1, 'peer route should finish one file')
  })

  await runCase('exactly 32 MiB remains on relay', async () => {
    const { calls, service } = createHarness({
      fileSizes: { '/src/boundary.bin': DIRECT_SSH_TRANSFER_MIN_BYTES },
    })
    await service.transferEntries('source', ['/src/boundary.bin'], 'target', '/dst', {
      allowPeerDirect: true,
    })
    assertEqual(calls.peer, 0, 'threshold must be strictly greater than 32 MiB')
    assertEqual(calls.relayReads, 1, 'boundary file should use relay')
  })

  await runCase('peer fallback keeps progress monotonic and bounded', async () => {
    const expectedBytes = DIRECT_SSH_TRANSFER_MIN_BYTES + 9
    const progress: number[] = []
    const { calls, service } = createHarness({
      fileSizes: { '/src/fallback.bin': expectedBytes },
      peerResult: 'fallback',
    })
    await service.transferEntries('source', ['/src/fallback.bin'], 'target', '/dst', {
      allowPeerDirect: true,
      onProgress: (value) => progress.push(value.bytesTransferred),
    })
    assertEqual(calls.peer, 1, 'fallback should attempt peer route')
    assertEqual(calls.relayReads, 1, 'failed peer route should relay')
    if (progress.some((value) => value > expectedBytes)) {
      throw new Error(`progress exceeded total: ${JSON.stringify(progress)}`)
    }
    if (progress.some((value, index) => index > 0 && value < progress[index - 1])) {
      throw new Error(`progress regressed: ${JSON.stringify(progress)}`)
    }
  })

  await runCase('peer cancellation never enters relay', async () => {
    const { calls, service } = createHarness({ peerResult: 'abort' })
    let caught: Error | null = null
    try {
      await service.transferEntries('source', ['/src/big.bin'], 'target', '/dst', {
        allowPeerDirect: true,
      })
    } catch (error) {
      caught = error as Error
    }
    if (!caught || !/Transfer cancelled/i.test(caught.message)) {
      throw new Error('peer AbortError should become transfer cancellation')
    }
    assertEqual(calls.relayReads, 0, 'cancelled direct route must not relay')
  })

  await runCase('local source never uses peer transfer', async () => {
    const { calls, service } = createHarness({ sourceType: 'local' })
    await service.transferEntries('source', ['/src/big.bin'], 'target', '/dst', {
      allowPeerDirect: true,
    })
    assertEqual(calls.peer, 0, 'local source should be excluded')
  })

  await runCase('large directory root never uses peer transfer', async () => {
    const { calls, service } = createHarness({
      fileSizes: { '/src/dir/large.bin': DIRECT_SSH_TRANSFER_MIN_BYTES + 1 },
      directoryPath: '/src/dir',
    })
    await service.transferEntries('source', ['/src/dir'], 'target', '/dst', {
      allowPeerDirect: true,
    })
    assertEqual(calls.peer, 0, 'directory root should be excluded')
  })

  await runCase('multi-file batch never uses peer transfer', async () => {
    const { calls, service } = createHarness({
      fileSizes: {
        '/src/a.bin': DIRECT_SSH_TRANSFER_MIN_BYTES + 1,
        '/src/b.bin': DIRECT_SSH_TRANSFER_MIN_BYTES + 1,
      },
    })
    await service.transferEntries(
      'source',
      ['/src/a.bin', '/src/b.bin'],
      'target',
      '/dst',
      { allowPeerDirect: true }
    )
    assertEqual(calls.peer, 0, 'multi-root batch should be excluded')
  })

  await runCase('peer transfer requires explicit trust flag', async () => {
    const { calls, service } = createHarness()
    await service.transferEntries('source', ['/src/big.bin'], 'target', '/dst')
    assertEqual(calls.peer, 0, 'legacy and agent paths should default to relay')
  })

  await runCase('direct move deletes source exactly once after success', async () => {
    const { calls, service } = createHarness()
    await service.transferEntries('source', ['/src/big.bin'], 'target', '/dst', {
      mode: 'move',
      allowPeerDirect: true,
    })
    const sourceDeletes = calls.deleted.filter((item) => item.terminalId === 'source')
    assertEqual(sourceDeletes.length, 1, 'successful direct move should delete source once')
  })

  await runCase('fallback move relays before deleting source once', async () => {
    const { calls, service } = createHarness({ peerResult: 'fallback' })
    await service.transferEntries('source', ['/src/big.bin'], 'target', '/dst', {
      mode: 'move',
      allowPeerDirect: true,
    })
    const sourceDeletes = calls.deleted.filter((item) => item.terminalId === 'source')
    assertEqual(calls.relayReads, 1, 'fallback move should relay')
    assertEqual(sourceDeletes.length, 1, 'fallback move should delete source once')
  })

  await runCase('cancelled direct move never deletes source', async () => {
    const { calls, service } = createHarness({ peerResult: 'abort' })
    await service
      .transferEntries('source', ['/src/big.bin'], 'target', '/dst', {
        mode: 'move',
        allowPeerDirect: true,
      })
      .catch(() => undefined)
    assertEqual(
      calls.deleted.some((item) => item.terminalId === 'source'),
      false,
      'cancelled move must preserve source',
    )
  })

  await runCase('overwrite pre-delete is not repeated after peer fallback', async () => {
    const { calls, service } = createHarness({
      peerResult: 'fallback',
      existingTargetDirectory: true,
    })
    await service.transferEntries('source', ['/src/big.bin'], 'target', '/dst', {
      conflictStrategy: 'overwrite',
      allowPeerDirect: true,
    })
    const targetDeletes = calls.deleted.filter((item) => item.terminalId === 'target')
    assertEqual(targetDeletes.length, 1, 'conflicting target should be deleted once')
    assertEqual(calls.relayReads, 1, 'overwrite fallback should relay')
  })

  await runCase('OS, endpoint type, and filesystem identity gates fail closed', async () => {
    for (const input of [
      { sourceOs: 'windows' as const },
      { targetOs: 'windows' as const },
      { targetType: 'local' as const },
      { sameIdentity: true },
    ]) {
      const { calls, service } = createHarness(input)
      await service.transferEntries('source', ['/src/big.bin'], 'target', '/dst', {
        allowPeerDirect: true,
      })
      assertEqual(calls.peer, 0, `gate should exclude ${JSON.stringify(input)}`)
    }
  })
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
