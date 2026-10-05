import { createHash } from 'node:crypto';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { RENDITION_LIMITS } from './policy.ts';
import type { MediaRenditionStore } from './store.ts';
import { LocalImageTransformer, type ImageTransformer } from './transform.ts';

/** Called only by the media owner after it admits/selects an exact Use. Inspect
 * orientation before clipping the fixed width ladder; header dimensions alone
 * are insufficient for JPEGs whose EXIF orientation swaps width and height. */
export async function requestUseRenditions(
  store: MediaRenditionStore,
  objects: (namespace: string) => ImmutableObjects,
  use: string,
  transformer: ImageTransformer = new LocalImageTransformer(),
): Promise<{ queued: number }> {
  const basis = await store.requestBasis(use);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const size = await Promise.race([
      (async () => {
        const bytes = await objects(basis.namespace).get(basis.digest);
        if (
          bytes.length > RENDITION_LIMITS.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== basis.digest
        ) {
          throw new Error('rendition input integrity');
        }
        controller.signal.throwIfAborted();
        return transformer.inspect(bytes, basis.mediaType, controller.signal);
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('rendition request deadline'));
        }, RENDITION_LIMITS.timeoutMs);
      }),
    ]);
    return { queued: await store.queue(basis, size) };
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
  }
}
