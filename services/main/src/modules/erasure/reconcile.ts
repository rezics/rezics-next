import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { openRecoveryPayload } from '../../../../account/src/recovery-envelope.ts';
import { eraseLibraryImportsForPrincipals } from '../library-import/privacy.ts';
import type { ObjectRecoveryStore } from '../owner/object-coverage.ts';
import { readRestoredGraphReleaseProof, type RestoredGraphReleaseExpectation,
  type RestoredGraphReleaseProof, type RecoveryCoverage } from '../work/restore-lineage.ts';
import { lockAccessRecoveryFenceForRelease, releaseAccessRecoveryFence } from '../access/admission.ts';
import { AccountDeletionJournalConflict, assertAccountDeletionJournalCoverage } from
  '../outbox/account-deletion-journal.ts';
import type { OwnerReconciliationItemRow, OwnerReconciliationCutRow } from '../owner/schema.ts';
import { accountCredentialsPresent } from './account.ts';
import { postponeHeldMaterial } from '../public-report/preservation.ts';
import { assertRetainedAuthorityCoverage, type RetainedAuthorityCoverage } from './authority.ts';
import { applyContentErasure, ContentErasureGraphRequired, contentErasureResource,
  ContentErasureStale, openCommentSourceRevisions, probeContentErasure } from './content.ts';
import { assertReplayedCommentSourcesTerminal } from '../work/content-recovery-coverage.ts';
import { ErasureUnavailable, readErasure, relayTransaction, sha256 } from './journal.ts';
import { readGraphErasureProof, type GraphSuppressionProof, type HeldGraphErasureReplay } from './graph.ts';
import { assertGraphErasure, graphLineageSequence, replayGraphErasure } from './replay-graph.ts';
import { objectErasureAbsent, replayObjectErasure } from './replay-objects.ts';
import { publicationSupersessionsMatch } from './replay-supersessions.ts';
import { readRetainedNativeGraphSuppressionProof, restoredCustodyDigests,
  type RestoredGraphCustody } from './custody.ts';

/** The restored owners stay fenced: a later journal entry or authority fact is unreconciled. */
export class ErasureRestoreHold extends Error {}

const JOURNAL_PAGE = 100;

interface Item {
  owner: OwnerReconciliationItemRow['owner'];
  kind: OwnerReconciliationItemRow['item_kind'];
  ref: string;
  disposition: OwnerReconciliationItemRow['disposition'];
}

interface Cut {
  owner: OwnerReconciliationCutRow['owner'];
  dataEpoch: string | null;
  sequence: string | null;
  status: OwnerReconciliationCutRow['status'];
  digest: string;
}

const OPEN = new Set(['unavailable', 'corrupt', 'gap', 'conflict']);

function evidence(item: Item): string {
  return sha256(JSON.stringify([item.owner, item.kind, item.ref, item.disposition]));
}

function itemsDigest(items: readonly Item[]): string {
  return sha256(items.map(item => evidence(item)).join('\n'));
}

async function recordReconciliation(client: PoolClient, header: {
  operationId: string; requestDigest: string; kind: 'restore' | 'erasure'; scope: string;
  consumer: string | null; coverageGeneration: string | null; erasureEpoch: string | null;
  erasureId: string | null; holdReason: string | null; }, cuts: readonly Cut[],
items: readonly Item[]): Promise<string> {
  const id = randomUUID();
  const state = header.holdReason ? 'held' : 'reconciled';
  await client.query(`INSERT INTO relay.owner_reconciliation (id, operation_id, request_digest, kind,
      scope, consumer, coverage_generation, erasure_epoch, erasure_id, state, hold_reason,
      outcome_digest, completed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
      CASE WHEN $10 = 'reconciled' THEN clock_timestamp() END)`,
  [id, header.operationId, header.requestDigest, header.kind, header.scope, header.consumer,
    header.coverageGeneration, header.erasureEpoch, header.erasureId, state, header.holdReason,
    state === 'reconciled' ? itemsDigest(items) : null]);
  if (cuts.length) {
    await client.query(`INSERT INTO relay.owner_reconciliation_cut (reconciliation_id, owner, data_epoch,
        sequence, coverage_digest, status)
      SELECT $1, owner, data_epoch, sequence::numeric, digest, status
      FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
        AS c(owner, data_epoch, sequence, digest, status)`,
    [id, cuts.map(cut => cut.owner), cuts.map(cut => cut.dataEpoch), cuts.map(cut => cut.sequence),
      cuts.map(cut => cut.digest), cuts.map(cut => cut.status)]);
  }
  for (let offset = 0; offset < items.length; offset += 1000) {
    const page = items.slice(offset, offset + 1000);
    await client.query(`INSERT INTO relay.owner_reconciliation_item (reconciliation_id, ordinal, owner,
        item_kind, item_ref, disposition, evidence_digest)
      SELECT $1, $2 + ordinal, owner, kind, ref, disposition, digest
      FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
        WITH ORDINALITY AS i(owner, kind, ref, disposition, digest, ordinal)`,
    [id, offset, page.map(item => item.owner), page.map(item => item.kind), page.map(item => item.ref),
      page.map(item => item.disposition), page.map(item => evidence(item))]);
  }
  return id;
}

export interface ReconciliationSummary {
  reconciliationId: string;
  state: 'held' | 'reconciled';
  holdReason: string | null;
  erasureEpoch: string | null;
  coverageGeneration: string | null;
  counts: Record<string, number>;
}

async function summary(relay: Pool | PoolClient, operationId: string): Promise<ReconciliationSummary | null> {
  const row = (await relay.query<{ id: string; state: 'held' | 'reconciled'; hold_reason: string | null;
    erasure_epoch: string | null; coverage_generation: string | null }>(`SELECT id, state, hold_reason,
      erasure_epoch::text AS erasure_epoch, coverage_generation::text AS coverage_generation
    FROM relay.owner_reconciliation WHERE operation_id = $1`, [operationId])).rows[0];
  if (!row) return null;
  const counts = Object.fromEntries((await relay.query<{ disposition: string; count: string }>(
    `SELECT disposition, count(*)::text AS count FROM relay.owner_reconciliation_item
     WHERE reconciliation_id = $1 GROUP BY disposition`, [row.id])).rows
    .map(entry => [entry.disposition, Number(entry.count)]));
  return { reconciliationId: row.id, state: row.state, holdReason: row.hold_reason,
    erasureEpoch: row.erasure_epoch, coverageGeneration: row.coverage_generation, counts };
}

/**
 * Verify one suppressed erasure against its live owners: every exact target is
 * erased (or the Account credentials are absent and the Access principal fenced)
 * and every copy location reports a terminal or explicitly retained disposition.
 * Success advances the journal entry to verified; otherwise it stays unverified.
 */
