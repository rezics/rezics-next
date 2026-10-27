let cachedValue: string | undefined;
let cachedOrigin: string | undefined;

export function validatePublicOrigin(value: string | undefined): string {
  if (value === cachedValue && cachedOrigin) return cachedOrigin;
  try {
    if (!value) throw new Error();
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      value !== url.origin
    )
      throw new Error();
    cachedValue = value;
    return (cachedOrigin = url.origin);
  } catch {
    throw new Error('Configuration error: PUBLIC_ORIGIN must be an absolute HTTP origin without a path');
  }
}
