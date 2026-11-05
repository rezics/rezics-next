import type { KernelClient } from '@rezics/client';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import * as v from 'valibot';

export { NativeDocumentImage } from './document-media-image';

// Consumer-local declaration until content/media-presentation.ts is delivered. No producer implementation lives here.
export type DocumentImagePresentation = Readonly<{
  id: string;
  containerId: string;
  digest: string;
  width: number;
  height: number;
  variants: readonly { format: 'avif' | 'webp'; width: number; height: number }[];
  placeholder: { thumbhash: string; color: string } | null;
  focalPoint: { x: number; y: number } | null;
  credit: MediaImportRequest['credit'] | null;
}>;
export type DocumentMediaPage = Readonly<{ images: readonly DocumentImagePresentation[] }>;
export type DocumentMediaRead =
  | { kind: 'ready'; images: ReadonlyMap<string, DocumentImagePresentation> }
  | { kind: 'unavailable' };

export const DOCUMENT_MEDIA_LIMIT = 32;
const id = v.pipe(v.string(), v.length(36), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/));
const dimension = v.pipe(v.number(), v.integer(), v.minValue(1));
const coordinate = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const creditText = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const creditSchema = v.strictObject({
  rightsHolder: creditText,
  via: v.strictObject({ name: creditText, url: v.pipe(creditText, v.regex(/^https:\/\/[^\s]+(?![\s\S])/)) }),
  license: v.pipe(v.string(), v.maxLength(80), v.regex(/^[A-Za-z0-9][A-Za-z0-9.+-]{0,79}(?![\s\S])/)),
  obligations: v.pipe(
    v.array(v.picklist(['cc:Attribution', 'cc:ShareAlike', 'cc:Notice', 'cc:SourceCode'])),
    v.maxLength(4),
    v.check((values) => new Set(values).size === values.length),
  ),
}) satisfies v.GenericSchema<MediaImportRequest['credit']>;
const imageSchema = v.strictObject({
  id,
  containerId: id,
  digest: v.pipe(v.string(), v.length(64), v.regex(/^[0-9a-f]{64}$/)),
  width: dimension,
  height: dimension,
  variants: v.pipe(
    v.array(v.strictObject({ format: v.picklist(['avif', 'webp']), width: dimension, height: dimension })),
    v.minLength(1),
    v.maxLength(12),
  ),
  placeholder: v.nullable(v.strictObject({ thumbhash: v.string(), color: v.string() })),
  focalPoint: v.nullable(v.strictObject({ x: coordinate, y: coordinate })),
  credit: v.nullable(creditSchema),
});
const pageSchema = v.strictObject({ images: v.pipe(v.array(imageSchema), v.maxLength(DOCUMENT_MEDIA_LIMIT)) });

function member(value: unknown, key: string): unknown {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? Reflect.get(value, key)
    : undefined;
}

/** One current, independent media read. Missing rows mean unavailable; this result never grants document access. */
export async function loadDocumentMedia(
  client: KernelClient,
  ids: readonly string[],
  authorization?: string | null,
  signal?: AbortSignal,
): Promise<DocumentMediaRead> {
  if (ids.length > DOCUMENT_MEDIA_LIMIT || new Set(ids).size !== ids.length || ids.some((value) => !v.is(id, value)))
    return { kind: 'unavailable' };
  if (!ids.length) return { kind: 'ready', images: new Map() };
  try {
    // The exact declared POST /v1/media/presentations, through the original client's native transport.
    // A client without this producer surface stays unavailable; there is no alternate source or refill.
    const endpoint = member(member(client, 'media'), 'presentations');
    const post = member(endpoint, 'post');
    if (typeof post !== 'function') return { kind: 'unavailable' };
    const result: unknown = await Reflect.apply(post, endpoint, [
      { ids: [...ids] },
      {
        ...(authorization ? { headers: { authorization } } : {}),
        fetch: { cache: 'no-store', redirect: 'manual', ...(signal ? { signal } : {}) },
      },
    ]);
    if (member(result, 'status') !== 200 || member(result, 'error')) return { kind: 'unavailable' };
    const page = v.safeParse(pageSchema, member(result, 'data'));
    if (!page.success) return { kind: 'unavailable' };
    const images = new Map<string, DocumentImagePresentation>();
    for (const image of page.output.images) {
      if (!ids.includes(image.id) || images.has(image.id)) return { kind: 'unavailable' };
      const variants = new Set(image.variants.map((variant) => `${variant.format}:${variant.width}`));
      if (variants.size !== image.variants.length) return { kind: 'unavailable' };
      images.set(image.id, image);
    }
    return { kind: 'ready', images };
  } catch {
    return { kind: 'unavailable' };
  }
}
