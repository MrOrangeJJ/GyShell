import type { TerminalTab } from '../../../types'
import type { TerminalRuntimeSnapshot } from '../../TerminalService'
import type { ToolExecutionContext } from '../types'
import {
  editFile,
  editFileSchema,
  writeAndEdit,
  writeAndEditSchema,
  writeFile
} from './edit_tools'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertIncludes = (value: string, expected: string, message: string): void => {
  if (!value.includes(expected)) {
    throw new Error(`${message}. expected substring=${expected} actual=${value}`)
  }
}

class FakeTerminalService {
  readonly terminal: TerminalTab = {
    id: 'local-main',
    ptyId: 'pty-local-main',
    title: 'local-main',
    cols: 80,
    rows: 24,
    type: 'local',
    capabilities: { supportsFilesystem: true, supportsMonitor: true },
    runtimeState: 'ready'
  }

  readonly files = new Map<string, string>()

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [filePath, content] of Object.entries(initialFiles)) {
      this.files.set(filePath, content)
    }
  }

  getTerminalById(terminalId: string): TerminalTab | undefined {
    return terminalId === this.terminal.id ? this.terminal : undefined
  }

  getDisplayTerminals(): TerminalTab[] {
    return [this.terminal]
  }

  getTerminalRuntimeSnapshot(): TerminalRuntimeSnapshot {
    return {
      id: this.terminal.id,
      title: this.terminal.title,
      type: this.terminal.type,
      runtimeState: 'ready',
      isInitializing: false,
      reconnectable: false,
      canRunCommand: true,
      canWrite: true,
      canUseFilesystem: true
    }
  }

  async statFile(_terminalId: string, filePath: string) {
    return {
      exists: this.files.has(filePath),
      isDirectory: false
    }
  }

  async readFile(_terminalId: string, filePath: string): Promise<Buffer> {
    return Buffer.from(this.files.get(filePath) ?? '', 'utf8')
  }

  async writeFile(_terminalId: string, filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content)
  }
}

