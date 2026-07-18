export type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type ModelRequestParameters = Record<string, JsonValue>

export const MODEL_REQUEST_PARAMETERS_MAX_FIELDS = 64
export const MODEL_REQUEST_PARAMETER_MAX_KEY_LENGTH = 128
export const MODEL_REQUEST_PARAMETER_MAX_DEPTH = 8
export const MODEL_REQUEST_PARAMETERS_MAX_SERIALIZED_LENGTH = 64 * 1024

export const MODEL_REQUEST_PROTECTED_KEYS = [
  'model',
  'messages',
  'input',
  'stream',
  'stream_options',
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'response_format',
  'text',
  'n',
] as const

const protectedKeys = new Set<string>(MODEL_REQUEST_PROTECTED_KEYS)
const unsafeObjectKeys = new Set(['__proto__', 'constructor', 'prototype'])

export type ModelRequestParameterIssueCode =
  | 'not_object'
  | 'too_many_fields'
  | 'empty_key'
  | 'key_too_long'
  | 'protected_key'
  | 'unsafe_key'
  | 'invalid_value'
  | 'too_deep'
  | 'too_large'
  | 'duplicate_key'

export interface ModelRequestParameterIssue {
  code: ModelRequestParameterIssueCode
  path: string
  key?: string
}

export interface ModelRequestParameterValidationResult {
  valid: boolean
  value: ModelRequestParameters
  issues: ModelRequestParameterIssue[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cloneJsonValue(
  value: unknown,
  depth: number,
  path: string,
  issues: ModelRequestParameterIssue[],
): JsonValue | undefined {
  if (depth > MODEL_REQUEST_PARAMETER_MAX_DEPTH) {
    issues.push({ code: 'too_deep', path })
    return undefined
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    issues.push({ code: 'invalid_value', path })
    return undefined
  }
  if (Array.isArray(value)) {
    const cloned: JsonValue[] = []
    for (let index = 0; index < value.length; index += 1) {
      const next = cloneJsonValue(value[index], depth + 1, `${path}[${index}]`, issues)
      if (next === undefined) return undefined
      cloned.push(next)
    }
    return cloned
  }
  if (!isPlainObject(value)) {
    issues.push({ code: 'invalid_value', path })
    return undefined
  }

  const cloned: Record<string, JsonValue> = {}
  for (const [key, child] of Object.entries(value)) {
    if (unsafeObjectKeys.has(key)) {
      issues.push({ code: 'unsafe_key', path: `${path}.${key}`, key })
      return undefined
    }
    const next = cloneJsonValue(child, depth + 1, `${path}.${key}`, issues)
    if (next === undefined) return undefined
    cloned[key] = next
  }
  return cloned
}

export function isProtectedModelRequestParameter(key: string): boolean {
  return protectedKeys.has(key.trim())
}

export function validateModelRequestParameters(
  input: unknown,
): ModelRequestParameterValidationResult {
  const issues: ModelRequestParameterIssue[] = []
  const value: ModelRequestParameters = {}

  if (input === undefined || input === null) {
    return { valid: true, value, issues }
  }
  if (!isPlainObject(input)) {
    return {
      valid: false,
      value,
      issues: [{ code: 'not_object', path: '$' }],
    }
  }

  const entries = Object.entries(input)
  if (entries.length > MODEL_REQUEST_PARAMETERS_MAX_FIELDS) {
    issues.push({ code: 'too_many_fields', path: '$' })
  }

  for (const [rawKey, rawValue] of entries.slice(0, MODEL_REQUEST_PARAMETERS_MAX_FIELDS)) {
    const key = rawKey.trim()
    if (!key) {
      issues.push({ code: 'empty_key', path: '$', key: rawKey })
      continue
    }
    if (key.length > MODEL_REQUEST_PARAMETER_MAX_KEY_LENGTH) {
      issues.push({ code: 'key_too_long', path: `$.${key}`, key })
      continue
    }
    if (unsafeObjectKeys.has(key)) {
      issues.push({ code: 'unsafe_key', path: `$.${key}`, key })
      continue
    }
    if (isProtectedModelRequestParameter(key)) {
      issues.push({ code: 'protected_key', path: `$.${key}`, key })
      continue
    }
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      issues.push({ code: 'duplicate_key', path: `$.${key}`, key })
      continue
    }

    const next = cloneJsonValue(rawValue, 1, `$.${key}`, issues)
    if (next !== undefined) value[key] = next
  }

  const serializedLengthOf = (candidate: ModelRequestParameters): number =>
    new TextEncoder().encode(JSON.stringify(candidate)).byteLength
  let serializedLength = serializedLengthOf(value)
  if (serializedLength > MODEL_REQUEST_PARAMETERS_MAX_SERIALIZED_LENGTH) {
    issues.push({ code: 'too_large', path: '$' })
    const keys = Object.keys(value)
    while (
      keys.length > 0 &&
      serializedLength > MODEL_REQUEST_PARAMETERS_MAX_SERIALIZED_LENGTH
    ) {
      const key = keys.pop()
      if (key !== undefined) delete value[key]
      serializedLength = serializedLengthOf(value)
    }
  }

  return { valid: issues.length === 0, value, issues }
}

export function normalizeModelRequestParameters(input: unknown): ModelRequestParameters {
  return validateModelRequestParameters(input).value
}
