// Vite module forms the official Zone registry uses (apps/web is built by Vite
// through vinext, and Storybook runs the same transforms).

declare module '*.css?raw' {
  const css: string;
  export default css;
}

interface ImportMeta {
  /** Vite's lazy glob import: one loader per matching file. */
  glob<Module = unknown>(pattern: string | readonly string[],
    options?: { query?: string; import?: string }): Record<string, () => Promise<Module>>;
}
