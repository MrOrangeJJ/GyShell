function cloneSerializable<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

export function captureRawResponseChunk(chunk: any, rawChunks: any[]): any | undefined {
  const rawResponse = chunk?.additional_kwargs?.__raw_response
  if (typeof rawResponse === 'undefined') {
    return undefined
  }
  rawChunks.push(cloneSerializable(rawResponse))
  if (chunk?.additional_kwargs) {
    delete chunk.additional_kwargs.__raw_response
  }
  return rawResponse
}

export function buildDebugRawResponse(rawChunks: any[]): any | undefined {
  if (!Array.isArray(rawChunks) || rawChunks.length === 0) {
    return undefined
  }
  return {
    stream_chunks: rawChunks.map((chunk) => cloneSerializable(chunk))
  }
}
