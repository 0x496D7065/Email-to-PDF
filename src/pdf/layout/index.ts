// The layout's public surface: layoutPdf (document model -> laid-out
// document, for PdfBackend.render) and its look (LayoutConfig).
export { DEFAULT_LAYOUT_CONFIG, type LayoutConfig, quoteIndent, type TextStyle } from './config';
export { INDEX_DESTINATION } from './index-table';
export { COVER_DESTINATION, layoutPdf, type LayoutOptions, type LayoutStrings, MAX_FRONT_PASSES, type PdfLayout, settlePageCount } from './pdf-layout';
