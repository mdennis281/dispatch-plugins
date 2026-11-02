// Vite's `?raw` imports: the file's text, inlined into the bundle at build time.
declare module "*?raw" {
  const text: string;
  export default text;
}