function createContext(terminalService: FakeTerminalService, events: any[]): ToolExecutionContext {
  return {
    sessionId: 'session-edit-tools',
    messageId: 'message-edit-tools',
    terminalService: terminalService as any,
    sendEvent: (sessionId, event) => events.push({ sessionId, event }),
    commandPolicyService: {} as any,
    commandPolicyMode: 'standard'
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

async function run(): Promise<void> {
  await runCase('writeAndEditSchema tolerates empty legacy edit fields for write mode', () => {
    const result = writeAndEditSchema.safeParse({
      terminalId: 'local-main',
      filePath: '/tmp/write.txt',
      content: 'alpha\n',
      oldString: '',
      newString: '',
      replaceAll: false
    })
    assertEqual(result.success, true, 'legacy write payload with empty edit fields should parse')
  })

  await runCase('writeAndEditSchema rejects non-empty mixed write and edit fields', () => {
    const result = writeAndEditSchema.safeParse({
      terminalId: 'local-main',
      filePath: '/tmp/write.txt',
      content: 'alpha\n',
      oldString: 'old',
      newString: 'new'
    })
    assertEqual(result.success, false, 'non-empty mixed write and edit fields should be rejected')
  })

  await runCase('editFileSchema rejects empty oldString for model-visible edit_file', () => {
    const result = editFileSchema.safeParse({
      terminalId: 'local-main',
      filePath: '/tmp/edit.txt',
      oldString: '',
      newString: 'full replacement\n'
    })
    assertEqual(result.success, false, 'model-visible edit_file should require a non-empty oldString')
  })

  await runCase('write_file creates a file and emits file_edit with split tool name', async () => {
    const service = new FakeTerminalService()
    const events: any[] = []
    const output = await writeFile(
      { terminalId: 'local-main', filePath: '/tmp/write.txt', content: 'alpha\nbeta\n' },
      createContext(service, events)
    )
    assertIncludes(output, 'Created file: /tmp/write.txt', 'write_file should report creation')
    assertEqual(service.files.get('/tmp/write.txt'), 'alpha\nbeta\n', 'write_file should write full content')
    assertEqual(events[0]?.event.type, 'file_edit', 'write_file should emit file_edit')
    assertEqual(events[0]?.event.toolName, 'write_file', 'write_file event should keep concrete tool name')
    assertEqual(events[0]?.event.action, 'created', 'write_file event should mark created')
  })

  await runCase('edit_file edits one occurrence and emits file_edit with split tool name', async () => {
    const service = new FakeTerminalService({ '/tmp/edit.txt': 'alpha\nbeta\ngamma\n' })
    const events: any[] = []
    const output = await editFile(
      {
        terminalId: 'local-main',
        filePath: '/tmp/edit.txt',
        oldString: 'beta',
        newString: 'BETA'
      },
      createContext(service, events)
    )
    assertIncludes(output, 'Edited file: /tmp/edit.txt', 'edit_file should report edit')
    assertEqual(service.files.get('/tmp/edit.txt'), 'alpha\nBETA\ngamma\n', 'edit_file should edit one occurrence')
    assertEqual(events[0]?.event.toolName, 'edit_file', 'edit_file event should keep concrete tool name')
    assertEqual(events[0]?.event.action, 'edited', 'edit_file event should mark edited')
  })

  await runCase('edit_file replaceAll edits every occurrence', async () => {
    const service = new FakeTerminalService({ '/tmp/edit-all.txt': 'foo one foo two foo\n' })
    const events: any[] = []
    await editFile(
      {
        terminalId: 'local-main',
        filePath: '/tmp/edit-all.txt',
        oldString: 'foo',
        newString: 'bar',
        replaceAll: true
      },
      createContext(service, events)
    )
    assertEqual(service.files.get('/tmp/edit-all.txt'), 'bar one bar two bar\n', 'replaceAll should edit every occurrence')
    assertEqual(events[0]?.event.action, 'edited', 'replaceAll should emit edited action')
  })

  await runCase('edit_file rejects empty oldString before events or file I/O', async () => {
    const service = new FakeTerminalService()
    const events: any[] = []
    const output = await editFile(
      {
        terminalId: 'local-main',
        filePath: '/tmp/should-not-create.txt',
        oldString: '',
        newString: 'full replacement\n'
      },
      createContext(service, events)
    )
    assertIncludes(output, 'oldString must not be empty', 'edit_file should reject empty oldString')
    assertEqual(service.files.has('/tmp/should-not-create.txt'), false, 'edit_file should not create files')
    assertEqual(events.length, 0, 'strict direct-entry validation should reject before publishing execution events')
  })

  await runCase('legacy create_or_edit writes when edit fields are empty', async () => {
    const service = new FakeTerminalService()
    const events: any[] = []
    await writeAndEdit(
      {
        terminalId: 'local-main',
        filePath: '/tmp/legacy-write.txt',
        content: 'legacy\n',
        oldString: '',
        newString: '',
        replaceAll: false
      },
      createContext(service, events)
    )
    assertEqual(service.files.get('/tmp/legacy-write.txt'), 'legacy\n', 'legacy write payload should write content')
    assertEqual(events[0]?.event.toolName, 'create_or_edit', 'legacy event should keep legacy tool name')
  })

  await runCase('legacy create_or_edit preserves empty oldString full-write payload', async () => {
    const service = new FakeTerminalService()
    const events: any[] = []
    await writeAndEdit(
      {
        terminalId: 'local-main',
        filePath: '/tmp/legacy-empty-old-write.txt',
        oldString: '',
        newString: 'legacy full write\n'
      },
      createContext(service, events)
    )
    assertEqual(
      service.files.get('/tmp/legacy-empty-old-write.txt'),
      'legacy full write\n',
      'legacy empty-oldString payload should still write newString as full content'
    )
    assertEqual(events[0]?.event.toolName, 'create_or_edit', 'legacy empty-oldString event should keep legacy tool name')
    assertEqual(events[0]?.event.action, 'created', 'legacy empty-oldString payload should create missing files')
  })

  await runCase('legacy create_or_edit edits when empty content is paired with edit fields', async () => {
    const service = new FakeTerminalService({ '/tmp/legacy-edit.txt': 'alpha\nbeta\n' })
    const events: any[] = []
    await writeAndEdit(
      {
        terminalId: 'local-main',
        filePath: '/tmp/legacy-edit.txt',
        content: '',
        oldString: 'beta',
        newString: 'BETA'
      },
      createContext(service, events)
    )
    assertEqual(service.files.get('/tmp/legacy-edit.txt'), 'alpha\nBETA\n', 'legacy edit payload should ignore empty content')
    assertEqual(events[0]?.event.toolName, 'create_or_edit', 'legacy edit event should keep legacy tool name')
  })
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
