/** Fixture assets use real URLs, since document images intentionally reject data URLs. */
declare module '*.svg?url&no-inline' {
  const url: string;
  export default url;
}
