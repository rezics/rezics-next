import type { WorkbenchQueueKind } from './scope';

/** Local public consumer contract, pending the native producer and shared publication.
 * A candidate, membership or readable board must never be converted into this advice.
 */
export type ModerationDirectoryItem = {
  scope: { kind: 'board'; id: string } | { kind: 'catalogue' };
  label: string;
  parent: { id: string; label: string } | null;
  queues: WorkbenchQueueKind[];
  viewer: { open: 'permitted' | 'denied' | 'unavailable' };
};
export type ModerationDirectoryPage =
  | {
      state: 'ready';
      items: ModerationDirectoryItem[];
      next: string | null;
      /** Opaque final native observation, independent of the browser reader origin. */
      source: string;
      /** Exclusive authority/coverage horizon supplied by the native producer. */
      validUntil: string;
    }
  | { state: 'preparing' | 'unavailable' | 'denied' | 'stale'; items: []; next: null };

export type ModerationDirectoryInput = { cursor?: string; realmId?: string; limit: 20 };
export type ModerationDirectorySource = (input: ModerationDirectoryInput) => Promise<ModerationDirectoryPage>;

/** No installed public producer binding yet. Never substitute Account memberships or a board inventory. */
export const nativeModerationDirectoryUnavailable: ModerationDirectorySource = async () => ({
  state: 'unavailable', items: [], next: null,
});

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function item(value: unknown): ModerationDirectoryItem | null {
  if (!object(value) || !object(value.scope) || !object(value.viewer) || !text(value.label, 1024)) return null;
  const scope = value.scope.kind === 'board' && text(value.scope.id, 128)
    ? { kind: 'board' as const, id: value.scope.id }
    : value.scope.kind === 'catalogue' ? { kind: 'catalogue' as const } : null;
  if (!scope || !['permitted', 'denied', 'unavailable'].includes(String(value.viewer.open))) return null;
  if (!Array.isArray(value.queues) || value.queues.length < 1 || value.queues.length > 3 ||
    new Set(value.queues).size !== value.queues.length || value.queues.some((queue) =>
      !['reports', 'appeals', 'resolved'].includes(queue) || (scope.kind === 'catalogue' && queue === 'appeals'))) return null;
  const parent = value.parent === null ? null
    : object(value.parent) && text(value.parent.id, 128) && text(value.parent.label, 1024)
      ? { id: value.parent.id, label: value.parent.label } : undefined;
  if (parent === undefined || (scope.kind === 'catalogue' && parent !== null)) return null;
  return { scope, label: value.label, parent, queues: [...value.queues],
    viewer: { open: value.viewer.open as ModerationDirectoryItem['viewer']['open'] } };
}

/** Bound retained browser data and copy only the public fields. These are consumer limits,
 * not evidence of bounded upstream candidate selection, Access work or projection upkeep.
 */
export function moderationDirectoryPage(value: unknown, now = Date.now()): ModerationDirectoryPage {
  const unavailable: ModerationDirectoryPage = { state: 'unavailable', items: [], next: null };
  if (!object(value)) return unavailable;
  if (value.state !== 'ready') {
    return ['preparing', 'unavailable', 'denied', 'stale'].includes(String(value.state))
      ? { state: value.state as 'preparing' | 'unavailable' | 'denied' | 'stale', items: [], next: null }
      : unavailable;
  }
  if (!text(value.source, 256) || !text(value.validUntil, 40) || !Number.isFinite(Date.parse(value.validUntil)))
    return unavailable;
  const until = Date.parse(value.validUntil);
  if (until <= now) return { state: 'stale', items: [], next: null };
  if (until > now + 180000 || !Array.isArray(value.items) || value.items.length > 20 ||
    (value.next !== null && !text(value.next, 4096))) return unavailable;
  const items: ModerationDirectoryItem[] = [];
  const scopes = new Set<string>();
  for (const candidate of value.items) {
    const entry = item(candidate);
    if (!entry) return unavailable;
    const key = entry.scope.kind === 'board' ? `board:${entry.scope.id}` : 'catalogue';
    if (scopes.has(key)) return unavailable;
    scopes.add(key); items.push(entry);
  }
  return { state: 'ready', items, next: value.next as string | null, source: value.source, validUntil: value.validUntil };
}
