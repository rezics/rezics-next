import type { KernelClient } from '@rezics/client';

type OwnMediaReadCall = KernelClient['media']['get'];
export type OwnMediaInventoryPage = NonNullable<Awaited<ReturnType<OwnMediaReadCall>>['data']>;
export type OwnMediaInventoryEntry = OwnMediaInventoryPage['entries'][number];
type OwnMediaContainer = NonNullable<OwnMediaInventoryEntry['container']>;

const states = new Set(['reserved', 'uploaded', 'available', 'rejected', 'erased']);
const purposes = new Set(['post-image', 'avatar', 'realm-icon', 'realm-banner', 'cover']);
const kinds = new Set(['thread', 'post', 'realm', 'account']);
function safeVariant(value: unknown): boolean {
  if (value === 'original') return true;
  if (typeof value !== 'string') return false;
  const match = /^(?:avif|webp)-([1-9][0-9]{0,3})$/.exec(value);
  if (!match) return false;
  const width = Number(match[1]);
  return width < 320 || [320, 640, 960, 1280, 1920, 2560].includes(width);
}

/** Parse one public native page and copy only fields admitted by its public DTO. */
export function parseOwnMediaInventoryPage(value: unknown): OwnMediaInventoryPage | null {
  if (!value || typeof value !== 'object') return null;
  const page = value as Record<string, unknown>;
  if (
    page.availability !== 'available' ||
    !Array.isArray(page.entries) ||
    page.entries.length > 20 ||
    !(page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 2048))
  )
    return null;
  const ids = new Set<string>();
  const entries: OwnMediaInventoryEntry[] = [];
  for (const value of page.entries) {
    if (!value || typeof value !== 'object') return null;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.id !== 'string' ||
      entry.id.length === 0 ||
      entry.id.length > 64 ||
      ids.has(entry.id) ||
      !purposes.has(String(entry.purpose)) ||
      !states.has(String(entry.state)) ||
      !(entry.declaredMediaType === null || typeof entry.declaredMediaType === 'string') ||
      !(entry.actualMediaType === null || typeof entry.actualMediaType === 'string') ||
      !validSize(entry.declaredByteCount) ||
      !validSize(entry.actualByteCount) ||
      typeof entry.createdAt !== 'string' ||
      !(entry.claimedAt === null || typeof entry.claimedAt === 'string') ||
      typeof entry.collectionPending !== 'boolean' ||
      typeof entry.takenDown !== 'boolean' ||
      !(entry.container === null || isContainer(entry.container)) ||
      !entry.actions ||
      typeof entry.actions !== 'object'
    )
      return null;
    ids.add(entry.id);
    const actions = entry.actions as Record<string, unknown>;
    const read = parseRead(actions.read, entry);
    const resume = parseResume(actions.resume, entry.state);
    const retry = parseRetry(actions.retry, entry.state);
    if (read === undefined || resume === undefined || retry === undefined || !isRemove(actions.remove)) return null;
    entries.push({
      id: entry.id,
      purpose: entry.purpose as OwnMediaInventoryEntry['purpose'],
      state: entry.state as OwnMediaInventoryEntry['state'],
      declaredMediaType: entry.declaredMediaType as string | null,
      actualMediaType: entry.actualMediaType as string | null,
      declaredByteCount: entry.declaredByteCount as number | null,
      actualByteCount: entry.actualByteCount as number | null,
      createdAt: entry.createdAt,
      claimedAt: entry.claimedAt as string | null,
      collectionPending: entry.collectionPending,
      takenDown: entry.takenDown,
      container:
        entry.container === null
          ? null
          : {
              id: (entry.container as { id: string }).id,
              kind: (entry.container as { kind: OwnMediaContainer['kind'] }).kind,
            },
      actions: {
        read,
        remove: actions.remove === null ? null : { operationId: 'media.erase' },
        resume,
        retry,
      },
    });
  }
  return {
    availability: 'available',
    entries,
    nextCursor: page.nextCursor as string | null,
  };
}

function validSize(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isContainer(value: unknown): value is { id: string; kind: string } {
  if (!value || typeof value !== 'object') return false;
  const container = value as Record<string, unknown>;
  return typeof container.id === 'string' && container.id.length > 0 && kinds.has(String(container.kind));
}

function parseRead(
  value: unknown,
  entry: Record<string, unknown>,
): OwnMediaInventoryEntry['actions']['read'] | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const read = value as Record<string, unknown>;
  if (
    read.operationId !== 'media.authorize_download' ||
    read.recheckAtUse !== true ||
    !Array.isArray(read.variants) ||
    read.variants.length < 1 ||
    read.variants.length > 13 ||
    !read.variants.every(safeVariant) ||
    entry.state !== 'available' ||
    entry.collectionPending ||
    entry.takenDown
  )
    return undefined;
  return { operationId: 'media.authorize_download', variants: read.variants as string[], recheckAtUse: true };
}

function parseResume(
  value: unknown,
  state: unknown,
): OwnMediaInventoryEntry['actions']['resume'] | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const resume = value as Record<string, unknown>;
  const mode = state === 'reserved' ? 'same-reservation' : state === 'uploaded' ? 'processing' : null;
  if (
    resume.operationId !== 'media.read_reservation' ||
    resume.requiresOriginalFile !== true ||
    mode === null ||
    resume.mode !== mode
  )
    return undefined;
  return { operationId: 'media.read_reservation', mode, requiresOriginalFile: true };
}

function parseRetry(
  value: unknown,
  state: unknown,
): OwnMediaInventoryEntry['actions']['retry'] | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const retry = value as Record<string, unknown>;
  if (retry.operationId !== 'media.create' || retry.guidance !== 'choose-new-file' || state !== 'rejected')
    return undefined;
  return { operationId: 'media.create', guidance: 'choose-new-file' };
}

function isRemove(value: unknown): boolean {
  return (
    value === null ||
    (!!value && typeof value === 'object' && (value as Record<string, unknown>).operationId === 'media.erase')
  );
}
