export const utf8ByteLength = (value: string): number =>
  Buffer.byteLength(value, 'utf8')

/**
 * Keep the longest scalar-aligned prefix that fits `maxUtf8Bytes` together
 * with `suffix`. Values that already fit are returned unchanged.
 */
export const truncateUtf8 = (
  value: string,
  maxUtf8Bytes: number,
  suffix: string,
): string => {
  if (utf8ByteLength(value) <= maxUtf8Bytes) return value
  const contentBudget = Math.max(0, maxUtf8Bytes - utf8ByteLength(suffix))
  let prefix = ''
  let retainedBytes = 0
  for (const scalar of value) {
    const scalarBytes = utf8ByteLength(scalar)
    if (retainedBytes + scalarBytes > contentBudget) break
    prefix += scalar
    retainedBytes += scalarBytes
  }
  return `${prefix}${suffix}`
}

/** Split into scalar-aligned chunks of at most `maxUtf8Bytes` each. */
export const splitUtf8Bounded = (
  value: string,
  maxUtf8Bytes: number,
): string[] => {
  if (!value) return []
  if (utf8ByteLength(value) <= maxUtf8Bytes) return [value]

  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const scalar of value) {
    const scalarBytes = utf8ByteLength(scalar)
    if (current && currentBytes + scalarBytes > maxUtf8Bytes) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += scalar
    currentBytes += scalarBytes
  }
  if (current) chunks.push(current)
  return chunks
}
