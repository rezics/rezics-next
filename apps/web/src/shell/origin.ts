let cachedValue: string | undefined;
let cachedOrigin: string | undefined;

function loopbackHttpOrigin(url: URL): boolean {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
}

function configuredOrigin(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  )
    throw new Error();
  return url.origin;
}

export function validatePublicOrigin(value: string | undefined, fallbackRequestUrl?: string): string {
  const candidate = value?.trim();
  if (candidate === cachedValue && cachedOrigin) return cachedOrigin;
  try {
    if (!candidate) throw new Error();
    const origin = configuredOrigin(candidate);
    cachedValue = candidate;
    return (cachedOrigin = origin);
  } catch {
    if (fallbackRequestUrl) {
      try {
        const fallback = new URL(fallbackRequestUrl);
        if (loopbackHttpOrigin(fallback)) return fallback.origin;
      } catch {
        /* The request URL was not an origin. */
      }
    }
    throw new Error('Configuration error: PUBLIC_ORIGIN must be an absolute HTTP origin without a path');
  }
}
