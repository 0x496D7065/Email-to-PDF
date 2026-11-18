// The PDF backend's public surface: the laid-out document type (the contract
// with the layout), the backend interface, our own writer, and the copy
// layer the layout also uses.
export { copyLayerText } from './copy-layer-text';
export { MAX_OUTLINE_DEPTH, MAX_PAGES, OwnPdfWriter, type OwnPdfWriterOptions } from './write-pdf';
export { MAX_OUTPUT_BYTES } from './pdf-file-builder';
export { PdfWriteError } from './pdf-syntax';
