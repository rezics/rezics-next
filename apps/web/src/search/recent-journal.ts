import { RECENT_HISTORY_LIMIT } from './recent-history';
import type { RecentEntry as NativeEntry, Pending } from './recent';

export type QueuedRecentCommand = Pending & {
  localId?: string;
  visitedAt?: number;
  expectedRevision?: number;
};
export type RecentJournal = {
  revision: number | null;
  observed: Record<string, number>;
  rows: Record<string, { id: string; visitedAt: number; entry?: NativeEntry }>;
  pending: QueuedRecentCommand[];
  conflict?: boolean;
};

const maxRevision = 2147483646;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const localKinds = new Set(['Library', 'Collection', 'Realm', 'Zone', 'Agent']);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function keysAre(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => owns(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}
function localId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const identity: unknown = JSON.parse(value);
    if (!Array.isArray(identity) || (identity.length !== 3 && identity.length !== 4) || JSON.stringify(identity) !== value)
      return false;
    const [kind, id, query, languages] = identity;
    if (
      !(kind === null && id === null) &&
      !(typeof kind === 'string' && localKinds.has(kind) && typeof id === 'string' && id.length <= 256)
    )
      return false;
    return (
      typeof query === 'string' &&
      query.length <= 256 &&
      (kind !== null || query.trim().length > 0) &&
      (identity.length === 3 ||
        (Array.isArray(languages) &&
          languages.length <= 8 &&
          languages.every((language) => typeof language === 'string' && language.length > 0 && language.length <= 35)))
    );
  } catch {
    return false;
  }
}
function nativeScope(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.kind === 'route') return keysAre(value, ['kind', 'route']) && value.route === 'library';
  return (
    (value.kind === 'realm' || value.kind === 'collection') &&
    keysAre(value, ['kind', 'id']) &&
    typeof value.id === 'string' &&
    uuid.test(value.id)
  );
}
function nativeEntry(value: unknown): value is NativeEntry {
  if (!record(value)) return false;
  if (value.kind === 'query')
    return (
      keysAre(value, ['kind', 'text'], ['languages', 'scope']) &&
      typeof value.text === 'string' &&
      value.text.length >= 1 &&
      value.text.length <= 256 &&
      (!owns(value, 'scope') || nativeScope(value.scope)) &&
      (!owns(value, 'languages') ||
        (Array.isArray(value.languages) &&
          value.languages.length <= 8 &&
          value.languages.every((language) => typeof language === 'string' && language.length >= 1 && language.length <= 35)))
    );
  return value.kind === 'scope' && keysAre(value, ['kind', 'scope']) && nativeScope(value.scope);
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maxRevision;
}

/** Admits only persisted command metadata that this adapter can safely resume. */
export function admitRecentJournal(value: unknown): RecentJournal | undefined {
  if (!record(value) || !keysAre(value, ['revision', 'observed', 'rows', 'pending'], ['conflict'])) return;
  if (!(value.revision === null || revision(value.revision)) || (owns(value, 'conflict') && typeof value.conflict !== 'boolean'))
    return;
  if (!record(value.observed) || !record(value.rows) || !Array.isArray(value.pending)) return;

  const observed = value.observed,
    rows = value.rows,
    pending = value.pending;
  if (
    Object.keys(observed).length > RECENT_HISTORY_LIMIT ||
    Object.keys(rows).length > 100 ||
    pending.length > 100
  )
    return;
  for (const [id, visitedAt] of Object.entries(observed))
    if (!localId(id) || typeof visitedAt !== 'number' || !Number.isFinite(visitedAt)) return;
  for (const [id, raw] of Object.entries(rows)) {
    if (!localId(id) || !record(raw) || !keysAre(raw, ['id', 'visitedAt'], ['entry'])) return;
    if (
      typeof raw.id !== 'string' ||
      !uuid.test(raw.id) ||
      typeof raw.visitedAt !== 'number' ||
      !Number.isFinite(raw.visitedAt) ||
      (owns(raw, 'entry') && !nativeEntry(raw.entry))
    )
      return;
  }

  const admitted: QueuedRecentCommand[] = [], keys = new Set<string>();
  let attempted = false;
  for (let index = 0; index < pending.length; index++) {
    const raw = pending[index];
    const encodedKey = record(raw) && typeof raw.key === 'string' ? JSON.stringify(raw.key) : undefined;
    if (
      !record(raw) ||
      !keysAre(raw, ['key', 'change', 'queuedAt'], ['localId', 'visitedAt', 'expectedRevision']) ||
      typeof raw.key !== 'string' ||
      !encodedKey ||
      encodedKey.length < 3 ||
      encodedKey.length > 1024 ||
      keys.has(raw.key) ||
      typeof raw.queuedAt !== 'string' ||
      !Number.isFinite(Date.parse(raw.queuedAt))
    )
      return;
    keys.add(raw.key);
    const hasLocalId = owns(raw, 'localId');
    if (hasLocalId && !localId(raw.localId)) return;
    if (owns(raw, 'visitedAt') && (typeof raw.visitedAt !== 'number' || !Number.isFinite(raw.visitedAt))) return;
    if (owns(raw, 'expectedRevision')) {
      if (!revision(raw.expectedRevision) || index !== 0 || attempted || raw.expectedRevision !== value.revision) return;
      attempted = true;
    }

    if (!record(raw.change)) return;
    if (raw.change.kind === 'use') {
      if (
        !keysAre(raw.change, ['kind', 'entry']) ||
        !nativeEntry(raw.change.entry) ||
        !hasLocalId ||
        !owns(raw, 'visitedAt')
      )
        return;
    } else if (raw.change.kind === 'remove') {
      if (!keysAre(raw.change, ['kind', 'id']) || !hasLocalId || owns(raw, 'visitedAt') || typeof raw.change.id !== 'string')
        return;
      if (uuid.test(raw.change.id)) {
        const row = rows[raw.localId as string];
        if (!record(row) || row.id !== raw.change.id) return;
      } else if (!raw.change.id.startsWith('pending:') || raw.change.id.length <= 'pending:'.length) return;
    } else if (raw.change.kind === 'clear') {
      if (!keysAre(raw.change, ['kind']) || hasLocalId || owns(raw, 'visitedAt')) return;
    } else return;

    admitted.push(raw as QueuedRecentCommand);
  }

  for (let index = 0; index < admitted.length; index++) {
    const command = admitted[index]!;
    if (command.change.kind !== 'remove' || uuid.test(command.change.id)) continue;
    const receiptKey = command.change.id.slice('pending:'.length);
    const use = admitted.slice(0, index).find((candidate) => candidate.key === receiptKey);
    if (
      !use ||
      use.change.kind !== 'use' ||
      use.expectedRevision === undefined ||
      use.localId !== command.localId
    )
      return;
  }

  return value as unknown as RecentJournal;
}

export const freshRecentJournal = (): RecentJournal => ({ revision: null, observed: {}, rows: {}, pending: [] });
