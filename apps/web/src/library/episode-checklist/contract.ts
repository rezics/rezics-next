export const EPISODE_INSPECT_CAP = 20;
export const EPISODE_RETAINED_PAGE = 20;
export const EPISODE_MUTATION_CAP = 20;
export const EPISODE_SESSION_CAP = 20_000;
/** Installed work-parts relations/links page (`limit: 20` in `readWorkParts`). */
export const MEMBERSHIP_PAGE_CAP = 20;
export const CANONICAL_EPISODE_TYPE = 'schema:Episode';
export const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const EPISODE_READ_SEAM = 'KernelClient.progressSessions({ sessionId }).episodes.get';
export const EPISODE_RECORD_SEAM = 'KernelClient.progressSessions({ sessionId }).$recordEpisodes.post';
export const EPISODE_MEMBERSHIP_SEAM = 'readWorkParts';

export type EpisodeMembershipKind = 'member' | 'detached' | 'unavailable';

export type EpisodeCompletion = {
  episodeSubjectId: string | null;
  completed: boolean | null;
  membership: EpisodeMembershipKind;
  ordinal: string | null;
};

export type EpisodeProgressView = {
  revision: number;
  episodes: EpisodeCompletion[];
  next: string | null;
  completeness?: number;
};

export type ChecklistRow = EpisodeCompletion & {
  label: string | null;
  source: 'membership' | 'retained' | 'inspect';
};

export type ChecklistIntent =
  | { kind: 'patch'; add: string[]; remove: string[] }
  | { kind: 'clear' };

export type ChecklistCommand = {
  sender: 'recordCanonicalEpisodes';
  credential: Record<string, string>;
  key: string;
  operands: {
    sessionId: string;
    revision: number;
    body: { revision: number; add?: string[]; remove?: string[] } | { revision: number; clear: true };
  };
};

export type ChecklistFailureKind =
  | 'invalid_request'
  | 'invalid_cursor'
  | 'not_found'
  | 'conflict'
  | 'stale_cursor'
  | 'unsupported_library_profile'
  | 'idempotency_conflict'
  | 'unavailable'
  | 'denied';

export type ChecklistOutcome =
  | { state: 'acknowledged'; revision: number }
  | { state: 'conflict'; command: ChecklistCommand; revision: number }
  | { state: 'stale_cursor'; command?: ChecklistCommand }
  | { state: 'ambiguous'; command: ChecklistCommand }
  | { state: 'uncertain'; command: ChecklistCommand }
  | { state: 'unsupported'; command: ChecklistCommand }
  | { state: 'refused'; command: ChecklistCommand }
  | { state: 'invalid'; command: ChecklistCommand; kind: 'invalid_request' | 'invalid_cursor' }
  | { state: 'retired'; command?: ChecklistCommand }
  | { state: 'unavailable'; command?: ChecklistCommand; seam: string };

export type ChecklistVisitKind =
  | 'preparing'
  | 'empty'
  | 'denied'
  | 'unavailable'
  | 'stale'
  | 'conflict'
  | 'ambiguous'
  | 'retry'
  | 'ready'
  | 'review'
  | 'submitting'
  | 'accepted'
  | 'retired';

export type ChecklistViewerBinding = {
  viewer: string;
  locale: string;
  subjectId: string;
  sessionId: string;
  revision: number;
  cursor?: string | null;
};

export type ChecklistVisit = {
  kind: ChecklistVisitKind;
  binding: ChecklistViewerBinding | null;
  membership: 'admitted' | 'unavailable' | 'empty';
  rows: ChecklistRow[];
  retainedNext: string | null;
  inspectRevision: number | null;
  selection: { add: string[]; remove: string[] };
  outcome: ChecklistOutcome | null;
  retry: ChecklistCommand | null;
  pending: boolean;
  seam?: string;
  completeness: number | 'unavailable';
};

export function quotedIdempotencyKey(key: string): string {
  return JSON.stringify(key);
}

export function canonicalIds(value: readonly string[]): string[] | null {
  if (value.length > EPISODE_INSPECT_CAP) return null;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of value) {
    if (!CANONICAL_ID.test(id) || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function redactedRow(source: ChecklistRow['source'] = 'inspect'): ChecklistRow {
  return {
    episodeSubjectId: null,
    completed: null,
    membership: 'unavailable',
    ordinal: null,
    label: null,
    source,
  };
}

export function projectRow(row: EpisodeCompletion, source: ChecklistRow['source'], label?: string | null): ChecklistRow {
  if (row.membership === 'unavailable' || row.episodeSubjectId === null) {
    return redactedRow(source);
  }
  return {
    episodeSubjectId: row.episodeSubjectId,
    completed: row.completed,
    membership: row.membership,
    ordinal: row.ordinal,
    label: label ?? null,
    source,
  };
}

export function preserveInspectOrder(supplied: readonly string[], rows: readonly EpisodeCompletion[]): ChecklistRow[] {
  return supplied.map((id, index) => {
    const row = rows[index];
    if (!row) return redactedRow('inspect');
    const projected = projectRow(row, 'inspect');
    if (projected.episodeSubjectId && projected.episodeSubjectId !== id) return redactedRow('inspect');
    return projected;
  });
}

export function mutationIntent(add: readonly string[], remove: readonly string[]): ChecklistIntent | null {
  const added = canonicalIds([...add]);
  const removed = canonicalIds([...remove]);
  if (!added || !removed) return null;
  const combined = new Set([...added, ...removed]);
  if (combined.size === 0 || combined.size > EPISODE_MUTATION_CAP) return null;
  if (added.some((id) => removed.includes(id))) return null;
  return { kind: 'patch', add: added, remove: removed };
}

export function sameCommand(left: ChecklistCommand, right: ChecklistCommand): boolean {
  return (
    left.sender === right.sender &&
    left.credential === right.credential &&
    left.key === right.key &&
    left.operands === right.operands
  );
}

export function emptySelection(): { add: string[]; remove: string[] } {
  return { add: [], remove: [] };
}

export function rowKey(row: ChecklistRow, index: number): string {
  return row.episodeSubjectId ?? `redacted:${row.source}:${index}`;
}
