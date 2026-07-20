import fs from 'node:fs'
import path from 'node:path'
import type { TerminalConfig } from '../../types'
import {
  isValidTerminalRuntimeId,
  normalizePersistedTerminalConfig,
} from './terminalConnectionSupport'

export interface PersistedTerminalRecord {
  id: string
  config: TerminalConfig
}

interface PersistedTerminalStatePayload {
  schemaVersion: 1
  updatedAt: number
  terminals: PersistedTerminalRecord[]
}

const CURRENT_SCHEMA_VERSION = 1 as const

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const normalizeRecord = (raw: unknown): PersistedTerminalRecord | null => {
  if (!isObject(raw)) return null
  const config = normalizePersistedTerminalConfig(raw.config)
  if (!config) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : config.id
  if (!isValidTerminalRuntimeId(id)) return null
  return {
    id,
    config: {
      ...config,
      id
    }
  }
}

const normalizePayload = (raw: unknown): PersistedTerminalStatePayload => {
  if (!isObject(raw)) {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      updatedAt: Date.now(),
      terminals: []
    }
  }

  const seen = new Set<string>()
  const terminals: PersistedTerminalRecord[] = []
  const input = Array.isArray(raw.terminals) ? raw.terminals : []
  input.forEach((item) => {
    const normalized = normalizeRecord(item)
    if (!normalized) return
    if (seen.has(normalized.id)) return
    seen.add(normalized.id)
    terminals.push(normalized)
  })

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    updatedAt: Date.now(),
    terminals
  }
}

export class TerminalStateStore {
  constructor(private readonly stateFilePath: string) {}

  load(): PersistedTerminalRecord[] {
    try {
      if (!fs.existsSync(this.stateFilePath)) return []
      const raw = fs.readFileSync(this.stateFilePath, 'utf8')
      const parsed = JSON.parse(raw)
      const payload = normalizePayload(parsed)
      return payload.terminals
    } catch (error) {
      console.warn('[TerminalStateStore] Failed to read terminal state file:', error)
      return []
    }
  }

  save(terminals: PersistedTerminalRecord[]): void {
    const payload = normalizePayload({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      updatedAt: Date.now(),
      terminals
    })

    const dirPath = path.dirname(this.stateFilePath)
    const tempFilePath = `${this.stateFilePath}.tmp-${process.pid}-${Date.now()}`

    try {
      fs.mkdirSync(dirPath, { recursive: true })
      fs.writeFileSync(tempFilePath, JSON.stringify(payload, null, 2), 'utf8')
      fs.renameSync(tempFilePath, this.stateFilePath)
    } catch (error) {
      console.warn('[TerminalStateStore] Failed to persist terminal state file:', error)
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.rmSync(tempFilePath, { force: true })
        }
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
