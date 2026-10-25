import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { ConfigError } from '../commerce/config.ts';
import type { MediaImportFetchConfig } from './media-import.ts';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_HEADERS = 16 * 1024;
const FETCH_MS = 15_000;
const VARIABLE = 'KERNEL_MEDIA_IMPORT_ALLOWED_HOSTS';

export class SourceImageRejection extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SourceImageRejection';
  }
}

class SourceImageTransientError extends Error {}

function domain(host: string): boolean {
  return (
    host.length <= 253 &&
    host === host.toLowerCase() &&
    !isIP(host) &&
    host.split('.').length >= 2 &&
    host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

/** Called by the content module during registration with context.env. No process-env fallback. */
export function readMediaImportFetchConfig(env: Readonly<Record<string, string | undefined>>): MediaImportFetchConfig {
  const value = env[VARIABLE];
  const allowedHosts = value?.split(',');
  if (!allowedHosts?.length || allowedHosts.length > 100 || !allowedHosts.every(domain))
    throw new ConfigError(VARIABLE);
  return Object.freeze({ allowedHosts: Object.freeze([...new Set(allowedHosts)]) });
}

function sourceUrl(input: string, config: MediaImportFetchConfig): URL {
  let url: URL;
  try {
    if (input.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(input)) throw new Error();
    url = new URL(input);
  } catch {
    throw new SourceImageRejection('source-url');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !domain(url.hostname) ||
    !config.allowedHosts.includes(url.hostname)
  )
    throw new SourceImageRejection('source-url');
  return url;
}

/** The only remote boundary. All URLs, including redirects, pass the same policy.
 * One deadline spans headers, redirects and body; response metadata never measures bytes.
 */
export async function fetchSourceImage(
  input: string,
  config: MediaImportFetchConfig,
): Promise<Readonly<{ bytes: Uint8Array; sha256: string }>> {
  // Invalid trusted configuration must never silently become allow-all.
  if (!config.allowedHosts.length || config.allowedHosts.length > 100 || !config.allowedHosts.every(domain))
    throw new ConfigError(VARIABLE);
  let url = sourceUrl(input, config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_MS);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => {
    void reader?.cancel().catch(() => {});
  };
  controller.signal.addEventListener('abort', abort, { once: true });
  try {
    for (let hop = 0; hop <= 3; hop++) {
      controller.signal.throwIfAborted();
      try {
        response = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
          signal: controller.signal,
        });
      } catch {
        throw new SourceImageRejection(controller.signal.aborted ? 'source-timeout' : 'source-network');
      }
      controller.signal.throwIfAborted();
      let headerBytes = 0;
      let headerCount = 0;
      for (const [name, value] of response.headers) {
        headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
        if (++headerCount > 100 || headerBytes > MAX_HEADERS) throw new SourceImageRejection('source-headers');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || hop === 3) throw new SourceImageRejection('source-redirect');
        // Bound and validate the raw Location as well as the resolved destination.
        if (location.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(location))
          throw new SourceImageRejection('source-url');
        let destination: string;
        try {
          destination = new URL(location, url).href;
        } catch {
          throw new SourceImageRejection('source-url');
        }
        url = sourceUrl(destination, config);
        await response.body?.cancel();
        response = undefined;
        continue;
      }
      if (response.status === 429 || response.status >= 500)
        throw new SourceImageTransientError('Source temporarily unavailable');
      if (response.status !== 200 || !response.body) throw new SourceImageRejection('source-network');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > MAX_BYTES))
        throw new SourceImageRejection('source-bytes');
      // Fixed allocation prevents tiny chunks from creating an unbounded chunk list.
      const buffer = new Uint8Array(MAX_BYTES);
      const hash = createHash('sha256');
      let length = 0;
      reader = response.body.getReader();
      while (true) {
        controller.signal.throwIfAborted();
        const chunk = await reader.read();
        controller.signal.throwIfAborted();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array) || length + chunk.value.byteLength > MAX_BYTES)
          throw new SourceImageRejection('source-bytes');
        buffer.set(chunk.value, length);
        hash.update(chunk.value);
        length += chunk.value.byteLength;
      }
      if (length === 0) throw new SourceImageRejection('source-bytes');
      return { bytes: buffer.slice(0, length), sha256: hash.digest('hex') };
    }
    throw new SourceImageRejection('source-redirect');
  } catch (error) {
    if (controller.signal.aborted) throw new SourceImageRejection('source-timeout');
    if (error instanceof SourceImageRejection || error instanceof SourceImageTransientError) throw error;
    throw new SourceImageRejection('source-network');
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', abort);
    controller.abort();
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    } else await response?.body?.cancel().catch(() => {});
  }
}
