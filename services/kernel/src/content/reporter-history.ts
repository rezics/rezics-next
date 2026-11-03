import { createHmac } from 'node:crypto';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { AnchoredPosition } from './model.ts';
import { snapshot } from './reads.ts';
import {
  readReporterHistoryCases,
  reporterHistoryAuthority,
  ReportUnavailableError,
  type ReportDependencies,
  type ReportTarget,
  type ReportView,
} from './reports.ts';
import { readReporterHistoryTargets, type ReporterTargetSummary } from './reporter-history-targets.ts';
import rawPage from './reporter-history-page.sql';

export const REPORTER_HISTORY_PAGE_SIZE = 20;
type Context = Readonly<{ actor: Actor; deadline: number }>;
export type ReporterHistoryQuery = Readonly<{ cursor?: string; reportId?: string }>;
export type ReporterHistoryAction = Readonly<{ method: 'GET'; href: string }>;
export type ReporterHistoryEntry = Readonly<{
  id: string;
  target: ReportTarget;
  revisionId: string | null;
  reason: string;
  evidence: string | null;
  createdAt: string;
  outcome: 'actioned' | 'dismissed' | null;
  resolvedAt: string | null;
  targetSummary: ReporterTargetSummary;
  viewer: Readonly<{ ownsReport: true }>;
  actions: Readonly<{
    open: ReporterHistoryAction;
    follow: ReporterHistoryAction;
    target: ReporterHistoryAction | null;
  }>;
}>;
export type ReporterHistoryPage = Readonly<{
  state: 'ready' | 'preparing';
  entries: readonly ReporterHistoryEntry[];
  selectedReportId: string | null;
  nextCursor: string | null;
  retry: Readonly<{ cursor: string | null }>;
  viewer: Readonly<{ kind: 'reporter' }>;
  anchor: AnchoredPosition;
}>;
export class ReporterHistoryCursorError extends Error {}
export class ReporterHistoryChangedError extends Error {}

function ring(routeKey: Uint8Array): KeyRing {
  if (routeKey.byteLength < 32) throw new RangeError('Report route key must contain at least 32 bytes');
  return {
    current: 1,
    keys: new Map([[1, createHmac('sha256', routeKey).update('content.reporter-history.v1').digest()]]),
  };
}

/** Mounted own-history inventory. No caller-supplied account, totals, scans to
 * refill suppressed rows, moderator case reads or private evidence mirrors. */
export function createReporterHistory(dependencies: ReportDependencies) {
  const tokens = ring(dependencies.routeKey);
  return {
    read: (context: Context, query: ReporterHistoryQuery = {}) =>
      readReporterHistory(dependencies, tokens, context, query),
  };
}

