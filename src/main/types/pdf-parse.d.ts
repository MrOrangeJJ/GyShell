declare module 'pdf-parse' {
  type PdfParseResult = {
    text: string
  }

  const pdfParse: (data: Buffer | Uint8Array) => Promise<PdfParseResult>
  export default pdfParse
}
