// The layout's public surface: layoutPdf (document model -> laid-out
// document, for PdfBackend.render) and its look (LayoutConfig).
export { DEFAULT_LAYOUT_CONFIG, type LayoutConfig, type TextStyle } from './config';
export { layoutPdf, type LayoutOptions, type LayoutStrings, type PdfLayout } from './pdf-layout';
