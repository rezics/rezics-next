import type { Pool, PoolClient } from 'pg';
import { withPreservationFence, type PreservationFence } from '../public-report/preservation.ts';
import { ERASURE_DEFERRED_REASON } from './schema.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type GraphTerminalProof, type RegisteredAdmission } from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { applyContentErasure, checkContentErasureTargets, ContentErasureGraphRequired,
  contentErasureResource, ContentErasureInvalid, ContentErasureStale } from './content.ts';
import { GraphErasureConflict, GraphErasureUnavailable, readGraphErasureProof,
  suppressGraphContentRevisions } from './graph.ts';
import { ERASURE_JOURNAL_EPOCH, ErasureInvalid, ErasureNotFound, ErasureStale, ErasureUnavailable,
  findErasureByOperation,
  journalErasure, markErasureBlocked, markErasureSuppressed, readErasure,
  recordErasureInventory, type ErasureReport, ensureRetentionDomain, relayTransaction,
  sha256 } from './journal.ts';

export class ErasureDenied extends Error {}
/** A sealed admission without a journal entry was cancelled before it could apply. */
export class ErasureNotApplied extends Error {}

export const ERASURE_ACTION = 'erasure.request';
export const CONTENT_ERASURE_PROFILE = 'content-revision-erasure-v1';
/** Live Content rows lose their bytes, but PostgreSQL keeps prior versions until rewrite. */
export const CONTENT_LIVE_DOMAIN = 'content:postgresql:live';
export const CONTENT_WAL_DOMAIN = 'content:postgresql-wal:live';
export const CONTENT_LIVE_RETENTION =
  'PostgreSQL keeps prior row versions and WAL until a qualified rewrite and WAL recycling';
export const GRAPH_LIVE_RETENTION =
  'TDB2 and Lucene old filesets remain until a verified sanitized cutover and retirement';

type ErasureAccess = Pick<AccessAdmissionRegistry,
  'register' | 'claim' | 'recordGraphOutcome' | 'activePrincipalId'>;

export interface ContentErasureInput {
  actingSubject: string;
  resourceId: string;
  revisionIds: string[];
  idempotencyKey: string;
}

