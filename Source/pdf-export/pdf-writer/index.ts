// The PDF backend's public surface: the laid-out document type (the contract
// with the layout), the backend interface, our own writer, and the copy
// layer the layout also uses.
export { copyLayerText } from './copy-text';
export { MAX_OUTLINE_DEPTH, MAX_PAGES, OwnPdfWriter, type OwnPdfWriterOptions } from './own-writer';
export { MAX_OUTPUT_BYTES } from './pdf-file';
export { PdfWriteError } from './syntax';
