import type { KernelClient } from '@rezics/client';
import { loadDocumentMedia, type DocumentImagePresentation } from '../../../threads/document-media';

/** DocumentMediaPageSchema: three 1024-character credit strings, an 80-character licence,
 * four obligations, twelve slots, two UUIDs, digest, nullable 44-character hash/color and
 * focal point. Six UTF-8 bytes per escaped string code unit; 2048 covers closed keys,
 * punctuation, identity and numeric tokens (including exponent notation). One selected image.
 */
export const ARTWORK_RESPONSE_BYTES = 3 * 1024 * 6 + 80 * 6 + 4 * 32 + 12 * 160 + 44 * 6 + 2048;
export type ArtworkResult =
  | { kind: 'ready'; image: DocumentImagePresentation }
  | { kind: 'unavailable'; reason?: 'oversized' | 'timeout' };
export type ArtworkTransport = (id: string) => Promise<ArtworkResult>;
export const canonicalMediaId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** Decorate the existing native client's transport, before JSON decoding. Never truncate. */
export function artworkResponseBudget() {
  let failure: 'oversized' | 'timeout' | undefined;
  return {
    reason: () => failure,
    decorate: (fetcher: typeof fetch): typeof fetch =>
      (async (input, init) => {
        try {
          const response = await fetcher(input, init);
          const overflow = () => {
            failure = 'oversized';
            throw new RangeError('Artwork presentation exceeds its UTF-8 envelope');
          };
          if (Number(response.headers.get('content-length')) > ARTWORK_RESPONSE_BYTES) {
            await response.body?.cancel();
            return overflow();
          }
          if (!response.body) return response;
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > ARTWORK_RESPONSE_BYTES) {
                await reader.cancel();
                return overflow();
              }
              chunks.push(chunk.value);
            }
          } finally {
            reader.releaseLock();
          }
          const body = new Uint8Array(bytes);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch (error) {
          if (error instanceof Error && error.name === 'TimeoutError') failure = 'timeout';
          throw error;
        }
      }) as typeof fetch,
  };
}

/** The native batch operation on this visit's one-image window; omission has no denial/empty meaning. */
export async function readSubjectArtwork(
  client: KernelClient,
  id: string,
  authorization?: string,
  failure: () => 'oversized' | 'timeout' | undefined = () => undefined,
): Promise<ArtworkResult> {
  if (!canonicalMediaId(id)) return { kind: 'unavailable' };
  const result = await loadDocumentMedia(client, [id], authorization);
  const image = result.kind === 'ready' ? result.images.get(id) : undefined;
  if (!image) {
    const reason = failure();
    return { kind: 'unavailable', ...(reason ? { reason } : {}) };
  }
  // Also bound injected/already-decoded transports and server-function serialization.
  if (new TextEncoder().encode(JSON.stringify({ images: [image] })).byteLength > ARTWORK_RESPONSE_BYTES)
    return { kind: 'unavailable', reason: 'oversized' };
  return { kind: 'ready', image };
}