/** Owner pools of the erasure command: the retained relay journal and Content. */
export class ErasureService {
  constructor(readonly relay: Pool, readonly content: Pool, readonly preservationAccess: Pool) {}
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentErasureDigest(input: Omit<ContentErasureInput, 'idempotencyKey'>): string {
  return sha256(canonical({ profile: CONTENT_ERASURE_PROFILE, actingSubject: input.actingSubject,
    resourceId: input.resourceId, revisionIds: input.revisionIds }));
}

export function erasureReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${sha256(`${admissionId}\0erasure-request`)}`;
}

function proof(admission: Pick<RegisteredAdmission, 'id' | 'requestDigest' | 'authorityEpoch' | 'scope'>,
  outcome: GraphTerminalProof['outcome'], erasureEpoch: string): GraphTerminalProof {
  return { outcome, receipt: erasureReceiptIri(admission.id), admissionId: admission.id,
    requestDigest: admission.requestDigest, authorityEpoch: admission.authorityEpoch,
    scope: admission.scope, dataEpoch: ERASURE_JOURNAL_EPOCH, sequence: erasureEpoch };
}

/**
 * Finish one journaled Content erasure. Every step is idempotent: the Content
 * tombstone, the journal fence, the Access seal and the retention inventory.
 */
async function completeContentErasure(service: ErasureService, graph: WorkActivationEnvironment,
  access: ErasureAccess,
  admission: Pick<RegisteredAdmission, 'id' | 'requestDigest' | 'authorityEpoch' | 'scope'>,
  erasureId: string): Promise<void> {
  const journaled = await readErasure(service.relay, erasureId);
  const revisionIds = journaled.targets.map(target => target.ref);
  if (journaled.stage === 'blocked') {
    await access.recordGraphOutcome(admission.id, proof(admission, 'succeeded', journaled.erasureEpoch));
    return;
  }
  if (journaled.stage === 'requested') {
    try {
      const resourceId = admission.scope.slice('erasure:'.length);
      const erase = async (fence: PreservationFence) => {
        await suppressGraphContentRevisions(graph.fuseki, graph.lineage, erasureId,
          journaled.erasureEpoch, revisionIds);
        const graphProof = await readGraphErasureProof(graph.fuseki, graph.lineage, erasureId,
          journaled.erasureEpoch, revisionIds);
        await applyContentErasure(service.content, { erasureId, erasureEpoch: journaled.erasureEpoch,
          resourceId, revisionIds, graphProof, preservationAccess: fence });
        await markErasureSuppressed(service.relay, erasureId);
      };
      const held = (await withPreservationFence(service.preservationAccess, resourceId, erasureId, erase)).held;
      if (held) {
        await markErasureBlocked(service.relay, erasureId, ERASURE_DEFERRED_REASON);
        await access.recordGraphOutcome(admission.id, proof(admission, 'succeeded', journaled.erasureEpoch));
        return;
      }
    } catch (error) {
      if (error instanceof ContentErasureGraphRequired) throw error;
      if (!(error instanceof ContentErasureStale)) throw error;
      // An exact target changed after journaling; retain the rejected intent.
      await markErasureBlocked(service.relay, erasureId, 'Content revision changed before erasure');
    }
  }
  await access.recordGraphOutcome(admission.id, proof(admission, 'succeeded', journaled.erasureEpoch));
  await ensureRetentionDomain(service.relay, { label: CONTENT_LIVE_DOMAIN, owner: 'content',
    store: 'postgresql', custody: 'live' });
  await ensureRetentionDomain(service.relay, { label: CONTENT_WAL_DOMAIN, owner: 'content',
    store: 'postgresql_wal', custody: 'live' });
  for (const [store, label] of [
    ['tdb2_generation', `graph:tdb2:live:${graph.lineage.dataEpoch}`],
    ['lucene', `graph:lucene:live:${graph.lineage.dataEpoch}`],
  ] as const) {
    await ensureRetentionDomain(service.relay, { label, owner: 'graph', store, custody: 'live' });
  }
  for (const [store, label, holdReason, custody] of [
    ['snapshot', 'graph:snapshot:unverified', 'Snapshot destruction evidence is required', 'archive'],
    ['tdb2', 'graph:backup:unverified', 'Backup destruction evidence is required', 'backup'],
    ['media', 'graph:media:unverified', 'Media destruction evidence is required', 'archive'],
  ] as const) {
    await ensureRetentionDomain(service.relay, { label, owner: 'graph', store, custody, holdReason });
  }
  await recordErasureInventory(service.relay, erasureId,
    { owners: ['content', 'graph'], liveRetentionReason: CONTENT_LIVE_RETENTION,
      liveRetentionReasons: { graph: GRAPH_LIVE_RETENTION } });
}

async function cancel(access: ErasureAccess, admission: RegisteredAdmission, error: Error): Promise<never> {
  await access.recordGraphOutcome(admission.id, proof(admission, 'cancelled', '0'));
  throw error;
}

/**
 * Account verifies the caller, Access admits `erasure.request` on the resource's
 * erasure scope, Content proves the exact targets, the relay journals the intent,
 * Content applies its tombstone and Access seals the admission with the journal
 * epoch as its source position.
 */
export async function requestContentErasure(service: ErasureService,
  graph: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>, access: ErasureAccess, request: Request,
  input: ContentErasureInput): Promise<{ report: ErasureReport; replayed: boolean }> {
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(input.resourceId)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(input.actingSubject)) {
    throw new ContentErasureInvalid('Content erasure request is invalid');
  }
  const requestDigest = contentErasureDigest(input);
  const principal = await account.verify(request, ['access:manage']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `erasure:${input.resourceId}`, action: ERASURE_ACTION,
    idempotencyKey: input.idempotencyKey, requestDigest });
  const operationId = `erasure:${registered.id}`;
  let erasureId = await findErasureByOperation(service.relay, operationId);
  if (registered.state === 'sealed') {
    if (!erasureId) throw new ErasureNotApplied('erasure admission was cancelled');
    await completeContentErasure(service, graph, access, registered, erasureId);
    await reapplyForReplay(service, graph, erasureId);
    return { report: await readErasure(service.relay, erasureId), replayed: true };
  }
  try { await access.claim(registered.id, requestDigest); }
  catch (error) {
    if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
    // A journaled erasure is committed intent; an unjournaled one is cancelled.
    if (!erasureId) await cancel(access, registered, new ErasureDenied('erasure dispatch is not admitted'));
  }
  let replayed = Boolean(erasureId);
  if (!erasureId) {
    try {
      await checkContentErasureTargets(service.content, input.resourceId, input.revisionIds, true);
      const journaled = await journalErasure(service.relay, { operationId, requestDigest,
        kind: 'revision', principalId: registered.principalId, admissionId: registered.id,
        authorityEpoch: registered.authorityEpoch,
        targets: input.revisionIds.map(ref => ({ kind: 'content_revision', ref })) });
      erasureId = journaled.erasureId;
      replayed = journaled.replayed;
    } catch (error) {
      if (error instanceof ContentErasureInvalid || error instanceof ContentErasureStale
        || error instanceof ContentErasureGraphRequired || error instanceof ErasureStale) {
        await cancel(access, registered, error);
      }
      throw error;
    }
  }
  await completeContentErasure(service, graph, access, registered, erasureId!);
  return { report: await readErasure(service.relay, erasureId!), replayed };
}

/** Exact read for the principal who requested the erasure; others see no record. */
export async function readRequestedErasure(service: ErasureService,
  account: Pick<AccountAssertionVerifier, 'verify'>, access: ErasureAccess, request: Request,
  erasureId: string): Promise<ErasureReport> {
  const principal = await account.verify(request, ['access:manage']);
  const principalId = await access.activePrincipalId(principal);
  const report = await readErasure(service.relay, erasureId);
  if (!principalId || report.principalId !== principalId) throw new ErasureNotFound('erasure is unavailable');
  return report;
}

/**
 * Operator reconciler for journaled Content erasures left `requested` by a lost
 * response or crash. It completes them and never cancels journaled intent; an
 * entry that cannot complete stays `requested` and is returned for escalation.
 */
export async function completePendingContentErasures(service: ErasureService,
  graph: WorkActivationEnvironment, access: ErasureAccess,
  limit = 100): Promise<{ completed: number; failed: string[] }> {
  const pending = await relayTransaction(service.relay, async client => (await client.query<{
    id: string; admission_id: string; request_digest: string; authority_epoch: string }>(
    `SELECT id, admission_id, request_digest, authority_epoch::text AS authority_epoch
     FROM relay.erasure WHERE stage IN ('requested', 'fenced') AND kind = 'revision'
     ORDER BY erasure_epoch LIMIT $1`, [Math.min(Math.max(limit, 1), 100)])).rows);
  const failed: string[] = [];
  for (const row of pending) {
    try {
      const report = await readErasure(service.relay, row.id);
      const resourceId = await contentErasureResource(service.content,
        report.targets.map(target => target.ref));
      await completeContentErasure(service, graph, access, { id: row.admission_id,
        requestDigest: row.request_digest, authorityEpoch: row.authority_epoch,
        scope: `erasure:${resourceId}` }, row.id);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failed.push(row.id);
    }
  }
  return { completed: pending.length - failed.length, failed };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EPOCH = /^(0|[1-9][0-9]{0,18})$/;
/** The journal bound; the graph proof read is bound to 64, which is reported, never bypassed. */
const JOURNAL_TARGETS = 256;
const GRAPH_TARGETS = 64;
/** Raw journal rows examined per window; one more is read to know whether the journal continues. */
export const SOURCE_REMEDIATION_WINDOW = 100;

/** What happened to one journal entry. Anything outside `cleared` and `clean` is reported, never counted complete. */
export type SourceRemediationOutcome =
  | 'cleared'      // open sources existed and were cleared under the original id and epoch
  | 'clean'        // no target stores a source
  | 'pending'      // not suppressed yet; completePendingContentErasures owns it
  | 'blocked'      // deferred by a hold at request time; never erased
  | 'foreign'      // not a Content revision erasure
  | 'malformed'    // targets or resource cannot be read as one Content erasure
  | 'unapplied'    // suppressed in the journal but a target is not erased in Content
  | 'stale'        // a target's tombstone is not exactly this id and epoch
  | 'held'         // a current preservation hold: nothing changed
  | 'native'       // exact graph suppression proof is unavailable or conflicts
  | 'graph-limit'  // 65..256 targets cannot read their graph proof; not remediated
  | 'failed';      // the apply failed or a source remained afterwards

export interface SourceRemediationEntry {
  erasureId: string; erasureEpoch: string; outcome: SourceRemediationOutcome;
  /** Revisions whose sources were cleared by this call. */
  cleared: string[];
}

export interface SourceRemediationWindow {
  after: string; inspected: number; entries: SourceRemediationEntry[];
  /** Epoch to resume after, or null when the journal ended inside this window. */
  next: string | null;
  /** Entries a later call must still resolve; `pending`, `blocked` and `foreign` are out of scope here. */
  unresolved: string[];
}

/**
 * Indexed existence probes for a stored source selector, one set per revision: the
 * comment partial index and the evidence open and terminal-repair partial indexes.
 * At most the journal bound; never a table scan.
 */
export const OPEN_SOURCE_PROBE = `SELECT wanted.id::text AS revision_id
    FROM unnest($1::uuid[]) AS wanted(id)
    WHERE EXISTS (SELECT 1 FROM content.comment c WHERE c.revision_id = wanted.id
        AND (c.exact IS NOT NULL OR c.prefix IS NOT NULL OR c.suffix IS NOT NULL))
      OR EXISTS (SELECT 1 FROM verification.evidence_item i WHERE i.content_revision_id = wanted.id
        AND NOT i.source_terminal AND verification.evidence_selector_has_source(i.selector))
      OR EXISTS (SELECT 1 FROM verification.evidence_item i WHERE i.content_revision_id = wanted.id
        AND i.source_terminal AND verification.evidence_selector_has_source(i.selector))
    ORDER BY wanted.id`;

async function openSources(content: Pool, revisionIds: readonly string[]): Promise<string[]> {
  if (revisionIds.length > JOURNAL_TARGETS) throw new ContentErasureInvalid('Content erasure probe is too large');
  return (await content.query<{ revision_id: string }>(OPEN_SOURCE_PROBE, [revisionIds])).rows
    .map(row => row.revision_id);
}

/**
 * Re-apply one already-suppressed erasure's own journal id and epoch to the targets
 * that still store a source. Authority is the retained journal entry plus the current
 * preservation fence and the exact graph proof; nothing is inferred from current heads
 * and no revision is erased for the first time here.
 */
interface JournalRow {
  id: string; epoch: string; kind: string; stage: string; suppression: string;
  authority: string; operation: string; admission: string | null;
}
const JOURNAL_COLUMNS = `id, erasure_epoch::text AS epoch, kind, stage, suppression_status AS suppression,
  authority, operation_id AS operation, admission_id::text AS admission`;

/** A relay pool, or a client the caller borrowed and whose transaction and lifetime it owns. */
type Relay = Pool | PoolClient;

async function remediateEntry(service: ErasureService, graph: WorkActivationEnvironment,
  row: JournalRow, relay: Relay = service.relay): Promise<SourceRemediationEntry> {
  const done = (outcome: SourceRemediationOutcome, cleared: string[] = []): SourceRemediationEntry =>
    ({ erasureId: row.id, erasureEpoch: row.epoch, outcome, cleared });
  if (row.kind !== 'revision') return done('foreign');
  if (row.stage === 'blocked') return done('blocked');
  if (row.suppression !== 'suppressed') return done('pending');
  // The retained intent: an Access-admitted entry whose operation is its own admission's.
  if (row.authority !== 'access_admission' || !row.admission
    || row.operation !== `erasure:${row.admission}`) return done('malformed');
  let ids: string[];
  try {
    const report = await readErasure(relay, row.id);
    ids = report.targets.map(target => target.ref);
    if (!ids.length || ids.length > JOURNAL_TARGETS || new Set(ids).size !== ids.length
      || report.targets.some(target => target.owner !== 'content' || target.kind !== 'content_revision'
        || !UUID.test(target.ref)) || report.erasureEpoch !== row.epoch) return done('malformed');
  } catch (error) {
    if (error instanceof ErasureNotFound || error instanceof ErasureInvalid) return done('malformed');
    if (error instanceof Error) return done('failed');
    throw error;
  }
  try {
    // Counts over this entry's own <= 256 ids: bounded by the journal entry, never a table count.
    const exact = (await service.content.query<{ n: number; unerased: number }>(`SELECT
      count(*) FILTER (WHERE e.erasure_id = $2::uuid AND e.erasure_epoch = $3::bigint
        AND r.availability = 'erased')::int AS n,
      count(*) FILTER (WHERE r.availability = 'available' AND e.revision_id IS NULL)::int AS unerased
      FROM unnest($1::uuid[]) AS wanted(id) JOIN content.revision r ON r.id = wanted.id
      LEFT JOIN content.revision_erasure e ON e.revision_id = r.id`,
    [ids, row.id, row.epoch])).rows[0]!;
    if (exact.n !== ids.length) return done(exact.unerased > 0 ? 'unapplied' : 'stale');
    const open = await openSources(service.content, ids);
    if (!open.length) return done('clean');
    if (ids.length > GRAPH_TARGETS) return done('graph-limit');
    const resourceId = await contentErasureResource(service.content, ids);
    const guarded = await withPreservationFence(service.preservationAccess, resourceId, row.id,
      async fence => {
        const graphProof = await readGraphErasureProof(graph.fuseki, graph.lineage, row.id, row.epoch, ids);
        await applyContentErasure(service.content, { erasureId: row.id, erasureEpoch: row.epoch,
          resourceId, revisionIds: open, graphProof, preservationAccess: fence });
      });
    if (guarded.held) return done('held');
    // A clear that did not remove every source is a failure, whatever the apply returned.
    return (await openSources(service.content, ids)).length ? done('failed') : done('cleared', open);
  } catch (error) {
    if (error instanceof ContentErasureStale || error instanceof ContentErasureInvalid) return done('stale');
    if (error instanceof GraphErasureUnavailable || error instanceof GraphErasureConflict
      || error instanceof ContentErasureGraphRequired) return done('native');
    if (error instanceof Error) return done('failed');
    throw error;
  }
}

/**
 * Operator remediation for erasures completed before source clearing existed. It
 * reads one raw window of the journal by the unique `erasure_epoch` (at most 100 rows
 * plus one look-ahead row, no filter, no count) and, for each entry, re-applies the
 * entry's own id and epoch to targets that still store a source. A stored cursor is
 * not needed: `next` is the last epoch examined and a repeat is idempotent. Entries
 * that are malformed, foreign, blocked, pending, held or failed are returned with
 * their outcome and the epoch order is never skipped, so a partial failure is
 * visible in `unresolved` and a later call from the same `after` retries it.
 */
export async function remediateErasedContentSources(service: ErasureService,
  graph: WorkActivationEnvironment, input: { after?: string; limit?: number } = {}):
  Promise<SourceRemediationWindow> {
  const after = input.after ?? '0';
  if (!EPOCH.test(after)) throw new ErasureInvalid('erasure cursor is invalid');
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? SOURCE_REMEDIATION_WINDOW), 1),
    SOURCE_REMEDIATION_WINDOW);
  const rows = (await service.relay.query<JournalRow>(`SELECT ${JOURNAL_COLUMNS} FROM relay.erasure
    WHERE erasure_epoch > $1::bigint ORDER BY erasure_epoch LIMIT $2`, [after, limit + 1])).rows;
  const window = rows.slice(0, limit);
  const entries: SourceRemediationEntry[] = [];
  for (const row of window) entries.push(await remediateEntry(service, graph, row));
  const resolved = new Set<SourceRemediationOutcome>(['cleared', 'clean', 'pending', 'blocked', 'foreign']);
  return { after, inspected: window.length, entries,
    next: rows.length > limit ? window[window.length - 1]!.epoch : null,
    unresolved: entries.filter(entry => !resolved.has(entry.outcome)).map(entry => entry.erasureId) };
}

/**
 * One journaled entry by id, for a per-erasure owner operation. The committed intent is never
 * rewritten. An owner that already holds a relay client (for example under an advisory lock)
 * passes it as `relay`: every journal read then uses that client, never a second checkout from
 * the pool, and the helper never begins, ends or releases it.
 */
export async function remediateErasedContentEntry(service: ErasureService, graph: WorkActivationEnvironment,
  erasureId: string, relay: Relay = service.relay): Promise<SourceRemediationEntry> {
  const row = (await relay.query<JournalRow>(
    `SELECT ${JOURNAL_COLUMNS} FROM relay.erasure WHERE id = $1`, [erasureId])).rows[0];
  if (!row) throw new ErasureNotFound('erasure is unavailable');
  return remediateEntry(service, graph, row, relay);
}

/**
 * The original requester's same-key replay also reaches an old completed entry. A source that
 * could not be cleared is never reported as success: the existing typed refusal is raised and
 * the committed journal entry stays exactly as it was, so the same call can be retried.
 */
async function reapplyForReplay(service: ErasureService, graph: WorkActivationEnvironment,
  erasureId: string): Promise<void> {
  const entry = await remediateErasedContentEntry(service, graph, erasureId);
  switch (entry.outcome) {
    case 'held': throw new ContentErasureStale('Content erasure is deferred');
    case 'stale': case 'unapplied':
      throw new ContentErasureStale('Content revision is no longer available to erase');
    case 'native': case 'graph-limit':
      throw new GraphErasureUnavailable('exact graph suppression proof is unavailable');
    case 'malformed': throw new ErasureInvalid('erasure targets are unavailable or invalid');
    case 'failed': throw new ErasureUnavailable('Content sources remain after erasure');
    default: // cleared, clean, pending (finished above), blocked, foreign
  }
}