export async function verifyErasure(relay: Pool, owners: { content?: Pool; account?: Pool;
  access?: Pool }, erasureId: string, operationId: string): Promise<ReconciliationSummary> {
  const prior = await summary(relay, operationId);
  if (prior) return prior;
  const report = await readErasure(relay, erasureId);
  if (report.suppression !== 'suppressed') throw new ErasureUnavailable('erasure is not suppressed');
  const items: Item[] = [];
  if (report.kind === 'account') {
    const header = (await relay.query<{ account_subject: string; deleted_principal_id: string | null }>(
      'SELECT account_subject, deleted_principal_id FROM relay.erasure WHERE id = $1', [erasureId])).rows[0]!;
    if (!owners.account || !owners.access) throw new ErasureUnavailable('Account and Access owners are required');
    const live = await accountCredentialsPresent(owners.account, [header.account_subject]);
    items.push({ owner: 'account', kind: 'erasure', ref: `account-subject:${sha256(header.account_subject)}`,
      disposition: live.size ? 'conflict' : 'erased' });
    if (header.deleted_principal_id) {
      const fenced = await owners.access.query<{ active: boolean }>(
        'SELECT active FROM access.principal WHERE id = $1', [header.deleted_principal_id]);
      items.push({ owner: 'access', kind: 'authority_fence', ref: `principal:${header.deleted_principal_id}`,
        disposition: fenced.rows[0]?.active === false ? 'matched' : 'conflict' });
    }
  } else {
    if (!owners.content) throw new ErasureUnavailable('Content owner is required');
    const targetRefs = report.targets.map(target => target.ref);
    const probes = await probeContentErasure(owners.content, erasureId, targetRefs);
    const openSources = new Set(await openCommentSourceRevisions(owners.content, targetRefs));
    for (const row of (await owners.content.query<{ revision_id: string }>(
      `SELECT revision_id::text FROM verification.open_evidence_source_revisions($1::uuid[])`,
      [report.targets.filter(target => target.kind === 'content_revision').map(target => target.ref)])).rows) {
      openSources.add(row.revision_id);
    }
    for (const target of report.targets) {
      items.push({ owner: 'content', kind: 'revision', ref: target.ref,
        disposition: probes.get(target.ref) === 'erased' && !openSources.has(target.ref)
          ? 'erased' : 'conflict' });
    }
  }
  for (const disposition of report.dispositions) {
    items.push({ owner: disposition.owner, kind: 'retention_pin', ref: disposition.domain,
      disposition: ['pending', 'blocked'].includes(disposition.destruction) ? 'conflict'
        : ['retained', 'unverified'].includes(disposition.destruction) ? 'preserved' : 'retired' });
  }
  if (!report.dispositions.length) {
    items.push({ owner: 'relay', kind: 'retention_pin', ref: 'inventory', disposition: 'gap' });
  }
  const open = items.filter(item => OPEN.has(item.disposition));
  await relayTransaction(relay, async client => {
    await recordReconciliation(client, { operationId, requestDigest: sha256(`${erasureId}\0verify`),
      kind: 'erasure', scope: `erasure:${erasureId}`, consumer: null, coverageGeneration: null,
      erasureEpoch: report.erasureEpoch, erasureId,
      holdReason: open.length ? `${open.length} erasure probes are unresolved` : null }, [], items);
    if (!open.length) {
      await client.query(`UPDATE relay.erasure SET stage = 'verified', verified_at = clock_timestamp()
        WHERE id = $1 AND stage IN ('inventory_complete', 'deleting', 'reconciling')
          AND destruction_status IN ('retained', 'destroyed')`, [erasureId]);
    }
  });
  return (await summary(relay, operationId))!;
}

export interface RestoredOwners {
  content: Pool; access: Pool; account: Pool;
  graph?: RestoredGraphCustody;
  objects?: ObjectRecoveryStore;
}

export interface BorrowedRestoreClients {
  relayClient: PoolClient;
  accessClient: PoolClient;
  /** Exact native expectation from the caller's durable qualified restore. */
  graphRelease?: RestoredGraphReleaseExpectation;
}

