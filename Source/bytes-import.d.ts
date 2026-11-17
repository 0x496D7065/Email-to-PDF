// Type of `import bytes from './X.woff?bytes'`: the file's exact bytes.
// Made by the `bytes-import` plugin in vite.config.ts (only for Source/pdf-export/fonts/).
declare module '*?bytes'
{
    const bytes: Uint8Array<ArrayBuffer>;
    export default bytes;
}
