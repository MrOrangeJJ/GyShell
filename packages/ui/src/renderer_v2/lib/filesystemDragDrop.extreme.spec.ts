import assert from 'node:assert/strict'
import {
  FILESYSTEM_PANEL_DRAG_MIME,
  decodeTerminalScopedFilePath,
  extractNativeDropFilePaths,
  encodeFileSystemPanelDragPayload,
  encodeTerminalScopedFilePath,
  extractFileSystemPayloadPaths,
  hasFileSystemPanelDragPayloadType,
  hasNativeFileDragType,
  getFileMentionDisplayName,
  getNativeFilePathResolver,
  normalizeFileSystemPanelDragPayload,
  parseFileSystemPanelDragPayload,
  resolveNativeFilePath,
  resolveTerminalDropPaths,
  resolveTerminalDropPathsForTarget
} from './filesystemDragDrop'

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const run = async (): Promise<void> => {
  await runCase('terminal scoped file paths round-trip with URI-safe terminal IDs', () => {
    const encoded = encodeTerminalScopedFilePath('local/main tab', '/tmp/demo.txt')
    const decoded = decodeTerminalScopedFilePath(encoded)
    assertCondition(!!decoded, 'decode should parse encoded scoped path')
    assertEqual(decoded?.terminalId || '', 'local/main tab', 'decoded terminal id should match source')
    assertEqual(decoded?.filePath || '', '/tmp/demo.txt', 'decoded file path should match source')
  })

  await runCase('file mention display name resolves scoped file path basename', () => {
    const scoped = encodeTerminalScopedFilePath('ssh-main', '/home/demo/readme.md')
    assertEqual(getFileMentionDisplayName(scoped), 'readme.md', 'scoped file path should render basename only')
  })

  await runCase('filesystem panel drag payload encode/decode round-trip', () => {
    const payload = {
      version: 1 as const,
      sourceTerminalId: 'ssh-1',
      sourceBasePath: '/home/demo',
      entries: [
        {
          name: 'a.txt',
          path: '/home/demo/a.txt',
          isDirectory: false,
          size: 4
        },
        {
          name: 'docs',
          path: '/home/demo/docs',
          isDirectory: true
        }
      ]
    }
    const encoded = encodeFileSystemPanelDragPayload(payload)
    const parsed = parseFileSystemPanelDragPayload({
      types: [FILESYSTEM_PANEL_DRAG_MIME],
      getData: (type: string) => (type === FILESYSTEM_PANEL_DRAG_MIME ? encoded : '')
    } as unknown as Pick<DataTransfer, 'types' | 'getData'>)

    assertCondition(!!parsed, 'payload should parse successfully')
    assertEqual(parsed?.sourceTerminalId || '', 'ssh-1', 'source terminal id should be preserved')
    assertEqual(parsed?.entries.length || 0, 2, 'entry count should be preserved')
    assertEqual(parsed?.entries[0].name || '', 'a.txt', 'first entry name should be preserved')
  })

  await runCase('invalid drag payload should fail closed', () => {
    const parsed = parseFileSystemPanelDragPayload({
      types: [FILESYSTEM_PANEL_DRAG_MIME],
      getData: () => '{"version":2}'
    } as unknown as Pick<DataTransfer, 'types' | 'getData'>)
    assertEqual(parsed, null, 'unsupported payload version should be rejected')
  })

  await runCase('filesystem payload admission is strict, presence-sensitive, and atomic', () => {
    const validEntry = {
      name: 'report.txt',
      path: '/srv/report.txt',
      isDirectory: false,
      size: 12
    }
    const validPayload = {
      version: 1,
      sourceTerminalId: '  source::A  ',
      sourceBasePath: '/srv',
      entries: [validEntry]
    }

    assertCondition(
      normalizeFileSystemPanelDragPayload(validPayload) !== null,
      'a valid payload should be admitted'
    )
    const nullPrototypePayload = Object.assign(Object.create(null), validPayload)
    assertCondition(
      normalizeFileSystemPanelDragPayload(nullPrototypePayload) !== null,
      'null-prototype JSON records should be admitted'
    )

    const invalidPayloads: unknown[] = [
      { ...validPayload, version: 2 },
      { ...validPayload, sourceTerminalId: 17 },
      { ...validPayload, sourceTerminalId: '   ' },
      { ...validPayload, sourceTerminalId: 'source\nA' },
      { ...validPayload, sourceTerminalId: '\ud800' },
      { ...validPayload, sourceTerminalId: 'x'.repeat(1025) },
      { ...validPayload, sourceBasePath: undefined },
      { ...validPayload, sourceBasePath: null },
      { ...validPayload, entries: undefined },
      { ...validPayload, entries: [] },
      { ...validPayload, entries: [validEntry, null] },
      {
        ...validPayload,
        entries: [{ ...validEntry, size: undefined }]
      },
      {
        ...validPayload,
        entries: [{ ...validEntry, size: -1 }]
      },
      {
        ...validPayload,
        entries: [{ ...validEntry, size: 1.5 }]
      },
      {
        ...validPayload,
        entries: [{ ...validEntry, isDirectory: 'false' }]
      },
      {
        ...validPayload,
        entries: [{ ...validEntry, name: '   ' }]
      },
      {
        ...validPayload,
        entries: [{ ...validEntry, path: '\ud800' }]
      }
    ]
    for (const invalid of invalidPayloads) {
      assertEqual(
        normalizeFileSystemPanelDragPayload(invalid),
        null,
        `malformed payload must be rejected: ${String(invalid)}`
      )
    }

    const unknownKeyPayload = { ...validPayload, unexpected: true } as Record<
      string,
      unknown
    >
    assertEqual(
      normalizeFileSystemPanelDragPayload(unknownKeyPayload),
      null,
      'unknown payload keys must not be silently stripped'
    )

    const symbolKeyPayload = { ...validPayload }
    Object.defineProperty(symbolKeyPayload, Symbol('unexpected'), {
      value: true,
      enumerable: true
    })
    assertEqual(
      normalizeFileSystemPanelDragPayload(symbolKeyPayload),
      null,
      'symbol payload keys must be rejected'
    )

    const prototypePayload = Object.create({ inherited: true })
    Object.assign(prototypePayload, validPayload)
    assertEqual(
      normalizeFileSystemPanelDragPayload(prototypePayload),
      null,
      'prototype-bearing payload records must be rejected'
    )

    const ownProtoPayload = { ...validPayload }
    Object.defineProperty(ownProtoPayload, '__proto__', {
      value: 'literal-key',
      enumerable: true,
      configurable: true
    })
    assertEqual(
      normalizeFileSystemPanelDragPayload(ownProtoPayload),
      null,
      'unknown __proto__ payload keys must be rejected without prototype mutation'
    )
  })

  await runCase('declared custom MIME is authoritative over native Files fallback', () => {
    let nativeFilesRead = false
    const malformedTransfer = {
      types: [FILESYSTEM_PANEL_DRAG_MIME, 'Files'],
      getData: () => '{"version":1,"sourceTerminalId":"source","entries":[]}',
      get files(): FileList {
        nativeFilesRead = true
        return [{ path: '/native/should-not-be-used' }] as unknown as FileList
      }
    }
    assert.deepEqual(
      resolveTerminalDropPaths(
        malformedTransfer as unknown as Pick<DataTransfer, 'types' | 'getData' | 'files'>
      ),
      [],
      'malformed custom payload must produce no terminal paths'
    )
    assert.deepEqual(
      resolveTerminalDropPathsForTarget(
        malformedTransfer as unknown as Pick<DataTransfer, 'types' | 'getData' | 'files'>,
        'source'
      ),
      [],
      'malformed custom payload must not be accepted by a target terminal'
    )
    assertEqual(nativeFilesRead, false, 'native Files must not be read after custom MIME admission')
  })

  await runCase('terminal scoped codec preserves exact identities and rejects non-canonical forms', () => {
    const terminalIds = ['  A  ', 'a', 'A::B', '__proto__', '终端🙂']
    for (const terminalId of terminalIds) {
      const encoded = encodeTerminalScopedFilePath(terminalId, ' /tmp/report )%/file.txt ')
      const decoded = decodeTerminalScopedFilePath(encoded)
      assertCondition(!!decoded, `encoded scope should decode: ${terminalId}`)
      assertEqual(decoded?.terminalId, terminalId, 'terminal identity must remain byte-for-byte exact')
      assertEqual(decoded?.filePath, ' /tmp/report )%/file.txt ', 'path bytes must remain exact')
    }

    for (const malformed of [
      '@terminal():/tmp/a',
      '@terminal(id):',
      '@terminal(id%2fpart):/tmp/a',
      '@terminal(%E0%A4%A):/tmp/a',
      '@terminal(%00):/tmp/a',
      `@terminal(id):/tmp/${String.fromCharCode(0xd800)}`
    ]) {
      assertEqual(decodeTerminalScopedFilePath(malformed), null, `malformed scope must be rejected: ${malformed}`)
    }

    for (const invalidId of ['   ', 'id\n', '\ud800', 'x'.repeat(1025), 42]) {
      let threw = false
      try {
        encodeTerminalScopedFilePath(invalidId as any, '/tmp/a')
      } catch {
        threw = true
      }
      assertEqual(threw, true, 'invalid non-empty terminal IDs must not be encoded')
    }
    assertEqual(encodeTerminalScopedFilePath('', '/legacy/path'), '/legacy/path', 'terminal-less legacy paths remain raw')
  })

  await runCase('exact terminal identity controls scoped drop admission', () => {
    const payload = {
      version: 1 as const,
      sourceTerminalId: '  Source  ',
      sourceBasePath: '/tmp',
      entries: [{ name: 'a.txt', path: '/tmp/a.txt', isDirectory: false }]
    }
    const encoded = encodeFileSystemPanelDragPayload(payload)
    const dataTransfer = {
      types: [FILESYSTEM_PANEL_DRAG_MIME],
      getData: () => encoded,
      files: [] as unknown as FileList
    }
    for (const lookalike of ['Source', '  source  ', 'source::']) {
      assert.deepEqual(
        resolveTerminalDropPathsForTarget(
          dataTransfer as unknown as Pick<DataTransfer, 'types' | 'getData' | 'files'>,
          lookalike
        ),
        [],
        `lookalike target must be rejected: ${lookalike}`
      )
    }
    assert.deepEqual(
      resolveTerminalDropPathsForTarget(
        dataTransfer as unknown as Pick<DataTransfer, 'types' | 'getData' | 'files'>,
        '  Source  '
      ),
      ['/tmp/a.txt'],
      'exact target identity must be accepted'
    )
  })

  await runCase('drag type detection works without reading payload body', () => {
    const customOnly = hasFileSystemPanelDragPayloadType({
      types: [FILESYSTEM_PANEL_DRAG_MIME]
    } as unknown as Pick<DataTransfer, 'types'>)
    assertEqual(customOnly, true, 'filesystem payload mime type should be detected via types only')

    const nativeOnly = hasNativeFileDragType({
      types: ['Files']
    } as unknown as Pick<DataTransfer, 'types'>)
    assertEqual(nativeOnly, true, 'native file drag should be detected via Files type')

    const none = hasNativeFileDragType({
      types: ['text/plain']
    } as unknown as Pick<DataTransfer, 'types'>)
    assertEqual(none, false, 'non-file drags should be ignored')
  })

  await runCase('resolveTerminalDropPaths prioritizes filesystem payload and does not need native files', () => {
    const payload = {
      version: 1 as const,
      sourceTerminalId: 'local-1',
      sourceBasePath: '/tmp',
      entries: [
        { name: 'alpha.txt', path: '/tmp/alpha.txt', isDirectory: false },
        { name: 'alpha.txt duplicate', path: '/tmp/alpha.txt', isDirectory: false }
      ]
    }
    const encoded = encodeFileSystemPanelDragPayload(payload)
    const dataTransfer = {
      types: [FILESYSTEM_PANEL_DRAG_MIME, 'Files'],
      getData: (type: string) => (type === FILESYSTEM_PANEL_DRAG_MIME ? encoded : ''),
      get files(): never {
        throw new Error('native files should not be read when payload is present')
      }
    }
    const paths = resolveTerminalDropPaths(
      dataTransfer as unknown as Pick<DataTransfer, 'types' | 'getData' | 'files'>
    )
    assertEqual(paths.length, 1, 'paths should be deduplicated')
    assertEqual(paths[0], '/tmp/alpha.txt', 'payload path should be used')
  })

  await runCase('resolveTerminalDropPaths falls back to native file paths when payload is absent', () => {
    const nativeFileList = [
      { path: '/tmp/beta.txt' },
      { path: ' /tmp/beta.txt ' },
      { path: '/tmp/gamma.txt' }
    ] as unknown as FileList
    const dataTransfer = {
      types: ['Files'],
      getData: () => '',
      files: nativeFileList
    }
    const paths = resolveTerminalDropPaths(
      dataTransfer as unknown as Pick<DataTransfer, 'types' | 'getData' | 'files'>
    )
    assertEqual(paths.length, 2, 'native paths should be deduplicated')
    assertEqual(paths[0], '/tmp/beta.txt', 'first native path should be preserved')
    assertEqual(paths[1], '/tmp/gamma.txt', 'second native path should be preserved')
  })

  await runCase('native file path resolver supersedes removed Electron File.path property', () => {
    const nativeFileList = [
      { name: 'no-legacy-path.txt' },
      { name: 'second.txt', path: '/tmp/legacy-ignored.txt' }
    ] as unknown as FileList
    const dataTransfer = {
      types: ['Files'],
      getData: () => '',
      files: nativeFileList
    }
    const paths = resolveTerminalDropPaths(
      dataTransfer as unknown as Pick<DataTransfer, 'types' | 'getData' | 'files'>,
      (file) => `/tmp/resolved/${file.name}`
    )
    assertEqual(paths.length, 2, 'resolver paths should be collected')
    assertEqual(paths[0], '/tmp/resolved/no-legacy-path.txt', 'resolver should cover files without legacy path')
    assertEqual(paths[1], '/tmp/resolved/second.txt', 'resolver should take precedence over legacy path')
  })

  await runCase('getNativeFilePathResolver bridges to the preload getPathForFile when available', () => {
    const globalRef = globalThis as { gyshell?: unknown }
    const original = globalRef.gyshell
    try {
      globalRef.gyshell = {
        system: { getPathForFile: (file: File) => `/tmp/bridged/${file.name}` }
      }
      const resolver = getNativeFilePathResolver()
      assertCondition(typeof resolver === 'function', 'resolver should be returned when bridge exists')
      assertEqual(
        resolver?.({ name: 'bridged.txt' } as unknown as File),
        '/tmp/bridged/bridged.txt',
        'resolver should delegate to preload getPathForFile'
      )

      globalRef.gyshell = { system: {} }
      assertEqual(getNativeFilePathResolver(), undefined, 'missing getPathForFile should yield undefined resolver')

      globalRef.gyshell = undefined
      assertEqual(getNativeFilePathResolver(), undefined, 'missing gyshell bridge should yield undefined resolver')
    } finally {
      globalRef.gyshell = original
    }
  })

  await runCase('native file path resolver falls back safely for older Electron and tests', () => {
    const file = { path: '/tmp/legacy.txt' } as unknown as File
    assertEqual(
      resolveNativeFilePath(file, () => ''),
      '/tmp/legacy.txt',
      'empty resolver result should fall back to legacy path'
    )
    assertEqual(
      resolveNativeFilePath(file, () => {
        throw new Error('resolver failed')
      }),
      '/tmp/legacy.txt',
      'throwing resolver should fall back to legacy path'
    )
  })

  await runCase('resolveTerminalDropPathsForTarget blocks cross-terminal payload drops', () => {
    const payload = {
      version: 1 as const,
      sourceTerminalId: 'ssh-main',
      sourceBasePath: '/home/demo',
      entries: [{ name: 'notes.md', path: '/home/demo/notes.md', isDirectory: false }]
    }
    const encoded = encodeFileSystemPanelDragPayload(payload)
    const dataTransfer = {
      types: [FILESYSTEM_PANEL_DRAG_MIME],
      getData: (type: string) => (type === FILESYSTEM_PANEL_DRAG_MIME ? encoded : ''),
      files: [] as unknown as FileList
    }
    const blocked = resolveTerminalDropPathsForTarget(
      dataTransfer as unknown as Pick<DataTransfer, 'types' | 'getData' | 'files'>,
      'local-main'
    )
    assertEqual(blocked.length, 0, 'cross-terminal payload should be rejected')

    const allowed = resolveTerminalDropPathsForTarget(
      dataTransfer as unknown as Pick<DataTransfer, 'types' | 'getData' | 'files'>,
      'ssh-main'
    )
    assertEqual(allowed.length, 1, 'matching terminal payload should be accepted')
    assertEqual(allowed[0], '/home/demo/notes.md', 'accepted payload path should match source')
  })

  await runCase('standalone path extractors stay consistent', () => {
    const payload = {
      version: 1 as const,
      sourceTerminalId: 'ssh-1',
      sourceBasePath: '/home/demo',
      entries: [{ name: 'report.md', path: '/home/demo/report.md', isDirectory: false }]
    }
    const encoded = encodeFileSystemPanelDragPayload(payload)
    const payloadPaths = extractFileSystemPayloadPaths({
      types: [FILESYSTEM_PANEL_DRAG_MIME],
      getData: (type: string) => (type === FILESYSTEM_PANEL_DRAG_MIME ? encoded : '')
    } as unknown as Pick<DataTransfer, 'types' | 'getData'>)
    assertEqual(payloadPaths.length, 1, 'payload extractor should return one path')
    assertEqual(payloadPaths[0], '/home/demo/report.md', 'payload extractor path should match')

    const nativePaths = extractNativeDropFilePaths({
      files: [{ path: '/tmp/native.txt' }] as unknown as FileList
    } as unknown as Pick<DataTransfer, 'files'>)
    assertEqual(nativePaths.length, 1, 'native extractor should return one path')
    assertEqual(nativePaths[0], '/tmp/native.txt', 'native extractor path should match')
  })
}

void run()
  .then(() => {
    console.log('All filesystemDragDrop extreme tests passed.')
  })
  .catch((error) => {
    console.error(error)
    throw error
  })
