declare module '*.css';

/** A Vite asset import: its public URL, hashed like the files CSS references. */
declare module '*?url' {
  const url: string;
  export default url;
}
