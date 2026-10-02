import type { MediaImageMetadata, MediaImageReference } from '@rezics/ui/media-image';
import { mediaImageKey } from '@rezics/ui/media-image';
import { BFF_PREFIX } from './browser.ts';

const selection = /^selection:([0-9a-f-]{36})$/;

/** A selection cache key resolves the exact selected Use; it is never a saved media identity. */
export function imageReferenceFromUrl(src: string): MediaImageReference | undefined {
  try {
    const url = new URL(src, typeof window === 'undefined' ? 'https://rezics.com' : window.location.origin);
    const nativeHost = /^(?:[a-z0-9-]+\.)*rezics\.com$|^(?:localhost|127\.0\.0\.1)$/i.test(url.hostname);
    if (!nativeHost && (typeof window === 'undefined' || url.origin !== window.location.origin)) return undefined;
    src = `${url.pathname}${url.search}`;
  } catch { return undefined; }
  const representation = /^(?:\/api\/main)?\/v1\/media\/representations\/([0-9a-f-]{36})(?:[/?]|$)/.exec(src);
  if (representation) {
    const use = new URL(src, 'http://web.local').searchParams.get('use');
    return { representationId: representation[1]!, ...(use ? { mediaUseId: use } : {}) };
  }
  const match = /^(?:\/api\/main)?\/v1\/media\/avatars\/([0-9a-f-]{36})(?:[/?]|$)/.exec(src);
  return match ? { representationId: `selection:${match[1]}` } : undefined;
}

type Descriptor = {
  representation: string; use?: string | null; url: string;
  nsfw: MediaImageMetadata['nsfw']; ageRating: MediaImageMetadata['ageRating'];
  conceal: boolean; controls: MediaImageMetadata['controls']; canEdit?: boolean; canProtect?: boolean;
};

function normalize(value: Descriptor, reference: MediaImageReference, actor?: string | null): MediaImageMetadata {
  const url = new URL(`${BFF_PREFIX}${value.url}`, 'http://web.local');
  if (actor) url.searchParams.set('actingSubject', actor);
  const controls = value.controls && Object.fromEntries(Object.entries(value.controls).filter(([, control]) => control != null).map(([field, control]) =>
    [field, { ...control, canEdit: control.canEdit ?? value.canEdit,
      canProtect: control.canProtect ?? value.canProtect }])) as MediaImageMetadata['controls'];
  return {
    representationId: value.representation, ...(value.use ? { mediaUseId: value.use } : {}),
    requestKey: mediaImageKey(reference), src: `${url.pathname}${url.search}`, nsfw: value.nsfw,
    ageRating: value.ageRating, conceal: value.conceal, controls,
    revision: Object.values(value.controls ?? {}).filter(control => control != null)
      .map(control => `${control.valueHead}:${control.basis.head}`).join('|'),
  };
}

export async function resolveMediaMetadata(references: MediaImageReference[], actingSubject?: string | null,
  fetcher: typeof fetch = fetch): Promise<MediaImageMetadata[]> {
  if (references.length > 64) throw new Error('Image metadata batch exceeds 64 references');
  const items = references.map(ref => {
    const selected = selection.exec(ref.representationId);
    return selected ? { selection: selected[1] }
      : { representation: ref.representationId, ...(ref.mediaUseId ? { use: ref.mediaUseId } : {}) };
  });
  const response = await fetcher(`${BFF_PREFIX}/v1/media/metadata`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items, ...(actingSubject ? { actingSubject } : {}) }), cache: 'no-store',
  });
  if (!response.ok) throw new Error('Image metadata unavailable');
  const result = await response.json() as { items: ({ status: 'available' } & Descriptor | { status: 'unavailable' })[] };
  if (!Array.isArray(result.items) || result.items.length !== references.length) throw new Error('Incomplete image metadata');
  return result.items.flatMap((item, index) => item.status === 'available'
    ? [normalize(item, references[index]!, actingSubject)] : []);
}
