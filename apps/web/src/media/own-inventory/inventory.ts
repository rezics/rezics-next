import { coverSrc, validVariant } from '../cover-src';
import type { OwnMediaInventoryEntry, OwnMediaInventoryPage } from './wire';

export const OWN_MEDIA_OPERATION = 'media.own' as const;
export const OWN_MEDIA_SOURCE = 'media.own/v1' as const;
export const OWN_MEDIA_CURSOR_LIMIT = 2048;

export type OwnMediaEraseIntent = Readonly<{
  action: 'media.erase';
  mediaId: string;
  viewer: string;
  source: typeof OWN_MEDIA_SOURCE;
  idempotencyKey: string;
}>;

export function ownMediaCursor(value: unknown): { valid: true; cursor: string | null } | { valid: false } {
  if (value === undefined || value === null) return { valid: true, cursor: null };
  if (typeof value !== 'string' || value.length === 0 || value.length > OWN_MEDIA_CURSOR_LIMIT) return { valid: false };
  return { valid: true, cursor: value };
}

/** Index exactly one native page; sparse pages keep their original continuation. */
export function indexOwnMediaPage(page: OwnMediaInventoryPage) {
  if (page.entries.length > 20) throw new Error('The native media page exceeded its bound');
  const entries = new Map<string, OwnMediaInventoryEntry>();
  for (const entry of page.entries) {
    if (entries.has(entry.id)) throw new Error('The native media page repeated an original media identity');
    entries.set(entry.id, entry);
  }
  return { entries, nextCursor: page.nextCursor };
}

/** The current worker route rechecks authority at use; only advertised variants get a link. */
export function advisedMediaDestinations(entry: OwnMediaInventoryEntry) {
  const advice = entry.actions.read;
  if (
    !advice ||
    advice.operationId !== 'media.authorize_download' ||
    !advice.recheckAtUse ||
    entry.state !== 'available' ||
    entry.collectionPending ||
    entry.takenDown
  )
    return [];
  return advice.variants.flatMap((variant) => {
    if (!validVariant(variant)) return [];
    if (variant === 'original') return [{ variant, href: `/media/${encodeURIComponent(entry.id)}/original` }];
    const match = /^(avif|webp)-([1-9][0-9]{0,3})$/.exec(variant);
    if (!match) return [];
    return [{ variant, href: coverSrc(encodeURIComponent(entry.id), match[1] as 'avif' | 'webp', Number(match[2])) }];
  });
}

export function eraseIntentFor(
  entry: OwnMediaInventoryEntry,
  viewer: string,
  source: typeof OWN_MEDIA_SOURCE,
  idempotencyKey: string,
): OwnMediaEraseIntent | null {
  if (
    entry.actions.remove?.operationId !== 'media.erase' ||
    entry.state === 'erased' ||
    entry.collectionPending ||
    !viewer ||
    !idempotencyKey
  )
    return null;
  return {
    action: 'media.erase',
    mediaId: entry.id,
    viewer,
    source,
    idempotencyKey,
  };
}