async function withRestoreClients<T>(relay: Pool, restored: RestoredOwners, borrowed: BorrowedRestoreClients | undefined,
  work: (clients: BorrowedRestoreClients, released?: RestoredGraphReleaseProof) => Promise<T>,
  release?: { graphRelease?: RestoredGraphReleaseExpectation; fenceGeneration: string }): Promise<T> {
  return relayTransaction(relay, async relayClient => {
    const isolation = (await relayClient.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation;
    if (isolation !== 'read committed') throw new ErasureRestoreHold('retained relay needs a fresh READ COMMITTED view');
    const before = (await relayClient.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]!.id;
    await relayClient.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
    if ((await relayClient.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]!.id !== before) {
      throw new ErasureRestoreHold('retained relay transaction is not held');
    }
    const accessClient = borrowed?.accessClient ?? await restored.access.connect();
    try {
      if (!borrowed) {
        await accessClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await accessClient.query("SET LOCAL lock_timeout = '2s'");
        await accessClient.query("SET LOCAL statement_timeout = '5s'");
      }
      const accessBefore = (await accessClient.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]!.id;
      const fence = (await accessClient.query<{ open: boolean; generation: string }>(
        'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true FOR UPDATE')).rows[0];
      if ((await accessClient.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]!.id !== accessBefore) {
        throw new ErasureRestoreHold('restored Access transaction is not held');
      }
      const graph = restored.graph, held = graph?.heldErasure;
      let released: RestoredGraphReleaseProof | undefined;
      if (release?.graphRelease) {
        if (!graph || !held || release.fenceGeneration !== held.accessHoldGeneration) {
          throw new ErasureRestoreHold('released graph requires its captured erasure generation');
        }
        const expected = release.graphRelease;
        if (expected.lineage.dataEpoch !== graph.lineage.dataEpoch
          || expected.lineage.routingEpoch !== graph.lineage.routingEpoch
          || expected.restoreCutover !== held.cut.restoreCutover
          || expected.saved.dataEpoch !== held.cut.priorDataEpoch
          || expected.saved.graphSequence !== held.cut.priorSequence) {
          throw new ErasureRestoreHold('native release expectation differs from the captured restore');
        }
        released = await readRestoredGraphReleaseProof(graph.fuseki, expected) ?? undefined;
      }
      const generation = release?.graphRelease ? release.fenceGeneration : held?.accessHoldGeneration;
      if (!fence || (fence.open === true
        ? !released || fence.generation !== (BigInt(release!.fenceGeneration) + 1n).toString()
        : fence.open !== false || generation !== undefined && fence.generation !== generation)) {
        throw new ErasureRestoreHold('restored Access recovery generation changed');
      }
      // Open-owner retries must observe changes committed before this fence
      // lock. A pre-lock repeatable-read snapshot cannot prove current authority.
      if (fence.open && (await accessClient.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation
        !== 'read committed') {
        throw new ErasureRestoreHold('released Access needs a fresh READ COMMITTED view');
      }
      if (graph && held && (fence.generation !== held.accessHoldGeneration && !released
        || !released && await graphLineageSequence(graph.fuseki, graph.lineage, held.cut) !== '0')) {
        throw new ErasureRestoreHold('captured Access generation or held graph cut changed');
      }
      const result = await work({ relayClient, accessClient }, released);
      if (!borrowed) await accessClient.query('COMMIT');
      return result;
    } catch (error) {
      if (!borrowed) await accessClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { if (!borrowed) accessClient.release(); }
  }, borrowed?.relayClient);
}

async function heldErasureReplay(restored: RestoredOwners, clients: BorrowedRestoreClients,
  erasureId: string, epoch: string, revisionIds: readonly string[]): Promise<
    (HeldGraphErasureReplay & { originalEvidenceDigest: string }) | undefined> {
  const graph = restored.graph, config = graph?.heldErasure;
  if (!graph || !config) return undefined;
  if (config.cut.dataEpoch !== graph.lineage.dataEpoch || config.cut.routingEpoch !== graph.lineage.routingEpoch) {
    throw new ErasureRestoreHold('exact held graph cut is required');
  }
  const readOriginal = async () => {
    if (config.originalSource === 'retained-native-event') {
      return readRetainedNativeGraphSuppressionProof(clients.relayClient, erasureId, epoch, revisionIds);
    }
    if (config.originalSource !== 'original-graph' || config.originalGraph.fuseki === graph.fuseki
      || config.originalGraph.lineage.dataEpoch === graph.lineage.dataEpoch) {
      throw new ErasureRestoreHold('independent original suppression source is required');
    }
    const proof = await readGraphErasureProof(config.originalGraph.fuseki,
      config.originalGraph.lineage, erasureId, epoch, revisionIds);
    return { original: proof, evidenceDigest: sha256(JSON.stringify([proof.receipt, proof.dataEpoch, proof.sequence])) };
  };
  const retained = await readOriginal(), original = retained.original;
  if (original.dataEpoch === graph.lineage.dataEpoch) {
    throw new ErasureRestoreHold('original suppression proof belongs to the restored graph');
  }
  const held = { cut: config.cut, accessHoldGeneration: config.accessHoldGeneration,
    originalEvidenceDigest: retained.evidenceDigest,
    signingKey: config.signingKey, maintenance: config.maintenance, revisionIds, original,
    assertCurrent: async (request: Parameters<HeldGraphErasureReplay['assertCurrent']>[0]) => {
      if (request.erasureId !== erasureId || request.epoch !== epoch
        || request.cut.dataEpoch !== held.cut.dataEpoch || request.cut.routingEpoch !== held.cut.routingEpoch
        || request.cut.restoreCutover !== held.cut.restoreCutover
        || request.cut.priorDataEpoch !== held.cut.priorDataEpoch || request.cut.priorSequence !== held.cut.priorSequence
        || request.accessHoldGeneration !== held.accessHoldGeneration
        || !sameTargets(request.revisionIds, revisionIds)
        || !sameProof(request.original, original)) {
        throw new ErasureRestoreHold('held erasure authorization differs from its current entry');
      }
      const report = await readErasure(clients.relayClient, erasureId);
      if (report.kind === 'account' || report.erasureEpoch !== epoch || report.suppression !== 'suppressed'
        || !sameTargets(report.targets.filter(target => target.owner === 'content'
          && target.kind === 'content_revision').map(target => target.ref), revisionIds)) {
        throw new ErasureRestoreHold('held erasure differs from the retained current journal');
      }
      const current = await readOriginal();
      if (!sameProof(current.original, original) || current.evidenceDigest !== retained.evidenceDigest) {
        throw new ErasureRestoreHold('original suppression proof changed');
      }
      const fence = (await clients.accessClient.query<{ open: boolean; generation: string }>(
        'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true FOR UPDATE')).rows[0];
      if (fence?.open !== false || fence.generation !== held.accessHoldGeneration
        || await graphLineageSequence(graph.fuseki, graph.lineage, held.cut) !== '0') {
        throw new ErasureRestoreHold('held erasure owner generation or graph cut changed');
      }
    } };
  return held;
}

function sameTargets(left: readonly string[], right: readonly string[]): boolean {
  const sorted = [...right].sort();
  return left.length === right.length && new Set(left).size === left.length
    && [...left].sort().every((value, index) => value === sorted[index]);
}

function sameProof(left: GraphSuppressionProof, right: GraphSuppressionProof): boolean {
  return left.receipt === right.receipt && left.dataEpoch === right.dataEpoch && left.sequence === right.sequence;
}

function restoreRequestDigest(consumer: string, replay: boolean,
  authority: RetainedAuthorityCoverage): string {
  return sha256(`${consumer}\0${replay}\0${sha256(authority.sealedCoverage)}`);
}

function graphRestoreBinding(restored: RestoredOwners): Item | null {
  const graph = restored.graph;
  if (!graph) return null;
  const held = graph.heldErasure;
  return { owner: 'graph', kind: 'authority_fence', disposition: 'matched',
    ref: `restored-graph-binding:${sha256(JSON.stringify([graph.lineage.dataEpoch, graph.lineage.routingEpoch,
      held ? [held.cut.dataEpoch, held.cut.routingEpoch, held.cut.restoreCutover,
        held.cut.priorDataEpoch, held.cut.priorSequence, held.accessHoldGeneration, held.originalSource,
        held.originalSource === 'original-graph'
          ? [held.originalGraph.lineage.dataEpoch, held.originalGraph.lineage.routingEpoch] : null] : null]))}` };
}

function originalEvidenceItem(erasureId: string, epoch: string, revisionIds: readonly string[],
  held: HeldGraphErasureReplay & { originalEvidenceDigest: string }): Item {
  return { owner: 'graph', kind: 'receipt', disposition: 'matched',
    ref: `original-erasure:${erasureId}:${sha256(JSON.stringify([epoch, [...revisionIds].sort(),
      [held.original.receipt, held.original.dataEpoch, held.original.sequence], held.originalEvidenceDigest]))}` };
}

function custodyEvidenceItem(digests: ReadonlySet<string>): Item {
  return { owner: 'object', kind: 'receipt', disposition: 'matched',
    ref: `retained-custody-roots:${sha256(JSON.stringify([...digests].sort()))}` };
}

function reconciliationIdentityItem(record: { operationId: string; requestDigest: string;
  consumer: string; coverageGeneration: string | null; erasureEpoch: string | null }): Item {
  return { owner: 'relay', kind: 'receipt', disposition: 'matched',
    ref: `restore-reconciliation:${sha256(JSON.stringify([record.operationId, record.requestDigest,
      record.consumer, record.coverageGeneration, record.erasureEpoch]))}` };
}

async function journalFrontier(relay: Pool | PoolClient, consumer: string) {
  const head = (await relay.query<{ generation: string; erasure_epoch: string | null;
    coverage_digest: string; captured_at: string }>(
    `SELECT generation::text AS generation, erasure_epoch::text AS erasure_epoch, coverage_digest,
       extract(epoch FROM captured_at)::text AS captured_at
     FROM relay.recovery_coverage_head WHERE consumer = $1 FOR SHARE`, [consumer])).rows[0] ?? null;
  const journal = (await relay.query<{ epoch: string | null }>(
    'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure')).rows[0]!.epoch;
  return { head, journal };
}

/** Bind the retained intent and exact target inventory, including older entries.
 * Mutable copy-retirement inventory is independently owned and is not a release
 * authorization. Pages and each journal entry's target set have schema bounds. */
async function journalEvidenceDigest(relay: PoolClient, consumer: string): Promise<string> {
  const { head, journal } = await journalFrontier(relay, consumer);
  const hash = createHash('sha256').update(JSON.stringify([consumer, head, journal]));
  let after = '0';
  for (;;) {
    const entries = (await relay.query<{ epoch: string; facts: unknown }>(`SELECT
      e.erasure_epoch::text AS epoch, jsonb_build_array(e.id, e.erasure_epoch::text,
        e.operation_id, e.request_digest, e.kind, e.authority, e.principal_id,
        e.admission_id, e.authority_epoch::text, e.account_issuer, e.account_subject, e.deleted_principal_id,
        e.suppression_status, extract(epoch FROM e.requested_at)::text,
        extract(epoch FROM e.suppressed_at)::text,
        COALESCE((SELECT jsonb_agg(jsonb_build_array(t.ordinal, t.owner, t.target_kind, t.target_ref)
          ORDER BY t.ordinal) FROM relay.erasure_target t WHERE t.erasure_id = e.id), '[]'::jsonb)) AS facts
      FROM relay.erasure e WHERE e.erasure_epoch > $1::bigint
      ORDER BY e.erasure_epoch LIMIT ${JOURNAL_PAGE}`, [after])).rows;
    for (const entry of entries) hash.update('\n').update(JSON.stringify(entry.facts));
    if (entries.length < JOURNAL_PAGE) return hash.digest('hex');
    after = entries[entries.length - 1]!.epoch;
  }
}

async function requireRecordedItem(relay: PoolClient, id: string, item: Item): Promise<void> {
  const row = (await relay.query<{ disposition: string; evidence_digest: string }>(`SELECT disposition,
    evidence_digest FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1
      AND owner = $2 AND item_kind = $3 AND item_ref = $4`, [id, item.owner, item.kind, item.ref])).rows[0];
  if (row?.disposition !== item.disposition || row.evidence_digest !== evidence(item)) {
    throw new ErasureRestoreHold('prior reconciliation evidence differs from the current restore');
  }
}

/** Authenticate the complete existing immutable outcome, not merely its state
 * or a cached summary. The retained operation is never created by release. */
async function authenticateRestoreReconciliation(relay: PoolClient, restored: RestoredOwners,
  accessClient: PoolClient, id: string, fenceGeneration: string, authority: RetainedAuthorityCoverage,
  released?: RestoredGraphReleaseProof): Promise<void> {
  const record = (await relay.query<{ operation_id: string; kind: string; scope: string; state: string;
    hold_reason: string | null; consumer: string | null; coverage_generation: string;
    erasure_epoch: string | null; request_digest: string; outcome_digest: string; completed_at: Date | null }>(
    `SELECT operation_id, kind, scope, state, hold_reason, consumer, coverage_generation::text,
      erasure_epoch::text, request_digest, outcome_digest, completed_at
     FROM relay.owner_reconciliation WHERE id = $1 AND erasure_id IS NULL AND relocation_id IS NULL
       AND format_from IS NULL AND format_to IS NULL FOR SHARE`, [id])).rows[0];
  if (!record || record.kind !== 'restore' || record.state !== 'reconciled' || !record.consumer
    || !record.operation_id.endsWith(':erasures') || record.scope !== `restore:${record.consumer}`
    || record.hold_reason !== null || record.completed_at === null
    || !/^[0-9a-f]{64}$/.test(record.outcome_digest)) {
    throw new ErasureRestoreHold('restore is not reconciled with the retained journal');
  }
  if (![false, true].some(replay => restoreRequestDigest(record.consumer!, replay, authority) === record.request_digest)) {
    throw new ErasureRestoreHold('restore authority capture differs from reconciliation');
  }
  const { head, journal } = await journalFrontier(relay, record.consumer);
  if (!head || head.generation !== record.coverage_generation || journal !== record.erasure_epoch) {
    throw new ErasureRestoreHold('a newer retained frontier needs reconciliation');
  }
  const cuts = (await relay.query<{ owner: Cut['owner']; data_epoch: string | null; sequence: string | null;
    status: string; coverage_digest: string; cluster_id: string | null; wal_lsn: string | null;
    format_version: string | null }>(`SELECT owner, data_epoch, sequence::text,
      status, coverage_digest, cluster_id, wal_lsn::text, format_version FROM relay.owner_reconciliation_cut
      WHERE reconciliation_id = $1 ORDER BY owner LIMIT 8`, [id])).rows;
  const owners = ['account', 'access', 'content', 'graph', 'object', 'relay'];
  if (cuts.length !== owners.length || cuts.some(cut => !owners.includes(cut.owner) || cut.status !== 'matched'
    || cut.cluster_id !== null || cut.wal_lsn !== null || cut.format_version !== null)) {
    throw new ErasureRestoreHold('prior reconciliation owner cuts are incomplete');
  }
  const outcome = createHash('sha256'), ownerHashes = new Map<string, ReturnType<typeof createHash>>();
  let after = 0;
  for (;;) {
    const items = (await relay.query<{ ordinal: number; owner: Item['owner']; item_kind: Item['kind'];
      item_ref: string; disposition: Item['disposition']; evidence_digest: string }>(`SELECT ordinal,
        owner, item_kind, item_ref, disposition, evidence_digest FROM relay.owner_reconciliation_item
      WHERE reconciliation_id = $1 AND ordinal > $2 ORDER BY ordinal LIMIT 1000`, [id, after])).rows;
    for (const item of items) {
      const digest = evidence({ owner: item.owner, kind: item.item_kind, ref: item.item_ref,
        disposition: item.disposition });
      if (item.ordinal !== after + 1 || !['matched', 'erased', 'replayed'].includes(item.disposition)
        || item.evidence_digest !== digest || !owners.includes(item.owner)) {
        throw new ErasureRestoreHold('prior reconciliation findings are incomplete or divergent');
      }
      if (after) outcome.update('\n');
      outcome.update(digest);
      const own = ownerHashes.get(item.owner);
      if (own) own.update('\n').update(digest);
      else ownerHashes.set(item.owner, createHash('sha256').update(digest));
      after = item.ordinal;
    }
    if (items.length < 1000) break;
  }
  if (outcome.digest('hex') !== record.outcome_digest) {
    throw new ErasureRestoreHold('prior reconciliation outcome differs from its findings');
  }
  for (const cut of cuts) {
    const expected = cut.owner === 'relay' ? await journalEvidenceDigest(relay, record.consumer)
      : (ownerHashes.get(cut.owner) ?? createHash('sha256')).digest('hex');
    if (cut.coverage_digest !== expected) {
      throw new ErasureRestoreHold('prior reconciliation owner evidence differs from its cut');
    }
    if (!['content', 'graph'].includes(cut.owner) && (cut.data_epoch !== null || cut.sequence !== null)) {
      throw new ErasureRestoreHold('prior reconciliation owner position differs');
    }
  }
  const control = (await restored.content.query<{ data_epoch: string; sequence: string }>(
    'SELECT data_epoch::text AS data_epoch, sequence::text AS sequence FROM content.owner_control')).rows[0];
  const content = cuts.find(cut => cut.owner === 'content')!, graph = cuts.find(cut => cut.owner === 'graph')!;
  if (control?.data_epoch !== content.data_epoch || control?.sequence !== content.sequence
    || graph.data_epoch !== restored.graph?.lineage.dataEpoch) {
    throw new ErasureRestoreHold('prior reconciliation belongs to another restored owner cut');
  }
  if (graph.sequence !== await graphLineageSequence(restored.graph!.fuseki,
    restored.graph!.lineage, released?.expectation ?? restored.graph!.heldErasure?.cut)) {
    throw new ErasureRestoreHold('prior reconciliation graph position changed');
  }
  await requireRecordedItem(relay, id, { owner: 'access', kind: 'authority_fence',
    ref: `restore-access-generation:${fenceGeneration}`, disposition: 'matched' });
  await requireRecordedItem(relay, id, reconciliationIdentityItem({ operationId: record.operation_id,
    requestDigest: record.request_digest, consumer: record.consumer,
    coverageGeneration: record.coverage_generation, erasureEpoch: record.erasure_epoch }));
  await requireRecordedItem(relay, id, graphRestoreBinding(restored)!);
  try { await assertRetainedAuthorityCoverage(relay, restored.access, record.consumer, authority, accessClient,
    released ? { graphRelease: released.expectation, fuseki: restored.graph!.fuseki,
      capturedGeneration: fenceGeneration } : undefined); }
  catch (error) { throw new ErasureRestoreHold('restored Access differs from current retained authority', { cause: error }); }
}

/** Record the journal epoch a quiesced capture covered on the retained coverage head. */
export async function retainErasureCoverage(relay: Pool, consumer: string): Promise<string | null> {
  const row = (await relay.query<{ erasure_epoch: string | null }>(`UPDATE relay.recovery_coverage_head
    SET erasure_epoch = (SELECT max(erasure_epoch) FROM relay.erasure)
    WHERE consumer = $1 RETURNING erasure_epoch::text AS erasure_epoch`, [consumer])).rows[0];
  if (!row) throw new ErasureUnavailable('retained recovery coverage head is unavailable');
  return row.erasure_epoch;
}

/**
 * Compare an isolated restored owner set with the retained erasure and Account
 * deletion journals. Suppressed Content and graph erasures and exact object
 * targets the restore lacks are replayed only when `replay` is set. Restored
 * credentials of an erased Account, unresolved journal entries, a missing
 * coverage head or differing Access authority/deletion evidence keep the restore
 * held. Work is O(journal targets + Access rows + Access outbox rows + referenced
 * graph manifests); each graph write is bounded to 64 targets and 64 units.
 * The existing sealed graph/object restore checks must validate the base cut
 * before replay mutates it; this verifies its remaining exact custody at release.
 */
export async function reconcileRestoredErasures(relay: Pool, restored: RestoredOwners, input: {
  operationId: string; consumer: string; replay: boolean;
  authority: RetainedAuthorityCoverage }, clients?: BorrowedRestoreClients): Promise<ReconciliationSummary> {
  return withRestoreClients(relay, restored, clients, async ({ relayClient, accessClient }) => {
  const operationId = input.operationId.endsWith(':erasures') ? input.operationId : `${input.operationId}:erasures`;
  if (!input.operationId || operationId.length > 200) throw new ErasureRestoreHold('erasure reconciliation identity is invalid');
  const prior = await summary(relayClient, operationId);
  const requestDigest = restoreRequestDigest(input.consumer, input.replay, input.authority);
  if (prior) {
    const recorded = (await relayClient.query<{ request_digest: string }>(
      'SELECT request_digest FROM relay.owner_reconciliation WHERE operation_id = $1',
      [operationId])).rows[0];
    if (recorded?.request_digest !== requestDigest) {
      throw new ErasureRestoreHold('restore operation binds another authority capture');
    }
    return prior;
  }
  const { head, journal } = await journalFrontier(relayClient, input.consumer);
  const content: Item[] = [];
  const graph: Item[] = [];
  const objects: Item[] = [];
  let protectedDigests: Set<string> | null = null;
  const custody: Item = { owner: 'object', kind: 'payload',
    ref: 'retained-command-model-custody', disposition: 'conflict' };
  if (restored.graph && restored.objects) {
    try {
      protectedDigests = await restoredCustodyDigests(restored.access, restored.graph, restored.objects, accessClient);
      custody.disposition = 'matched';
    } catch { /* missing or divergent originals keep the whole restored owner held */ }
  }
  objects.push(custody);
  if (protectedDigests) objects.push(custodyEvidenceItem(protectedDigests));
  const graphBinding = graphRestoreBinding(restored);
  if (graphBinding) graph.push(graphBinding);
  const fenceGeneration = (await accessClient.query<{ generation: string }>(
    'SELECT generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0]!.generation;
  const accessGeneration: Item = { owner: 'access', kind: 'authority_fence',
    ref: `restore-access-generation:${fenceGeneration}`, disposition: 'matched' };
  let currentAuthority: Item = { owner: 'access', kind: 'authority_fence',
    ref: 'current-retained-authority-coverage', disposition: 'matched' };
  try { await assertRetainedAuthorityCoverage(relayClient, restored.access, input.consumer, input.authority, accessClient); }
  catch { currentAuthority = { ...currentAuthority, disposition: 'conflict' }; }
  const replayAllowed = input.replay && custody.disposition === 'matched' && currentAuthority.disposition === 'matched';
  let after = '0';
  while (true) {
    const entries = (await relayClient.query<{ id: string; epoch: string;
      suppression_status: string; refs: string[] }>(`SELECT e.id, e.erasure_epoch::text AS epoch,
        e.suppression_status, array_agg(t.target_ref ORDER BY t.ordinal) AS refs
      FROM relay.erasure e JOIN relay.erasure_target t ON t.erasure_id = e.id
        AND t.owner = 'content' AND t.target_kind = 'content_revision'
      WHERE e.erasure_epoch > $1::bigint GROUP BY e.id ORDER BY e.erasure_epoch LIMIT ${JOURNAL_PAGE}`,
    [after])).rows;
    for (const entry of entries) {
      if (entry.suppression_status !== 'suppressed') {
        content.push({ owner: 'content', kind: 'erasure', ref: entry.id, disposition: 'conflict' });
        continue;
      }
      const probes = await probeContentErasure(restored.content, entry.id, entry.refs);
      const openSources = new Set(await openCommentSourceRevisions(restored.content, entry.refs));
      for (const row of (await restored.content.query<{ revision_id: string }>(
        `SELECT revision_id::text FROM verification.open_evidence_source_revisions($1::uuid[])`,
        [entry.refs])).rows) {
        openSources.add(row.revision_id);
      }
      const replayIds = entry.refs.filter(ref => probes.get(ref) === 'available'
        || (probes.get(ref) === 'erased' && openSources.has(ref)));
      if (replayIds.length && await postponeHeldMaterial(accessClient,
        await contentErasureResource(restored.content, replayIds), entry.id)) {
        for (const ref of entry.refs) {
          const open = openSources.has(ref);
          content.push({ owner: 'content', kind: 'revision', ref,
            disposition: ['erased', 'absent'].includes(probes.get(ref) ?? '') && !open
              ? 'erased' : 'conflict' });
        }
        if (restored.graph) graph.push({ owner: 'graph', kind: 'erasure', ref: entry.id, disposition: 'conflict' });
        continue;
      }
      let graphProof: GraphSuppressionProof | null = null;
      if (restored.graph) {
        let disposition: Item['disposition'] = 'conflict';
        try {
          if (entry.refs.length <= 64) {
            const held = await heldErasureReplay(restored, { relayClient, accessClient },
              entry.id, entry.epoch, entry.refs);
            disposition = await replayGraphErasure(restored.graph.fuseki, restored.graph.lineage,
              entry.id, entry.epoch, entry.refs, replayAllowed, held);
            if (disposition === 'erased' || disposition === 'replayed') {
              graphProof = await readGraphErasureProof(restored.graph.fuseki,
                restored.graph.lineage, entry.id, entry.epoch, entry.refs, held);
              if (held) graph.push(originalEvidenceItem(entry.id, entry.epoch, entry.refs, held));
            }
          }
        } catch { disposition = 'conflict'; }
        graph.push({ owner: 'graph', kind: 'erasure', ref: entry.id, disposition });
      }
      let replayed = false;
      if (replayIds.length && replayAllowed) {
        try {
          await applyContentErasure(restored.content, { erasureId: entry.id, erasureEpoch: entry.epoch,
            resourceId: await contentErasureResource(restored.content, replayIds),
            revisionIds: replayIds, preservationAccess: accessClient, ...(graphProof ? { graphProof } : {}) });
          replayed = true;
        } catch (error) {
          if (!(error instanceof ContentErasureGraphRequired || error instanceof ContentErasureStale)) throw error;
        }
      }
      for (const ref of entry.refs) {
        const probe = probes.get(ref);
        const open = openSources.has(ref);
        content.push({ owner: 'content', kind: 'revision', ref,
          disposition: (probe === 'erased' || probe === 'absent') && !open ? 'erased'
            : (probe === 'available' || open) && replayed ? 'replayed' : 'conflict' });
      }
      if (!await publicationSupersessionsMatch(restored.content, entry.refs,
        entry.id, entry.epoch, graphProof)) {
        content.push({ owner: 'content', kind: 'retention_pin',
          ref: `publication:${entry.id}`, disposition: 'conflict' });
      }
    }
    if (entries.length < JOURNAL_PAGE) break;
    after = entries[entries.length - 1]!.epoch;
  }
  // Explicit object targets are exact digests. Other non-Content target families
  // remain held until their own owner supplies a replay and release proof.
  after = '0';
  while (true) {
    const entries = (await relayClient.query<{ id: string; epoch: string }>(
      `SELECT e.id, e.erasure_epoch::text AS epoch FROM relay.erasure e
       WHERE e.kind <> 'account' AND e.erasure_epoch > $1::bigint
         AND (NOT EXISTS (SELECT 1 FROM relay.erasure_target t
              WHERE t.erasure_id = e.id AND t.owner = 'content'
                AND t.target_kind = 'content_revision')
           OR EXISTS (SELECT 1 FROM relay.erasure_target t
              WHERE t.erasure_id = e.id AND NOT (t.owner = 'content'
                AND t.target_kind = 'content_revision')))
       ORDER BY e.erasure_epoch LIMIT ${JOURNAL_PAGE}`, [after])).rows;
    for (const entry of entries) {
      const report = await readErasure(relayClient, entry.id);
      const foreign = report.targets.filter(target => !(target.owner === 'content'
        && target.kind === 'content_revision') && !(target.owner === 'object' && target.kind === 'object'));
      if (!report.targets.some(target => target.owner === 'content' && target.kind === 'content_revision')
        && !report.targets.some(target => target.owner === 'object')) {
        content.push({ owner: 'relay', kind: 'erasure', ref: entry.id, disposition: 'conflict' });
      }
      for (const target of foreign) {
        const finding: Item = { owner: target.owner as Item['owner'], kind: 'erasure', ref: target.ref,
          disposition: 'conflict' };
        if (target.owner === 'content') content.push(finding);
        else graph.push(finding);
      }
      for (const target of report.targets.filter(target => target.owner === 'object')) {
        let disposition: Item['disposition'] = 'conflict';
        if (report.suppression === 'suppressed' && restored.objects && restored.graph
          && protectedDigests) {
          try { disposition = await replayObjectErasure(restored.objects, target.ref,
            protectedDigests, replayAllowed); }
          catch { /* malformed or unavailable target keeps the restore held */ }
        }
        objects.push({ owner: 'object', kind: 'erasure', ref: target.ref, disposition });
      }
    }
    if (entries.length < JOURNAL_PAGE) break;
    after = entries[entries.length - 1]!.epoch;
  }
  const account: Item[] = [];
  after = '0';
  while (true) {
    const entries = (await relayClient.query<{ epoch: string; account_subject: string;
      suppression_status: string }>(
      `SELECT erasure_epoch::text AS epoch, account_subject, suppression_status FROM relay.erasure
       WHERE kind = 'account' AND erasure_epoch > $1::bigint ORDER BY erasure_epoch LIMIT 1000`,
      [after])).rows;
    const present = await accountCredentialsPresent(restored.account,
      entries.map(entry => entry.account_subject));
    for (const entry of entries) {
      account.push({ owner: 'account', kind: 'erasure', ref: `account-subject:${sha256(entry.account_subject)}`,
        disposition: entry.suppression_status !== 'suppressed' || present.has(entry.account_subject)
          ? 'conflict' : 'erased' });
    }
    if (entries.length < 1000) break;
    after = entries[entries.length - 1]!.epoch;
  }
  let authority: Item = { owner: 'access', kind: 'deletion_intent', ref: 'account-deletion-journal',
    disposition: 'matched' };
  try { await assertAccountDeletionJournalCoverage(restored.access, relay, accessClient, relayClient); }
  catch (error) {
    if (!(error instanceof AccountDeletionJournalConflict)) throw error;
    authority = { ...authority, disposition: 'conflict' };
  }
  let graphSequence: string | null = null;
  if (restored.graph) {
    try { graphSequence = await graphLineageSequence(restored.graph.fuseki, restored.graph.lineage,
      restored.graph.heldErasure?.cut); }
    catch { /* an unavailable graph cannot be released */ }
    if (graphSequence === null) graph.push({ owner: 'graph', kind: 'authority_fence',
      ref: 'restored-graph-lineage', disposition: 'conflict' });
  }
  const accessItems = [authority, currentAuthority, accessGeneration];
  const items = [...content, ...graph, ...objects, ...account, ...accessItems,
    reconciliationIdentityItem({ operationId, requestDigest, consumer: input.consumer,
      coverageGeneration: head?.generation ?? null, erasureEpoch: journal })];
  const open = items.filter(item => OPEN.has(item.disposition));
  const holdReason = !head ? 'no retained recovery coverage head'
    : custody.disposition !== 'matched' ? 'restored command or model custody is unavailable or divergent'
      : open.length ? `${open.length} journal items are unresolved in the restore` : null;
  const control = (await restored.content.query<{ data_epoch: string; sequence: string }>(
    'SELECT data_epoch::text AS data_epoch, sequence::text AS sequence FROM content.owner_control')).rows[0];
  const status = (subset: readonly Item[]): Cut['status'] =>
    subset.some(item => !['erased', 'matched', 'replayed'].includes(item.disposition)) ? 'behind' : 'matched';
  const cuts: Cut[] = [
    { owner: 'content', dataEpoch: control?.data_epoch ?? null, sequence: control?.sequence ?? null,
      status: status(content), digest: itemsDigest(content) },
    { owner: 'account', dataEpoch: null, sequence: null, status: status(account), digest: itemsDigest(account) },
    ...(restored.graph ? [{ owner: 'graph' as const,
      dataEpoch: graphSequence === null ? null : restored.graph.lineage.dataEpoch,
      sequence: graphSequence, status: status(graph), digest: itemsDigest(graph) }] : []),
    { owner: 'object', dataEpoch: null, sequence: null,
      status: status(objects), digest: itemsDigest(objects) },
    { owner: 'access', dataEpoch: null, sequence: null, status: status(accessItems),
      digest: itemsDigest(accessItems) },
    { owner: 'relay', dataEpoch: null, sequence: null, status: head ? 'matched' : 'missing',
      digest: await journalEvidenceDigest(relayClient, input.consumer) },
  ];
  await recordReconciliation(relayClient, {
    operationId, requestDigest,
    kind: 'restore', scope: `restore:${input.consumer}`, consumer: input.consumer,
    coverageGeneration: head?.generation ?? null, erasureEpoch: journal, erasureId: null, holdReason },
  cuts, items);
  return (await summary(relayClient, operationId))!;
  });
}

/** After native release, verify the existing erased Library closure without
 * replaying cleanup against an already-open owner copy. */
async function assertErasedLibraryImportsAbsent(content: Pool, access: PoolClient, principals: string[]): Promise<void> {
  let after = '';
  for (;;) {
    const agents = (await access.query<{ agent_id: string }>(`SELECT DISTINCT a.agent_id FROM access.agent_provision a
      JOIN access.principal p ON p.id = a.principal_id WHERE a.principal_id = ANY($1::uuid[])
      AND a.agent_kind = 'person' AND NOT p.active
      AND EXISTS (SELECT 1 FROM access.outbox o WHERE o.principal_id = p.id AND o.kind = 'account.deletion_fenced')
      AND a.agent_id > $2 ORDER BY a.agent_id LIMIT 100`, [principals, after])).rows;
    if (agents.length) {
      const tables = ['library_import_file', 'library_import_source', 'library_import_session_effect', 'library_import_upload_command',
        'library_import_review_command', 'library_import_step', 'library_import_row_outcome', 'library_import_batch',
        'library_import_placement', 'library_import_daily_budget', 'library_copy', 'library_copy_loan_command'];
      const remaining = await content.query(tables.map(table =>
        `SELECT 1 FROM reader.${table} WHERE agent = ANY($1::text[])`).join(' UNION ALL ') + ' LIMIT 1',
      [agents.map(agent => agent.agent_id)]);
      if (remaining.rowCount !== 0) throw new ErasureRestoreHold('restored Library still has erased principal data');
      after = agents[agents.length - 1]!.agent_id;
    }
    if (agents.length < 100) return;
  }
}

/** Recheck the live restored copies immediately before releasing their Access fence. */
async function assertRestoredErasuresCurrent(relay: PoolClient, restored: RestoredOwners,
  accessClient: PoolClient, reconciliationId: string, released?: RestoredGraphReleaseProof): Promise<void> {
  if (!restored.graph || !restored.objects) {
    throw new ErasureRestoreHold('restored graph and exact object custody are required');
  }
  let protectedDigests: Set<string>;
  try { protectedDigests = await restoredCustodyDigests(restored.access, restored.graph, restored.objects, accessClient); }
  catch { throw new ErasureRestoreHold('restored command or model custody is unavailable or divergent'); }
  await requireRecordedItem(relay, reconciliationId, custodyEvidenceItem(protectedDigests));
  const unresolved = await relay.query(`SELECT 1 FROM relay.erasure
    WHERE suppression_status <> 'suppressed' LIMIT 1`);
  if (unresolved.rowCount) throw new ErasureRestoreHold('an erasure is not suppressed');
  const unsupported = await relay.query(`SELECT 1 FROM relay.erasure e
    WHERE e.kind <> 'account' AND (NOT EXISTS (SELECT 1 FROM relay.erasure_target t
      WHERE t.erasure_id = e.id) OR EXISTS (SELECT 1 FROM relay.erasure_target t
      WHERE t.erasure_id = e.id AND NOT (t.owner = 'content' AND t.target_kind = 'content_revision'
        OR t.owner = 'object' AND t.target_kind = 'object')))
    LIMIT 1`);
  if (unsupported.rowCount) throw new ErasureRestoreHold('an erasure owner is not reconciled');
  if (restored.graph && await graphLineageSequence(restored.graph.fuseki,
    restored.graph.lineage, released?.expectation ?? restored.graph.heldErasure?.cut) === null) {
    throw new ErasureRestoreHold('restored graph lineage is unavailable');
  }
  let after = '0';
  while (true) {
    const entries = (await relay.query<{ id: string; epoch: string; refs: string[] }>(
      `SELECT e.id, e.erasure_epoch::text AS epoch, array_agg(t.target_ref ORDER BY t.ordinal) AS refs
       FROM relay.erasure e JOIN relay.erasure_target t ON t.erasure_id = e.id
         AND t.owner = 'content' AND t.target_kind = 'content_revision'
       WHERE e.kind <> 'account' AND e.erasure_epoch > $1::bigint
       GROUP BY e.id ORDER BY e.erasure_epoch LIMIT ${JOURNAL_PAGE}`, [after])).rows;
    for (const entry of entries) {
      const probes = await probeContentErasure(restored.content, entry.id, entry.refs);
      if (entry.refs.some(ref => !['erased', 'absent'].includes(probes.get(ref) ?? 'foreign'))) {
        throw new ErasureRestoreHold('restored Content still exposes an erased revision');
      }
      const erasedRefs = entry.refs.filter(ref => probes.get(ref) === 'erased');
      if (erasedRefs.length) {
        await assertReplayedCommentSourcesTerminal(restored.content, erasedRefs, entry.id, entry.epoch);
      }
      let graphProof: GraphSuppressionProof | null = null;
      if (restored.graph) {
        const held = await heldErasureReplay(restored, { relayClient: relay, accessClient },
          entry.id, entry.epoch, entry.refs);
        if (held) await requireRecordedItem(relay, reconciliationId,
          originalEvidenceItem(entry.id, entry.epoch, entry.refs, held));
        const proof = released && held ? { released: released.expectation, captured: held } : held;
        if (released && !held || entry.refs.length > 64 || !await assertGraphErasure(
          restored.graph.fuseki, restored.graph.lineage, entry.id, entry.epoch, entry.refs, proof)) {
          throw new ErasureRestoreHold('restored graph still exposes an erased revision');
        }
        try { graphProof = await readGraphErasureProof(restored.graph.fuseki,
          restored.graph.lineage, entry.id, entry.epoch, entry.refs, proof); }
        catch { throw new ErasureRestoreHold('restored graph erasure receipt is unavailable'); }
      }
      if (!await publicationSupersessionsMatch(restored.content, entry.refs,
        entry.id, entry.epoch, graphProof)) {
        throw new ErasureRestoreHold('restored publication supersession differs from erasure proof');
      }
    }
    if (entries.length < JOURNAL_PAGE) break;
    after = entries[entries.length - 1]!.epoch;
  }
  after = '0';
  while (true) {
    const entries = (await relay.query<{ id: string; epoch: string }>(`SELECT e.id,
        e.erasure_epoch::text AS epoch FROM relay.erasure e
      WHERE e.erasure_epoch > $1::bigint AND EXISTS
        (SELECT 1 FROM relay.erasure_target t WHERE t.erasure_id = e.id AND t.owner = 'object')
      ORDER BY e.erasure_epoch LIMIT ${JOURNAL_PAGE}`, [after])).rows;
    for (const entry of entries) {
      const report = await readErasure(relay, entry.id);
      for (const target of report.targets.filter(target => target.owner === 'object')) {
        if (protectedDigests.has(target.ref.slice(7))
          || !await objectErasureAbsent(restored.objects, target.ref)) {
          throw new ErasureRestoreHold('restored object copy still exposes an erased digest');
        }
      }
    }
    if (entries.length < JOURNAL_PAGE) break;
    after = entries[entries.length - 1]!.epoch;
  }
  after = '0';
  while (true) {
    const entries = (await relay.query<{ epoch: string; account_subject: string;
      deleted_principal_id: string | null }>(`SELECT erasure_epoch::text AS epoch,
        account_subject, deleted_principal_id FROM relay.erasure
       WHERE kind = 'account' AND erasure_epoch > $1::bigint
       ORDER BY erasure_epoch LIMIT 1000`, [after])).rows;
    const present = await accountCredentialsPresent(restored.account,
      entries.map(entry => entry.account_subject));
    if (present.size) {
      throw new ErasureRestoreHold('restored Account still has erased credentials');
    }
    const principals = entries.map(entry => entry.deleted_principal_id).filter((id): id is string => !!id);
    if (principals.length) {
      const active = await accessClient.query(`SELECT 1 FROM access.principal
        WHERE id = ANY($1::uuid[]) AND active = true LIMIT 1`, [principals]);
      if (active.rowCount) throw new ErasureRestoreHold('restored Access principal is active');
      if (released) {
        await assertErasedLibraryImportsAbsent(restored.content, accessClient, principals);
      } else {
        await eraseLibraryImportsForPrincipals(restored.content,accessClient,principals);
        await assertErasedLibraryImportsAbsent(restored.content, accessClient, principals);
      }
    }
    if (entries.length < 1000) break;
    after = entries[entries.length - 1]!.epoch;
  }
}

/**
 * Reopen the restored Access owner only for a reconciled restore that is still
 * current: no newer journal entry, no newer retained capture and matching Access
 * authority and deletion evidence. The journal allocator lock blocks new erasures
 * meanwhile.
 */
export async function releaseErasureRestoreHold(relay: Pool, restored: RestoredOwners,
  reconciliationId: string, fenceGeneration: string,
  authority: RetainedAuthorityCoverage, options?: {
    clients?: BorrowedRestoreClients; beforeAccessRelease?: () => Promise<void>;
    graphRelease?: RestoredGraphReleaseExpectation;
  }): Promise<void> {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(fenceGeneration)) {
    throw new ErasureRestoreHold('captured Access recovery generation is invalid');
  }
  const supplied = options?.graphRelease ?? options?.clients?.graphRelease;
  const graphRelease = supplied ? structuredClone(supplied) : undefined;
  if (graphRelease) {
    let coverage: RecoveryCoverage;
    try { coverage = openRecoveryPayload<RecoveryCoverage>(authority.sealedCoverage,
      authority.hmacKey, 'graph-recovery-coverage'); }
    catch { throw new ErasureRestoreHold('signed release authority is unavailable'); }
    const effective = graphRelease.effective;
    if (effective.dataEpoch !== coverage.priorDataEpoch || effective.graphSequence !== coverage.priorSequence
      || effective.main && (effective.main.streamScope !== coverage.relay?.streamScope
        || effective.main.dataEpoch !== coverage.relay.dataEpoch
        || effective.main.sequence !== coverage.relay.sequence)) {
      throw new ErasureRestoreHold('native release cut differs from signed current authority');
    }
  }
  await withRestoreClients(relay, restored, options?.clients, async ({ relayClient: client, accessClient }, released) => {
    const fence = (await accessClient.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true FOR UPDATE')).rows[0]!;
    if (fence.open === false) await lockAccessRecoveryFenceForRelease(accessClient, fenceGeneration);
    else {
      const leases = await accessClient.query(`SELECT 1 FROM access.search_read_lease WHERE state = 'delivering'
        UNION ALL SELECT 1 FROM access.download_read_lease WHERE state = 'delivering' LIMIT 1`);
      if (leases.rowCount !== 0) throw new ErasureRestoreHold('Access delivery is still active');
    }
    await authenticateRestoreReconciliation(client, restored, accessClient,
      reconciliationId, fenceGeneration, authority, released);
    try { await assertAccountDeletionJournalCoverage(restored.access, relay, accessClient, client); }
    catch (error) {
      if (error instanceof AccountDeletionJournalConflict) throw new ErasureRestoreHold(error.message);
      throw error;
    }
    await assertRestoredErasuresCurrent(client, restored, accessClient, reconciliationId, released);
    if (restored.graph?.heldErasure && !released && !options?.beforeAccessRelease) {
      throw new ErasureRestoreHold('held graph release callback is required');
    }
    const relayTransactionId = (await client.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]!.id;
    const accessTransactionId = (await accessClient.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]!.id;
    // A committed native release is only reread. It cannot authorize another
    // held mutation, and a completed Access effect needs no callback or CAS.
    if (!released) await options?.beforeAccessRelease?.();
    if ((await client.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]!.id !== relayTransactionId
      || (await accessClient.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]!.id !== accessTransactionId) {
      throw new ErasureRestoreHold('owner release callback changed a held transaction');
    }
    const expectation = released?.expectation ?? graphRelease;
    if (expectation) {
      const currentRelease = await readRestoredGraphReleaseProof(restored.graph!.fuseki, expectation);
      if (!currentRelease) throw new ErasureRestoreHold('native graph release evidence changed before Access completion');
      if (!released) {
        // Native and PG commit independently. Revalidate the same durable
        // qualification and remaining closure after the first native effect.
        await authenticateRestoreReconciliation(client, restored, accessClient,
          reconciliationId, fenceGeneration, authority, currentRelease);
        await assertAccountDeletionJournalCoverage(restored.access, relay, accessClient, client);
        await assertRestoredErasuresCurrent(client, restored, accessClient, reconciliationId, currentRelease);
      }
    }
    if (fence.open === false) await releaseAccessRecoveryFence(accessClient, fenceGeneration);
    if (expectation && !(await readRestoredGraphReleaseProof(restored.graph!.fuseki, expectation))) {
      throw new ErasureRestoreHold('native graph release evidence changed after Access completion');
    }
  }, { graphRelease, fenceGeneration });
}