async function readReporterHistory(
  dependencies: ReportDependencies,
  tokens: KeyRing,
  context: Context,
  query: ReporterHistoryQuery,
): Promise<ReporterHistoryPage> {
  const actor = context.actor;
  if (actor.kind !== 'account') throw new ReportUnavailableError();
  if (query.reportId !== undefined && routeOf(query.reportId) === null) throw new TypeError('Invalid report selection');
  const initial = await reporterHistoryAuthority(dependencies, context);
  if (!initial.value) throw new ReportUnavailableError();
  const binding: CursorBinding = {
    operation: 'content.reporter-history.v1',
    parameters: {
      account: actor.accountId,
      client: actor.clientId,
      requestedBy: actor.requestedBy,
      authnEpoch: actor.authnEpoch,
      scopes: JSON.stringify([...new Set(actor.scopes)].sort()),
      reportId: query.reportId ?? null,
      limit: REPORTER_HISTORY_PAGE_SIZE,
    },
  };
  let after: { at: string; id: string } | null = null;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(tokens, binding, query.cursor);
    if (
      !decoded.ok ||
      decoded.epoch !== initial.anchor.epoch ||
      decoded.after.length !== 2 ||
      typeof decoded.after[0] !== 'string' ||
      typeof decoded.after[1] !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(decoded.after[0]) ||
      !Number.isFinite(Date.parse(decoded.after[0])) ||
      routeOf(decoded.after[1]) === null
    )
      throw new ReporterHistoryCursorError('Invalid reporter history cursor');
    after = { at: decoded.after[0], id: decoded.after[1] };
  }
  const coverage = await snapshot(dependencies, GLOBAL_CONTEXT, context, async (client) => {
    const row = (
      await client.query<{ expected: number; installed: number }>(
        'SELECT expected, installed FROM content.report_locator_coverage WHERE route=0',
      )
    ).rows[0];
    return !!row && row.expected > 0 && row.expected === row.installed;
  });
  const raw = await snapshot(dependencies, actor.accountId, context, async (client) => {
    if (!coverage.value) return [];
    const parameters = {
      route: routeOf(actor.accountId)!,
      reporter: actor.accountId,
      at: after?.at ?? 'infinity',
      id: after?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    };
    return (
      await client.query<{ report_id: string; report_route: number; created_at: string }>(
        rawPage.sql,
        rawPage.params.map((name) => parameters[name as keyof typeof parameters]),
      )
    ).rows;
  });
  const selectedRaw = raw.value.slice(0, REPORTER_HISTORY_PAGE_SIZE);
  for (const candidate of selectedRaw) {
    if (routeOf(candidate.report_id) !== candidate.report_route)
      throw new ReporterHistoryChangedError('Invalid report locator');
  }
  // One explicit exact selection is independent of the ordinary raw frontier.
  const ids = [...new Set([...selectedRaw.map((row) => row.report_id), ...(query.reportId ? [query.reportId] : [])])];
  const retained = await readReporterHistoryCases(dependencies, ids, context);
  const currentTargets = [...retained.values()].map((record) => record.target);
  await readReporterHistoryTargets(dependencies, currentTargets, context);
  const current = await readReporterHistoryCases(dependencies, ids, context);
  for (const [id, record] of retained) {
    const final = current.get(id);
    // A changed native outcome retries the entire page at its original frontier.
    if (final && JSON.stringify(final) !== JSON.stringify(record))
      throw new ReporterHistoryChangedError('Report changed during page fill');
  }
  const targets = await readReporterHistoryTargets(
    dependencies,
    [...current.values()].map((record) => record.target),
    context,
  );
  const final = await reporterHistoryAuthority(dependencies, context);
  if (!final.value || final.anchor.epoch !== initial.anchor.epoch) throw new ReportUnavailableError();
  const selected = query.reportId ? current.get(query.reportId) : undefined;
  const order = [...new Set([...(selected ? [selected.id] : []), ...selectedRaw.map((row) => row.report_id)])];
  const entries: ReporterHistoryEntry[] = [];
  for (const id of order) {
    const record = current.get(id);
    if (!record) continue;
    const summary = targets.get(`${record.target.kind}:${record.target.id}`) ?? { state: 'unavailable' as const };
    const open = { method: 'GET' as const, href: `/v1/reports/${id}` };
    entries.push(project(record, summary, open));
  }
  const last = selectedRaw.at(-1);
  return {
    state: coverage.value ? 'ready' : 'preparing',
    entries,
    selectedReportId: selected?.id ?? null,
    nextCursor:
      coverage.value && raw.value.length > REPORTER_HISTORY_PAGE_SIZE && last
        ? encodeCursor(tokens, binding, { epoch: final.anchor.epoch, after: [last.created_at, last.report_id] })
        : null,
    retry: { cursor: query.cursor ?? null },
    viewer: { kind: 'reporter' },
    anchor: final.anchor,
  };
}

function project(
  record: ReportView,
  targetSummary: ReporterTargetSummary,
  open: ReporterHistoryAction,
): ReporterHistoryEntry {
  return {
    id: record.id,
    target: record.target,
    revisionId: record.revisionId,
    reason: record.reason,
    evidence: record.evidence,
    createdAt: record.createdAt,
    outcome: record.outcome,
    resolvedAt: record.resolvedAt,
    targetSummary,
    viewer: { ownsReport: true },
    actions: {
      open,
      follow: open,
      target: targetSummary.state === 'available' ? { method: 'GET', href: targetSummary.href } : null,
    },
  };
}
