import type { Kernel } from '@rezics/client';

type ReporterHistoryRoute = Kernel['~Routes']['v1']['reports']['me']['get'];
export type ReporterHistoryQuery = ReporterHistoryRoute['query'];
export type ReporterHistoryPage = ReporterHistoryRoute['response'][200];
export type ReporterHistoryEntry = ReporterHistoryPage['entries'][number];
type Action = ReporterHistoryEntry['actions']['open'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(): never {
  throw new Error('Invalid own report history response');
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : invalid();
}
function nullable(value: unknown): string | null {
  return value === null ? null : text(value);
}
function identity(value: unknown): string {
  const id = text(value);
  return uuid.test(id) ? id : invalid();
}
function timestamp(value: unknown): string {
  const at = text(value);
  return Number.isFinite(Date.parse(at)) ? at : invalid();
}
function action(value: unknown, href: string): Action {
  const record = object(value, ['method', 'href']);
  if (record.method !== 'GET' || record.href !== href) return invalid();
  return { method: 'GET', href };
}
export function reporterHistoryQuery(value: unknown): ReporterHistoryQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'cursor' && key !== 'reportId')) return invalid();
  return {
    ...(record.cursor === undefined ? {} : { cursor: text(record.cursor) }),
    ...(record.reportId === undefined ? {} : { reportId: identity(record.reportId) }),
  };
}
function entry(value: unknown): ReporterHistoryEntry {
  const row = object(value, [
    'id',
    'target',
    'revisionId',
    'reason',
    'evidence',
    'createdAt',
    'outcome',
    'resolvedAt',
    'targetSummary',
    'viewer',
    'actions',
  ]);
  const id = identity(row.id);
  const target = object(row.target, ['kind', 'id']);
  const kind = target.kind;
  if (
    kind !== 'board' &&
    kind !== 'thread' &&
    kind !== 'post' &&
    kind !== 'subject' &&
    kind !== 'realm' &&
    kind !== 'space'
  )
    return invalid();
  const targetId = identity(target.id);
  const summary = row.targetSummary as Record<string, unknown> | null;
  let targetSummary: ReporterHistoryEntry['targetSummary'];
  if (summary?.state === 'available') {
    object(summary, ['state', 'label', 'href']);
    const href = `/v1/${kind === 'space' ? 'spaces' : `${kind}s`}/${targetId}`;
    if (summary.href !== href) return invalid();
    targetSummary = { state: 'available', label: nullable(summary.label), href };
  } else {
    if (object(summary, ['state']).state !== 'unavailable') return invalid();
    targetSummary = { state: 'unavailable' };
  }
  if (object(row.viewer, ['ownsReport']).ownsReport !== true) return invalid();
  const advice = object(row.actions, ['open', 'follow', 'target']);
  const targetAction =
    targetSummary.state === 'available'
      ? action(advice.target, targetSummary.href)
      : advice.target === null
        ? null
        : invalid();
  if (row.outcome !== null && row.outcome !== 'actioned' && row.outcome !== 'dismissed') return invalid();
  const resolvedAt = row.resolvedAt === null ? null : timestamp(row.resolvedAt);
  if ((row.outcome === null) !== (resolvedAt === null)) return invalid();
  return {
    id,
    target: { kind, id: targetId },
    revisionId: row.revisionId === null ? null : identity(row.revisionId),
    reason: text(row.reason),
    evidence: nullable(row.evidence),
    createdAt: timestamp(row.createdAt),
    outcome: row.outcome,
    resolvedAt,
    targetSummary,
    viewer: { ownsReport: true },
    actions: {
      open: action(advice.open, `/v1/reports/${id}`),
      follow: action(advice.follow, `/v1/reports/${id}`),
      target: targetAction,
    },
  };
}
/** Validate ownership advice, exact selection and original frontier before retaining any private row. */
export function reporterHistoryPage(value: unknown, query: ReporterHistoryQuery): ReporterHistoryPage {
  const page = object(value, ['state', 'entries', 'selectedReportId', 'nextCursor', 'retry', 'viewer']);
  if (page.state !== 'ready' && page.state !== 'preparing') return invalid();
  if (object(page.viewer, ['kind']).kind !== 'reporter') return invalid();
  const cursor = nullable(object(page.retry, ['cursor']).cursor);
  if (cursor !== (query.cursor ?? null)) return invalid();
  if (!Array.isArray(page.entries) || page.entries.length > 21) return invalid();
  const entries = page.entries.map(entry);
  if (new Set(entries.map((row) => row.id)).size !== entries.length) return invalid();
  const selectedReportId = page.selectedReportId === null ? null : identity(page.selectedReportId);
  if (
    selectedReportId !== null &&
    (selectedReportId !== query.reportId || !entries.some((row) => row.id === selectedReportId))
  )
    return invalid();
  if (query.reportId && entries.some((row) => row.id === query.reportId) && selectedReportId !== query.reportId)
    return invalid();
  if (entries.length > 20 && selectedReportId === null) return invalid();
  const nextCursor = nullable(page.nextCursor);
  if (page.state === 'preparing' && nextCursor !== null) return invalid();
  return { state: page.state, entries, selectedReportId, nextCursor, retry: { cursor }, viewer: { kind: 'reporter' } };
}
