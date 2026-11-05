/** The object operations used by the existing upload and download writers. R2 implements this port directly. */
export type MediaStorage = {
  head(key: string): Promise<{ size: number } | null>;
  get(
    key: string,
    options: { range?: { offset: number; length: number } },
  ): Promise<{ size: number; body: ReadableStream; range?: R2Range } | null>;
  put(
    key: string,
    body: ReadableStream,
    options: { httpMetadata: { contentType: string }; sha256?: string },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
};

export type LocalMediaBindings = { LOCAL_MEDIA_ORIGIN: string; LOCAL_MEDIA_TOKEN: string };

/** Explicit development binding, issued only by dev-stack setup. No browser receives the transport credential. */
export function localMediaStorage(bindings: LocalMediaBindings): MediaStorage {
  const request = async (key: string, method: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set('x-local-media-key', bindings.LOCAL_MEDIA_TOKEN);
    const response = await fetch(`${bindings.LOCAL_MEDIA_ORIGIN}/_local/media/${key}`, {
      ...options,
      method,
      headers,
      redirect: 'error',
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Local media ${method} failed (${response.status})`);
    return response;
  };
  const size = (response: Response) => {
    const value = response.headers.get('content-length');
    if (value === null || !/^\d+$/.test(value) || Number(value) > 20 * 1024 * 1024)
      throw new Error('Invalid local media object length');
    return Number(value);
  };
  return {
    async head(key) {
      const response = await request(key, 'HEAD');
      return response === null ? null : { size: size(response) };
    },
    async get(key, options) {
      const range = options.range;
      const response = await request(key, 'GET', {
        headers: range ? { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {},
      });
      if (response === null) return null;
      const length = size(response);
      return { size: length, body: response.body!, ...(range ? { range: { length } } : {}) };
    },
    async put(key, body, options) {
      const response = await request(key, 'PUT', {
        body,
        headers: { 'content-type': options.httpMetadata.contentType },
      });
      if (response === null) throw new Error('Local media upload endpoint is unavailable');
      await response.body?.cancel();
      return {};
    },
    async delete(key) {
      const response = await request(key, 'DELETE');
      await response?.body?.cancel();
    },
  };
}
