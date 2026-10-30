const origin = process.env.NATIVE_MEDIA_STORAGE_ORIGIN;
const token = process.env.NATIVE_MEDIA_STORAGE_TOKEN;
if (!origin || !token) throw new Error('Native media storage bridge configuration is missing');

const workerFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const sourceUrl = input instanceof Request ? input.url : String(input);
  const source = new URL(sourceUrl);
  if (!source.hostname.endsWith('.r2.cloudflarestorage.com')) return workerFetch(input, init);
  const request = input instanceof Request ? input : new Request(input, init);
  const target = new URL(`/_native/media-storage${source.pathname}${source.search}`, origin);
  const forwarded = new Request(target, request);
  forwarded.headers.set('x-native-media-storage-key', token);
  return workerFetch(forwarded);
}) as typeof fetch;
