import { COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES } from './commandOutput'

/**
 * Reads an opaque identifier without rewriting it. Whitespace is inspected only
 * to reject blank input; legal leading and trailing whitespace remains part of
 * the returned identity.
 */
export const readOpaqueNonBlankString = (
  value: unknown,
): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined

export const hasOnlyPairedUtf16Surrogates = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (
        index + 1 >= value.length ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) {
        return false
      }
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}

/**
 * Reads an opaque identifier that can be encoded as Unicode without replacing
 * malformed UTF-16. The original string remains the canonical identity.
 */
export const readOpaqueNonBlankWellFormedString = (
  value: unknown,
): string | undefined => {
  const identifier = readOpaqueNonBlankString(value)
  return identifier !== undefined && hasOnlyPairedUtf16Surrogates(identifier)
    ? identifier
    : undefined
}

const OPAQUE_STRING_PAIR_PREFIX = 'gyshell-pair-v1:'

const encodeOpaqueStringComponent = (value: string): string | undefined => {
  if (!hasOnlyPairedUtf16Surrogates(value)) return undefined
  try {
    return encodeURIComponent(value)
  } catch {
    return undefined
  }
}

/**
 * Encodes two opaque strings into a canonical, delimiter-safe key. URI
 * encoding provides a strict UTF-8 conversion boundary, while explicit
 * lengths make the pair independently round-trippable.
 */
export const encodeOpaqueStringPair = (
  left: string,
  right: string,
): string | undefined => {
  const encodedLeft = encodeOpaqueStringComponent(left)
  const encodedRight = encodeOpaqueStringComponent(right)
  if (encodedLeft === undefined || encodedRight === undefined) return undefined
  return `${OPAQUE_STRING_PAIR_PREFIX}${encodedLeft.length}:${encodedLeft}:${encodedRight.length}:${encodedRight}`
}

const readEncodedOpaqueStringComponent = (
  value: string,
  offset: number,
): { decoded: string; nextOffset: number } | undefined => {
  const lengthDelimiter = value.indexOf(':', offset)
  if (lengthDelimiter < offset) return undefined
  const rawLength = value.slice(offset, lengthDelimiter)
  if (!/^(0|[1-9]\d*)$/.test(rawLength)) return undefined
  const encodedLength = Number(rawLength)
  if (!Number.isSafeInteger(encodedLength)) return undefined

  const encodedStart = lengthDelimiter + 1
  const encodedEnd = encodedStart + encodedLength
  if (encodedEnd > value.length || value[encodedEnd] !== ':') return undefined
  const encoded = value.slice(encodedStart, encodedEnd)
  try {
    const decoded = decodeURIComponent(encoded)
    if (
      !hasOnlyPairedUtf16Surrogates(decoded) ||
      encodeURIComponent(decoded) !== encoded
    ) {
      return undefined
    }
    return { decoded, nextOffset: encodedEnd + 1 }
  } catch {
    return undefined
  }
}

/** Decodes only canonical keys emitted by encodeOpaqueStringPair(). */
export const decodeOpaqueStringPair = (
  value: unknown,
): readonly [string, string] | undefined => {
  if (
    typeof value !== 'string' ||
    !value.startsWith(OPAQUE_STRING_PAIR_PREFIX)
  ) {
    return undefined
  }

  const left = readEncodedOpaqueStringComponent(
    value,
    OPAQUE_STRING_PAIR_PREFIX.length,
  )
  if (!left) return undefined

  const rightLengthDelimiter = value.indexOf(':', left.nextOffset)
  if (rightLengthDelimiter < left.nextOffset) return undefined
  const rawRightLength = value.slice(left.nextOffset, rightLengthDelimiter)
  if (!/^(0|[1-9]\d*)$/.test(rawRightLength)) return undefined
  const encodedRightLength = Number(rawRightLength)
  if (!Number.isSafeInteger(encodedRightLength)) return undefined

  const encodedRightStart = rightLengthDelimiter + 1
  const encodedRightEnd = encodedRightStart + encodedRightLength
  if (encodedRightEnd !== value.length) return undefined
  const encodedRight = value.slice(encodedRightStart, encodedRightEnd)
  try {
    const decodedRight = decodeURIComponent(encodedRight)
    if (
      !hasOnlyPairedUtf16Surrogates(decodedRight) ||
      encodeURIComponent(decodedRight) !== encodedRight
    ) {
      return undefined
    }
    return [left.decoded, decodedRight]
  } catch {
    return undefined
  }
}

/**
 * Performs shape validation for an opaque terminal runtime identity. Exact
 * registry membership remains the responsibility of the terminal backend.
 */
export const isValidTerminalRuntimeId = (value: unknown): value is string => {
  const terminalId = readOpaqueNonBlankString(value)
  return (
    terminalId !== undefined &&
    !/\p{Cc}/u.test(terminalId) &&
    hasOnlyPairedUtf16Surrogates(terminalId) &&
    new TextEncoder().encode(terminalId).byteLength <=
      COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES
  )
}
