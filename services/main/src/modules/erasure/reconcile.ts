import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { ObjectRecoveryStore } from '../owner/object-coverage.ts';
import type { GraphLineage } from '../work/activate.ts';
import { releaseAccessRecoveryFence } from '../access/admission.ts';
import { AccountDeletionJournalConflict, assertAccountDeletionJournalCoverage } from
  '../outbox/account-deletion-journal.ts';
import type { OwnerReconciliationItemRow, OwnerReconciliationCutRow } from '../owner/schema.ts';
import { accountCredentialsPresent } from './account.ts';
import { assertRetainedAuthorityCoverage, type RetainedAuthorityCoverage } from './authority.ts';
import { applyContentErasure, ContentErasureGraphRequired, contentErasureResource,
  ContentErasureStale, probeContentErasure } from './content.ts';
import { ErasureUnavailable, readErasure, relayTransaction, sha256 } from './journal.ts';
import { assertGraphErasure, graphLineageSequence, replayGraphErasure } from './replay-graph.ts';
import { objectErasureAbsent, protectedObjectDigests, replayObjectErasure } from './replay-objects.ts';

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

async function summary(relay: Pool, operationId: string): Promise<ReconciliationSummary | null> {
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
    const probes = await probeContentErasure(owners.content, erasureId, report.targets.map(target => target.ref));
    for (const target of report.targets) {
      items.push({ owner: 'content', kind: 'revision', ref: target.ref,
        disposition: probes.get(target.ref) === 'erased' ? 'erased' : 'conflict' });
    }
  }
  for (const disposition of report.dispositions) {
    items.push({ owner: disposition.owner, kind: 'retention_pin', ref: disposition.domain,
      disposition: ['pending', 'blocked'].includes(disposition.destruction) ? 'conflict'
        : disposition.destruction === 'retained' ? 'preserved' : 'retired' });
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
  graph?: { fuseki: FusekiClient; lineage: GraphLineage };
  objects?: ObjectRecoveryStore;
}

function restoreRequestDigest(consumer: string, replay: boolean,
  authority: RetainedAuthorityCoverage): string {
  return sha256(`${consumer}\0${replay}\0${sha256(authority.sealedCoverage)}`);
}

