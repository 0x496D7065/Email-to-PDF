// The layout's public surface: layoutPdf (document model -> laid-out
// document, for PdfBackend.render) and its look (LayoutConfig).
export { DEFAULT_LAYOUT_CONFIG } from './layout-config';
export { INDEX_DESTINATION } from './email-index-table';
// bodyIndentWidth is exported so tests can check the body indent width.
export { bodyIndentWidth, COVER_DESTINATION, layoutPdf, type LayoutOptions, type LayoutStrings, MAX_FRONT_PASSES, type PdfLayout, settlePageCount } from './pdf-layout';
