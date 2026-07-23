export interface TerminalInitialReplaySegment {
  data: string
  offset?: number
}

export interface TerminalInitialReplay {
  data: string
  offset: number
  hasGap: boolean
  gapStart?: number
  gapEnd?: number
}

export function hasTerminalLiveOffsetGap(
  lastAcceptedOffset: number,
  segment: TerminalInitialReplaySegment
): boolean {
  if (!Number.isFinite(segment.offset)) return false
  const end = Math.max(0, Math.floor(segment.offset as number))
  const start = Math.max(0, end - segment.data.length)
  return start > Math.max(0, Math.floor(lastAcceptedOffset))
}

/**
 * Merges an atomic backend buffer snapshot with live events captured while
 * that snapshot was in flight. Offset intervals are unioned so a full live
 * event can restore the head that a bounded ring-buffer snapshot trimmed.
 */
export function mergeTerminalInitialReplay(
  segments: TerminalInitialReplaySegment[]
): TerminalInitialReplay {
  const ordered = segments
    .filter(
      (segment) =>
        Boolean(segment.data) || Number.isFinite(segment.offset)
    )
    .map((segment, order) => {
      const end = Number.isFinite(segment.offset)
        ? Math.max(0, Math.floor(segment.offset as number))
        : undefined
      return {
        ...segment,
        order,
        end,
        start:
          end === undefined
            ? undefined
            : Math.max(0, end - segment.data.length)
      }
    })
    .sort((left, right) => {
      if (left.start === undefined) return 1
      if (right.start === undefined) return -1
      return left.start - right.start || left.order - right.order
    })

  let data = ''
  let offset = 0
  let coveredEnd: number | undefined
  let gapStart: number | undefined
  let gapEnd: number | undefined
  for (const segment of ordered) {
    if (segment.start === undefined || segment.end === undefined) {
      data += segment.data
      continue
    }
    if (coveredEnd === undefined) {
      data += segment.data
      coveredEnd = segment.end
      offset = Math.max(offset, segment.end)
      continue
    }
    if (segment.start > coveredEnd) {
      if (gapStart === undefined) {
        gapStart = coveredEnd
        gapEnd = segment.start
      }
      data += segment.data
      coveredEnd = segment.end
      offset = Math.max(offset, segment.end)
      continue
    }
    if (segment.start === coveredEnd) {
      data += segment.data
      coveredEnd = segment.end
      offset = Math.max(offset, segment.end)
      continue
    }
    if (segment.end > coveredEnd) {
      data += segment.data.slice(coveredEnd - segment.start)
      coveredEnd = segment.end
      offset = Math.max(offset, segment.end)
    }
  }

  for (const segment of segments) {
    if (Number.isFinite(segment.offset)) {
      offset = Math.max(offset, Math.floor(segment.offset as number))
    }
  }
  return {
    data,
    offset,
    hasGap: gapStart !== undefined,
    gapStart,
    gapEnd
  }
}