async function journalFrontier(relay: Pool, consumer: string) {
  const head = (await relay.query<{ generation: string; erasure_epoch: string | null }>(
    `SELECT generation::text AS generation, erasure_epoch::text AS erasure_epoch
     FROM relay.recovery_coverage_head WHERE consumer = $1`, [consumer])).rows[0] ?? null;
  const journal = (await relay.query<{ epoch: string | null }>(
    'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure')).rows[0]!.epoch;
  return { head, journal };
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
 */
export async function reconcileRestoredErasures(relay: Pool, restored: RestoredOwners, input: {
  operationId: string; consumer: string; replay: boolean;
  authority: RetainedAuthorityCoverage }): Promise<ReconciliationSummary> {
  const prior = await summary(relay, input.operationId);
  const requestDigest = restoreRequestDigest(input.consumer, input.replay, input.authority);
  if (prior) {
    const recorded = (await relay.query<{ request_digest: string }>(
      'SELECT request_digest FROM relay.owner_reconciliation WHERE operation_id = $1',
      [input.operationId])).rows[0];
    if (recorded?.request_digest !== requestDigest) {
      throw new ErasureRestoreHold('restore operation binds another authority capture');
    }
    return prior;
  }
  const { head, journal } = await journalFrontier(relay, input.consumer);
  const content: Item[] = [];
  const graph: Item[] = [];
  const objects: Item[] = [];
  let after = '0';
  while (true) {
    const entries = (await relay.query<{ id: string; epoch: string;
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
      const available = entry.refs.filter(ref => probes.get(ref) === 'available');
      let replayed = false;
      if (available.length && input.replay) {
        try {
          await applyContentErasure(restored.content, { erasureId: entry.id, erasureEpoch: entry.epoch,
            resourceId: await contentErasureResource(restored.content, available), revisionIds: available });
          replayed = true;
        } catch (error) {
          if (!(error instanceof ContentErasureGraphRequired || error instanceof ContentErasureStale)) throw error;
        }
      }
      for (const ref of entry.refs) {
        const probe = probes.get(ref);
        content.push({ owner: 'content', kind: 'revision', ref,
          disposition: probe === 'erased' || probe === 'absent' ? 'erased'
            : probe === 'available' && replayed ? 'replayed' : 'conflict' });
      }
      if (restored.graph) {
        const disposition = entry.refs.length > 64 ? 'conflict'
          : await replayGraphErasure(restored.graph.fuseki, restored.graph.lineage,
            entry.id, entry.epoch, entry.refs, input.replay);
        graph.push({ owner: 'graph', kind: 'erasure', ref: entry.id, disposition });
      }
    }
    if (entries.length < JOURNAL_PAGE) break;
    after = entries[entries.length - 1]!.epoch;
  }
  // Explicit object targets are exact digests. Other non-Content target families
  // remain held until their own owner supplies a replay and release proof.
  let protectedDigests: Set<string> | null = null;
  let objectProtectionFailed = false;
  after = '0';
  while (true) {
    const entries = (await relay.query<{ id: string; epoch: string }>(
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
      const report = await readErasure(relay, entry.id);
      if (report.targets.some(target => target.owner === 'object')
        && !protectedDigests && !objectProtectionFailed && restored.objects && restored.graph) {
        try { protectedDigests = await protectedObjectDigests(
          restored.graph.fuseki, restored.objects); }
        catch { objectProtectionFailed = true; }
      }
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
          && protectedDigests && !objectProtectionFailed) {
          try { disposition = await replayObjectErasure(restored.objects, target.ref,
            protectedDigests, input.replay); }
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
    const entries = (await relay.query<{ epoch: string; account_subject: string;
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
  try { await assertAccountDeletionJournalCoverage(restored.access, relay); }
  catch (error) {
    if (!(error instanceof AccountDeletionJournalConflict)) throw error;
    authority = { ...authority, disposition: 'conflict' };
  }
  let currentAuthority: Item = { owner: 'access', kind: 'authority_fence',
    ref: 'current-retained-authority-coverage', disposition: 'matched' };
  try { await assertRetainedAuthorityCoverage(relay, restored.access, input.consumer, input.authority); }
  catch { currentAuthority = { ...currentAuthority, disposition: 'conflict' }; }
  let graphSequence: string | null = null;
  if (restored.graph) {
    try { graphSequence = await graphLineageSequence(restored.graph.fuseki, restored.graph.lineage); }
    catch { /* an unavailable graph cannot be released */ }
    if (graphSequence === null) graph.push({ owner: 'graph', kind: 'authority_fence',
      ref: 'restored-graph-lineage', disposition: 'conflict' });
  }
  const items = [...content, ...graph, ...objects, ...account, authority, currentAuthority];
  const open = items.filter(item => OPEN.has(item.disposition));
  const holdReason = !head ? 'no retained recovery coverage head'
    : open.length ? `${open.length} journal items are missing from the restore` : null;
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
    ...(restored.objects ? [{ owner: 'object' as const, dataEpoch: null, sequence: null,
      status: status(objects), digest: itemsDigest(objects) }] : []),
    { owner: 'access', dataEpoch: null, sequence: null, status: status([authority, currentAuthority]),
      digest: itemsDigest([authority, currentAuthority]) },
    { owner: 'relay', dataEpoch: null, sequence: null, status: head ? 'matched' : 'missing',
      digest: sha256(`${journal ?? '0'}\0${head?.generation ?? 'none'}`) },
  ];
  await relayTransaction(relay, client => recordReconciliation(client, {
    operationId: input.operationId, requestDigest,
    kind: 'restore', scope: `restore:${input.consumer}`, consumer: input.consumer,
    coverageGeneration: head?.generation ?? null, erasureEpoch: journal, erasureId: null, holdReason },
  cuts, items));
  return (await summary(relay, input.operationId))!;
}

/** Recheck the live restored copies immediately before releasing their Access fence. */
async function assertRestoredErasuresCurrent(relay: PoolClient, restored: RestoredOwners): Promise<void> {
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
    restored.graph.lineage) === null) {
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
      if (restored.graph && (entry.refs.length > 64 || !await assertGraphErasure(
        restored.graph.fuseki, restored.graph.lineage, entry.id, entry.epoch, entry.refs))) {
        throw new ErasureRestoreHold('restored graph still exposes an erased revision');
      }
    }
    if (entries.length < JOURNAL_PAGE) break;
    after = entries[entries.length - 1]!.epoch;
  }
  after = '0';
  let protectedDigests: Set<string> | null = null;
  while (true) {
    const entries = (await relay.query<{ id: string; epoch: string }>(`SELECT e.id,
        e.erasure_epoch::text AS epoch FROM relay.erasure e
      WHERE e.erasure_epoch > $1::bigint AND EXISTS
        (SELECT 1 FROM relay.erasure_target t WHERE t.erasure_id = e.id AND t.owner = 'object')
      ORDER BY e.erasure_epoch LIMIT ${JOURNAL_PAGE}`, [after])).rows;
    if (entries.length && (!restored.objects || !restored.graph)) {
      throw new ErasureRestoreHold('restored graph and object copies are required');
    }
    if (entries.length && !protectedDigests) {
      protectedDigests = await protectedObjectDigests(restored.graph!.fuseki, restored.objects!);
    }
    for (const entry of entries) {
      const report = await readErasure(relay, entry.id);
      for (const target of report.targets.filter(target => target.owner === 'object')) {
        if (protectedDigests!.has(target.ref.slice(7))
          || !await objectErasureAbsent(restored.objects!, target.ref)) {
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
      const active = await restored.access.query(`SELECT 1 FROM access.principal
        WHERE id = ANY($1::uuid[]) AND active = true LIMIT 1`, [principals]);
      if (active.rowCount) throw new ErasureRestoreHold('restored Access principal is active');
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
  authority: RetainedAuthorityCoverage): Promise<void> {
  await relayTransaction(relay, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
    const row = (await client.query<{ kind: string; state: string; consumer: string | null;
      request_digest: string;
      erasure_epoch: string | null; coverage_generation: string | null }>(`SELECT kind, state, consumer,
        request_digest, erasure_epoch::text AS erasure_epoch,
        coverage_generation::text AS coverage_generation
      FROM relay.owner_reconciliation WHERE id = $1`, [reconciliationId])).rows[0];
    if (row?.kind !== 'restore' || row.state !== 'reconciled' || !row.consumer) {
      throw new ErasureRestoreHold('restore is not reconciled with the retained journal');
    }
    if (![false, true].some(replay => row.request_digest ===
      restoreRequestDigest(row.consumer!, replay, authority))) {
      throw new ErasureRestoreHold('restore authority capture differs from reconciliation');
    }
    const head = (await client.query<{ generation: string }>(`SELECT generation::text AS generation
      FROM relay.recovery_coverage_head WHERE consumer = $1 FOR SHARE`, [row.consumer])).rows[0];
    const journal = (await client.query<{ epoch: string | null }>(
      'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure')).rows[0]!.epoch;
    if (head?.generation !== row.coverage_generation || journal !== row.erasure_epoch) {
      throw new ErasureRestoreHold('a newer retained frontier needs reconciliation');
    }
    try { await assertAccountDeletionJournalCoverage(restored.access, relay); }
    catch (error) {
      if (error instanceof AccountDeletionJournalConflict) throw new ErasureRestoreHold(error.message);
      throw error;
    }
    try { await assertRetainedAuthorityCoverage(client, restored.access, row.consumer, authority); }
    catch { throw new ErasureRestoreHold('restored Access differs from current retained authority'); }
    await assertRestoredErasuresCurrent(client, restored);
    await releaseAccessRecoveryFence(restored.access, fenceGeneration);
  });
}
