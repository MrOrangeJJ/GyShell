import { z } from 'zod'
import path from 'path'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import type { ToolExecutionContext, ReadFileSupport } from './types'

export const DEFAULT_READ_LIMIT = 2000
export const MAX_LINE_LENGTH = 2000
export const MAX_BYTES = 50 * 1024

export type ReadFileKind = 'text' | 'pdf' | 'image'

export const SUPPORTED_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
export const SUPPORTED_PDF_EXTS = ['.pdf']

// Schema definition moved here
export const readFileSchema = z.object({
  tabIdOrName: z.string().describe('The ID or Name of the terminal tab'),
  filePath: z
    .string()
    .describe(
      'File path to read. Supports absolute, relative (from CWD), and home-relative (starting with ~) paths.',
    ),
  offset: z.number().optional().describe('The line number to start reading from (0-based).'),
  limit: z.number().optional().describe('The number of lines to read (defaults to 2000).'),
})

export function detectFileKind(filePath: string, bytes: Uint8Array): ReadFileKind {
  if (isPdfFile(bytes) || SUPPORTED_PDF_EXTS.includes(path.extname(filePath).toLowerCase())) {
    return 'pdf'
  }
  if (isImageFile(bytes) || SUPPORTED_IMAGE_EXTS.includes(path.extname(filePath).toLowerCase())) {
    return 'image'
  }
  return 'text'
}

export function readTextFile(params: { filePath: string; bytes: Uint8Array; offset?: number; limit?: number }): string {
  const { filePath, bytes } = params
  if (isBinaryFile(filePath, bytes)) {
    throw new Error(`Cannot read binary file: ${filePath}`)
  }

  const limit = params.limit ?? DEFAULT_READ_LIMIT
  const offset = params.offset ?? 0
  const text = Buffer.from(bytes).toString('utf8')
  const lines = text.split('\n')

  const raw: string[] = []
  let bytesCount = 0
  let truncatedByBytes = false

  for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
    const line = lines[i].length > MAX_LINE_LENGTH ? lines[i].substring(0, MAX_LINE_LENGTH) + '...' : lines[i]
    const size = Buffer.byteLength(line, 'utf8') + (raw.length > 0 ? 1 : 0)
    if (bytesCount + size > MAX_BYTES) {
      truncatedByBytes = true
      break
    }
    raw.push(line)
    bytesCount += size
  }

  const content = raw.map((line, index) => `${(index + offset + 1).toString().padStart(5, '0')}| ${line}`)

  let output = '<file>\n'
  output += content.join('\n')

  const totalLines = lines.length
  const lastReadLine = offset + raw.length
  const hasMoreLines = totalLines > lastReadLine

  if (truncatedByBytes) {
    output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use 'offset' parameter to read beyond line ${lastReadLine})`
  } else if (hasMoreLines) {
    output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
  } else {
    output += `\n\n(End of file - total ${totalLines} lines)`
  }
  output += '\n</file>'

  return output
}

export async function readPdfFile(params: { bytes: Uint8Array; filePath: string }): Promise<string> {
  const { default: pdfParse } = await import('pdf-parse')
  const data = await pdfParse(Buffer.from(params.bytes))
  const text = data?.text?.trim()
  if (!text) {
    return `No extractable text found in PDF: ${params.filePath}`
  }
  return text
}

export function readImageFile(params: { bytes: Uint8Array; filePath: string }): { base64: string; mimeType: string } {
  const base64 = Buffer.from(params.bytes).toString('base64')
  const mimeType = detectImageMime(params.bytes, params.filePath)
  return { base64, mimeType }
}

function isPdfFile(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) === '%PDF-'
}

function isImageFile(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return true
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return true
  }
  const gif = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5])
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    return true
  }
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
  if (riff === 'RIFF' && webp === 'WEBP') {
    return true
  }
  return false
}

function detectImageMime(bytes: Uint8Array, filePath: string): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6) {
    const gif = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5])
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
    const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp'
  }
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  return 'application/octet-stream'
}

function isBinaryFile(filePath: string, bytes: Uint8Array): boolean {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.zip':
    case '.tar':
    case '.gz':
    case '.exe':
    case '.dll':
    case '.so':
    case '.class':
    case '.jar':
    case '.war':
    case '.7z':
    case '.doc':
    case '.docx':
    case '.xls':
    case '.xlsx':
    case '.ppt':
    case '.pptx':
    case '.odt':
    case '.ods':
    case '.odp':
    case '.bin':
    case '.dat':
    case '.obj':
    case '.o':
    case '.a':
    case '.lib':
    case '.wasm':
    case '.pyc':
    case '.pyo':
      return true
    case '.py': // .py is source code, not binary.
      return false
    default:
      break
  }

  if (bytes.length === 0) return false
  const bufferSize = Math.min(4096, bytes.length)
  let nonPrintableCount = 0
  for (let i = 0; i < bufferSize; i++) {
    const value = bytes[i]
    if (value === 0) return true
    if (value < 9 || (value > 13 && value < 32)) {
      nonPrintableCount++
    }
  }
  return nonPrintableCount / bufferSize > 0.3
}

export async function runReadFile(
  args: z.infer<typeof readFileSchema>,
  context: ToolExecutionContext,
  readFileSupport: ReadFileSupport
): Promise<{ 
  resultText: string; 
  imageMessage?: HumanMessage; 
  meaningLessAIMessage?: AIMessage;
}> {
  const { terminalService, sessionId, messageId, sendEvent, signal } = context
  const { found, bestMatch } = terminalService.resolveTerminal(args.tabIdOrName)
  
  let resultText = ''
  let imageMessage: HumanMessage | undefined
  let meaningLessAIMessage: AIMessage | undefined
  let level: 'info' | 'warning' | 'error' = 'info'

  const filePath = String(args.filePath || 'unknown file')

  try {
    if (!bestMatch) {
      resultText =
        found.length > 1
          ? `Error: Multiple terminal tabs found with name "${args.tabIdOrName}".`
          : `Error: Terminal tab "${args.tabIdOrName}" not found.`
      level = 'warning'
      return { resultText }
    }

    if (signal?.aborted) throw new Error('AbortError')

    const stat = await terminalService.statFile(bestMatch.id, filePath)
    
    if (signal?.aborted) throw new Error('AbortError')

    if (!stat.exists) {
      resultText = `File not found: ${filePath}`
      level = 'warning'
    } else if (stat.isDirectory) {
      resultText = `Path is a directory, not a file: ${filePath}`
      level = 'warning'
    } else {
      const bytes = await terminalService.readFile(bestMatch.id, filePath)
      if (signal?.aborted) throw new Error('AbortError')
      
      const kind = detectFileKind(filePath, bytes)

      if (kind === 'image') {
        if (!readFileSupport.image) {
          resultText = 'Current model does not support image input.'
          level = 'warning'
        } else {
          const image = readImageFile({ bytes, filePath })
          const dataUrl = `data:${image.mimeType};base64,${image.base64}`
          resultText = 'Image read successfully.'
          meaningLessAIMessage = new AIMessage('let me see')
          imageMessage = new HumanMessage({
            content: [
              { type: 'text', text: 'This is the image of the file that was read. Please Continue.' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          })
        }
      } else if (kind === 'pdf') {
        resultText = await readPdfFile({ bytes, filePath })
        if (signal?.aborted) throw new Error('AbortError')
      } else {
        resultText = readTextFile({
          filePath: filePath,
          bytes,
          offset: args.offset,
          limit: args.limit
        })
      }
    }

    return { resultText, imageMessage, meaningLessAIMessage }
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.message === 'AbortError')) {
      throw err
    }
    resultText = err instanceof Error ? err.message : String(err)
    level = 'warning'
    return { resultText }
  } finally {
    // Always emit an event so the frontend can display the sub tool banner,
    // including failure cases (as warning).
    sendEvent(sessionId, {
      messageId,
      type: 'file_read',
      level,
      filePath,
      input: JSON.stringify(args || {}),
      output: resultText
    })
  }
}
