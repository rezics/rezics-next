import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { MAX_CONTENT_ERASURE_TARGETS } from '../erasure/content.ts';
import { readGraphErasureProof } from '../erasure/graph.ts';
import { ERASURE_PREFLIGHT_LIMITS, MAX_ERASURE_TARGETS, readErasure,
  type ErasurePreflightBudget, type ErasureTargetInput } from '../erasure/journal.ts';
import { graphRevisionIds } from '../erasure/revision-kind.ts';
import { settledContentPosition } from '../content-sequence.ts';
import { withPreservationFence, type PreservationAccess, type PreservationFence } from '../public-report/preservation.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { assetIri, assetNamespace, assetVariant, lockMediaAssetState, MediaFenced, MediaInvalid,
  MediaStale, MediaUnavailable, settleMediaAssetState, type LockedMediaAssetState } from './store.ts';

export class MediaErasureUnsupported extends MediaUnavailable {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_INDEXED_UNITS = ERASURE_PREFLIGHT_LIMITS.indexedUnits;
const MAX_METADATA_BYTES = ERASURE_PREFLIGHT_LIMITS.metadataBytes;
const MAX_LISTING_BYTES = ERASURE_PREFLIGHT_LIMITS.listingBytes;

export interface MediaErasureSelection {
  asset: string;
  revisionIds: readonly string[];
  /** Reuse Access's erasure admission on this asset, never an attachment's media grant. */
  admission: RegisteredAdmission;
}

/** The caller can share this budget with the other owners in one preflight. */
export type MediaErasureBudget = ErasurePreflightBudget;

export interface MediaErasureInventory {
  asset: string;
  variant: string;
  revisionIds: readonly string[];
  stateHead: string;
  mediaEpoch: string;
  targets: readonly ErasureTargetInput[];
}

export interface MediaErasureJournal {
  relay: Pool | PoolClient;
  erasureId: string;
  erasureEpoch: string;
  graph: Pick<WorkActivationEnvironment, 'fuseki' | 'lineage'>;
  heldGraphProof?: Parameters<typeof readGraphErasureProof>[5];
}

interface RevisionIdentity { id: string; model: string; byte_length: number; availability: string }
interface Representation { id: string; kind: string; upload_id: string | null; source_id: string | null;
  byte_digest: string; byte_length: number; media_type: string; pixel_width: number; pixel_height: number }
interface Upload { id: string; quarantine_key: string }

function checkSelection(selection: MediaErasureSelection): void {
  const { asset, revisionIds, admission } = selection;
  if (!UUID.test(asset) || !revisionIds.length || revisionIds.length > MAX_CONTENT_ERASURE_TARGETS
    || new Set(revisionIds).size !== revisionIds.length || revisionIds.some(id => !UUID.test(id))) {
    throw new MediaInvalid('media erasure selection is invalid');
  }
  if (!UUID.test(admission.id) || !UUID.test(admission.principalId)
    || admission.scope !== `erasure:${assetIri(asset)}` || admission.action !== 'erasure.request'
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(admission.actingSubject)
    || !/^(0|[1-9][0-9]{0,19})$/.test(admission.authorityEpoch)
    || !DIGEST.test(admission.requestDigest)) {
    throw new MediaFenced('media erasure requires an erasure admission on the asset');
  }
}

function inventoryReadLimit(budget: MediaErasureBudget, ownerRemaining: number): number {
  const remaining = MAX_ERASURE_TARGETS - budget.inventoryEntries;
  if (remaining < 0) throw new MediaErasureUnsupported('media inventory entry budget is exhausted');
  return Math.min(ownerRemaining, remaining);
}

async function revisionIdentities(client: PoolClient, selection: MediaErasureSelection,
  budget: MediaErasureBudget): Promise<RevisionIdentity[]> {
  // The variant index bounds the retained history, including non-head and erased revisions.
  const limit = inventoryReadLimit(budget, MAX_CONTENT_ERASURE_TARGETS);
  const rows = (await client.query<RevisionIdentity>(`SELECT r.id::text AS id, r.model, r.byte_length, r.availability
    FROM content.revision r WHERE r.variant_id=$1 ORDER BY r.created_at DESC,r.id LIMIT $2`,
  [assetVariant(selection.asset), limit + 1])).rows;
  consumeEntries(budget, rows.length);
  if (rows.length > limit) {
    throw new MediaErasureUnsupported('media revision inventory exceeds the supported bound');
  }
  const selected = new Set(selection.revisionIds);
  if (rows.length !== selected.size || rows.some(row => !selected.has(row.id) || row.model !== 'media-asset-v1')) {
    throw new MediaErasureUnsupported('media namespace erasure requires every retained asset revision');
  }
  return rows;
}

function consumeEntries(budget: MediaErasureBudget, count: number, indexed = false): void {
  budget.inventoryEntries += count;
  if (indexed) budget.indexedUnits += count;
  if (budget.inventoryEntries > MAX_ERASURE_TARGETS || budget.indexedUnits > MAX_INDEXED_UNITS) {
    throw new MediaErasureUnsupported('media inventory exceeds the supported bound');
  }
}

function addTarget(budget: MediaErasureBudget, target: ErasureTargetInput): void {
  if (budget.targets.some(existing => existing.kind === target.kind && existing.ref === target.ref)) return;
  if (budget.targets.length >= MAX_ERASURE_TARGETS) {
    throw new MediaErasureUnsupported('media target closure exceeds the supported bound');
  }
  budget.targets.push(target);
}

function checkBudget(budget: MediaErasureBudget): void {
  if (budget.targets.length > MAX_ERASURE_TARGETS
    || [budget.indexedUnits, budget.inventoryEntries, budget.metadataBytes, budget.listingBytes]
      .some(value => !Number.isSafeInteger(value) || value < 0)
    || budget.indexedUnits > MAX_INDEXED_UNITS || budget.inventoryEntries > MAX_ERASURE_TARGETS
    || budget.metadataBytes > MAX_METADATA_BYTES || budget.listingBytes > MAX_LISTING_BYTES) {
    throw new MediaErasureUnsupported('media inventory budget is unavailable');
  }
}

async function indexedRows(client: PoolClient, asset: string, budget: MediaErasureBudget) {
  // Existing UNIQUE(asset_id,id) indexes support both bounded reads; no history scan or paging.
  // Qualify UUID ordering: the projected text id would require sorting the whole history.
  const representations = (await client.query<Representation>(`SELECT r.id::text AS id,r.kind,r.upload_id::text,
    r.source_id::text,r.byte_digest,r.byte_length,r.media_type,r.pixel_width,r.pixel_height
    FROM media.representation r WHERE r.asset_id=$1 ORDER BY r.id LIMIT $2`,
  [asset, inventoryReadLimit(budget, MAX_INDEXED_UNITS - budget.indexedUnits) + 1])).rows;
  consumeEntries(budget, representations.length, true);
  const uploads = (await client.query<Upload>(`SELECT u.id::text AS id,u.quarantine_key
    FROM media.upload u WHERE u.asset_id=$1 ORDER BY u.id LIMIT $2`,
  [asset, inventoryReadLimit(budget, MAX_INDEXED_UNITS - budget.indexedUnits) + 1])).rows;
  consumeEntries(budget, uploads.length, true);
  return { representations, uploads };
}

function representationTargets(asset: string, representations: readonly Representation[],
  uploads: readonly Upload[], budget: MediaErasureBudget): void {
  const byRepresentation = new Map(representations.map(representation => [representation.id, representation]));
  const byUpload = new Map(uploads.map(upload => [upload.id, upload]));
  for (const representation of representations) {
    if (!UUID.test(representation.id) || !DIGEST.test(representation.byte_digest)
      || (representation.kind === 'original' ? !byUpload.has(representation.upload_id ?? '')
        : representation.kind !== 'rendition' || byRepresentation.get(representation.source_id ?? '')?.kind !== 'original')) {
      throw new MediaErasureUnsupported('media representation identity is unavailable');
    }
    addTarget(budget, { kind: 'object', ref: `media-asset:v1:${asset}:sha256:${representation.byte_digest}` });
    if (representation.kind === 'original') {
      addTarget(budget, { kind: 'object', ref: `media-quarantine:v1:${representation.upload_id}:sha256:${representation.byte_digest}` });
    }
  }
}

async function inventoryLocked(client: PoolClient, selection: MediaErasureSelection,
  row: LockedMediaAssetState, objects: (namespace: string) => ImmutableObjects,
  budget: MediaErasureBudget, signal: AbortSignal,
  retained?: Pick<MediaErasureJournal, 'erasureId' | 'erasureEpoch'>): Promise<MediaErasureInventory> {
  checkBudget(budget);
  if (row.lifecycle === 'erased') throw new MediaStale('media asset is already erased');
  const revisions = await revisionIdentities(client, selection, budget);
  if (revisions.some(revision => revision.availability !== 'available'
    && !(retained && revision.availability === 'erased'))) {
    throw new MediaErasureUnsupported('media revision manifest is unavailable');
  }
  for (const revision of revisions) {
    if (!Number.isSafeInteger(revision.byte_length) || revision.byte_length < 0) {
      throw new MediaErasureUnsupported('media revision byte inventory is unavailable');
    }
    budget.metadataBytes += revision.byte_length;
    checkBudget(budget);
  }
  checkBudget(budget);
  const { representations, uploads } = await indexedRows(client, selection.asset, budget);
  const byRepresentation = new Map(representations.map(representation => [representation.id, representation]));
  representationTargets(selection.asset, representations, uploads, budget);
  // These exact ids were just resolved; if their raw reads cannot all fit, refuse
  // before allocating any bytes rather than read a trimmed manifest selection.
  if (selection.revisionIds.length > inventoryReadLimit(budget, MAX_CONTENT_ERASURE_TARGETS)) {
    throw new MediaErasureUnsupported('media manifest inventory exceeds the supported bound');
  }
  const manifests = (await client.query<{ id: string; byte_digest: string; serialized_bytes: Buffer | null;
    availability: string; erasure_id: string | null; erasure_epoch: string | null }>(
    `SELECT r.id::text,r.byte_digest,r.serialized_bytes,r.availability,t.erasure_id::text,t.erasure_epoch::text
      FROM content.revision r LEFT JOIN content.revision_erasure t ON t.revision_id=r.id
      WHERE r.id=ANY($1::uuid[]) ORDER BY r.id LIMIT $2`,
    [selection.revisionIds, selection.revisionIds.length])).rows;
  if (manifests.length !== revisions.length) throw new MediaStale('media revision inventory changed');
  consumeEntries(budget, manifests.length);
  for (const manifest of manifests) {
    if (retained && manifest.availability === 'erased' && manifest.serialized_bytes === null
      && manifest.erasure_id === retained.erasureId && manifest.erasure_epoch === retained.erasureEpoch) continue;
    if (!manifest.serialized_bytes
      || createHash('sha256').update(manifest.serialized_bytes).digest('hex') !== manifest.byte_digest) {
      throw new MediaErasureUnsupported('media revision manifest is unavailable');
    }
    let body: Record<string, unknown>;
    try { body = JSON.parse(manifest.serialized_bytes.toString('utf8')) as Record<string, unknown>; }
    catch { throw new MediaErasureUnsupported('media revision manifest is unavailable'); }
    const original = Array.isArray(body?.representations) && body.representations.length === 1
      ? body.representations[0] as Record<string, unknown> | null : null;
    const representation = typeof original?.id === 'string' ? byRepresentation.get(original.id) : undefined;
    if (body?.profile !== 'media-asset-v1' || body.asset !== assetIri(selection.asset) || body.mediaKind !== 'image'
      || !original || !representation || representation.kind !== 'original' || original.role !== 'original'
      || original.sha256 !== representation.byte_digest || original.byteLength !== representation.byte_length
      || original.mediaType !== representation.media_type || original.width !== representation.pixel_width
      || original.height !== representation.pixel_height) {
      throw new MediaErasureUnsupported('media revision original identity is unavailable');
    }
  }
  addTarget(budget, { kind: 'content_variant', ref: assetVariant(selection.asset) });
  for (const revision of revisions) addTarget(budget, { kind: 'content_revision', ref: revision.id });

  const prefixes = [{ prefix: assetNamespace(selection.asset), ref: `media-asset:v1:${selection.asset}` },
    ...uploads.map(upload => {
      if (!UUID.test(upload.id) || upload.quarantine_key !== `media-quarantine/${upload.id}`) {
        throw new MediaErasureUnsupported('media quarantine identity is unavailable');
      }
      return { prefix: `${upload.quarantine_key}/`, ref: `media-quarantine:v1:${upload.id}` };
    })];
  // Reserve portions of the shared response ceiling. The adapter does not expose XML byte counts;
  // summing its requested maxima also bounds capability responses and XML overhead across prefixes.
  const responseBytes = Math.floor((MAX_LISTING_BYTES - budget.listingBytes) / prefixes.length);
  if (responseBytes < 1) throw new MediaErasureUnsupported('media listing byte budget is exhausted');
  for (const { prefix, ref } of prefixes) {
    signal.throwIfAborted();
    const remaining = MAX_ERASURE_TARGETS - budget.inventoryEntries;
    if (remaining < 1) throw new MediaErasureUnsupported('media listing entry budget is exhausted');
    const store = objects(prefix);
    if (!store.listPrefix) throw new MediaErasureUnsupported('media namespace inventory is unavailable');
    budget.listingBytes += responseBytes;
    const keys = await store.listPrefix(prefix, { maxEntries: remaining, maxResponseBytes: responseBytes, signal });
    consumeEntries(budget, keys.length);
    const seen = new Set<string>();
    for (const key of keys) {
      const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : '';
      if (!/^sha256\/[0-9a-f]{64}$/.test(suffix) || seen.has(key)) {
        throw new MediaErasureUnsupported('media namespace inventory contains an unexpected key');
      }
      seen.add(key);
      addTarget(budget, { kind: 'object', ref: `${ref}:sha256:${suffix.slice('sha256/'.length)}` });
    }
  }
  return Object.freeze({ asset: selection.asset, variant: assetVariant(selection.asset),
    revisionIds: Object.freeze(revisions.map(revision => revision.id)),
    stateHead: row.state_head, mediaEpoch: row.erasure_epoch,
    targets: Object.freeze(budget.targets.filter(target => target.kind === 'content_variant' && target.ref === assetVariant(selection.asset)
      || target.kind === 'content_revision' && selection.revisionIds.includes(target.ref)
      || target.kind === 'object' && (target.ref.startsWith(`media-asset:v1:${selection.asset}:`)
        || uploads.some(upload => target.ref.startsWith(`media-quarantine:v1:${upload.id}:`))))
      .map(target => Object.freeze({ ...target }))) });
}

async function applyLocked(client: PoolClient, selection: MediaErasureSelection,
  row: LockedMediaAssetState, journal: MediaErasureJournal, inventory?: MediaErasureInventory): Promise<string> {
  if (!UUID.test(journal.erasureId) || !/^[1-9][0-9]{0,18}$/.test(journal.erasureEpoch)) {
    throw new MediaInvalid('media erasure journal identity is invalid');
  }
  const report = await readErasure(journal.relay, journal.erasureId);
  const admission = selection.admission;
  if (report.erasureEpoch !== journal.erasureEpoch || report.authority !== 'access_admission'
    || report.admissionId !== admission.id || report.principalId !== admission.principalId
    || report.authorityEpoch !== admission.authorityEpoch || report.requestDigest !== admission.requestDigest
    || report.operationId !== `erasure:${admission.id}`
    || !report.targets.some(target => target.kind === 'content_variant' && target.ref === assetVariant(selection.asset))
    || selection.revisionIds.some(id => !report.targets.some(target => target.kind === 'content_revision' && target.ref === id))
    || inventory?.targets.some(target => !report.targets.some(retained => retained.kind === target.kind && retained.ref === target.ref))) {
    throw new MediaFenced('media erasure does not match the admitted journal inventory');
  }
  const replayBudget: MediaErasureBudget = { targets: [], indexedUnits: 0, inventoryEntries: 0, metadataBytes: 0, listingBytes: 0 };
  // A fresh inventory already proved these identities while retaining this same lock.
  if (!inventory) await revisionIdentities(client, selection, replayBudget);
  await readGraphErasureProof(journal.graph.fuseki, journal.graph.lineage, report.erasureId,
    report.erasureEpoch, graphRevisionIds(report.targets), journal.heldGraphProof);
  const operationId = `media-erasure:${journal.erasureId}:${selection.asset}`;
  const digest = createHash('sha256').update(`${operationId}:${journal.erasureEpoch}:${report.requestDigest}`).digest('hex');
  const previous = (await client.query<{ request_digest: string; outcome: string; id: string }>(
    `SELECT r.request_digest,r.outcome,s.id::text FROM content.receipt r
      JOIN media.asset_state s ON s.operation_id=r.operation_id
      WHERE r.operation_id=$1 AND s.asset_id=$2`, [operationId, selection.asset])).rows[0];
  if (previous) {
    if (previous.request_digest !== digest || previous.outcome !== 'succeeded'
      || row.lifecycle !== 'erased' || row.state_head !== previous.id) {
      throw new MediaStale('media erasure owner outcome differs from its journal');
    }
    // Restore may replant representation availability: the retained terminal owner still wins.
    const budget = replayBudget;
    const { representations, uploads } = await indexedRows(client, selection.asset, budget);
    representationTargets(selection.asset, representations, uploads, budget);
    if (budget.targets.some(target => !report.targets.some(retained => retained.kind === target.kind && retained.ref === target.ref))) {
      throw new MediaFenced('media replay representation differs from its retained journal inventory');
    }
    await client.query("UPDATE media.representation SET availability='erased' WHERE asset_id=$1 AND availability='available'",
      [selection.asset]);
    return operationId;
  }
  if (!inventory || inventory.stateHead !== row.state_head || inventory.mediaEpoch !== row.erasure_epoch) {
    throw new MediaStale('media erasure requires its complete locked inventory');
  }
  const result = await settleMediaAssetState(client, row, { asset: selection.asset, expectedState: row.state_head,
    disclosure: row.disclosure, lifecycle: 'erased' }, { actor: admission.actingSubject,
    authorityEpoch: report.authorityEpoch!, operationId, requestDigest: digest });
  if (result.outcome !== 'succeeded') throw new MediaStale('media erasure lifecycle is terminal');
  return operationId;
}

async function transactionFence(client: PoolClient) {
  const bounds = (await client.query<{ idle_ms: number; transaction_id: string }>(`SELECT
    (extract(epoch FROM current_setting('idle_in_transaction_session_timeout')::interval) * 1000)::float8 AS idle_ms,
    txid_current()::text AS transaction_id`)).rows[0];
  if (!bounds || !Number.isFinite(bounds.idle_ms) || bounds.idle_ms <= 0) {
    throw new MediaUnavailable('media inventory requires a bounded owner transaction');
  }
  return { signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(5_000, bounds.idle_ms / 2)))),
    transactionId: bounds.transaction_id };
}

async function assertTransactionFence(client: PoolClient, fence: Awaited<ReturnType<typeof transactionFence>>) {
  fence.signal.throwIfAborted();
  const alive = (await client.query<{ transaction_id: string }>('SELECT txid_current()::text AS transaction_id')).rows[0];
  if (alive?.transaction_id !== fence.transactionId) throw new MediaStale('media inventory lost its owner transaction');
}

/** Inventory, journal/suppression callback and lifecycle commit retain one owner lock.
 * Deletion belongs to completion after this transaction commits. A callback failure
 * leaves any retained journal pending and rolls back the Media mutation. */
export async function withMediaErasureInventory<T>(content: Pool, selection: MediaErasureSelection,
  preservationAccess: PreservationAccess, objects: (namespace: string) => ImmutableObjects,
  accept: (inventory: MediaErasureInventory, apply: (journal: MediaErasureJournal) => Promise<void>,
    preservationFence: PreservationFence) => Promise<T>,
  budget: MediaErasureBudget = { targets: [], indexedUnits: 0, inventoryEntries: 0, metadataBytes: 0, listingBytes: 0 },
): Promise<T> {
  checkSelection(selection);
  const operationId = `erasure:${selection.admission.id}`;
  let appliedOperation: string | undefined;
  const guarded = await withPreservationFence(preservationAccess, assetIri(selection.asset), operationId, async preservationFence => {
    const client = await content.connect();
    let active = true;
    let applicationStarted = false;
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'");
      const row = await lockMediaAssetState(client, selection.asset);
      // One deadline spans all physical listing responses while the writer lock is held.
      const fence = await transactionFence(client), { signal } = fence;
      const inventory = await inventoryLocked(client, selection, row, objects, budget, signal);
      const result = await accept(inventory, async journal => {
        if (!active || applicationStarted) throw new MediaStale('media erasure inventory fence is unavailable');
        applicationStarted = true;
        await assertTransactionFence(client, fence);
        appliedOperation = await applyLocked(client, selection, row, journal, inventory);
      }, preservationFence);
      signal.throwIfAborted();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { active = false; client.release(); }
  });
  if (guarded.held) throw new MediaFenced('media is retained under a preservation hold');
  if (appliedOperation) await settledContentPosition(content, appliedOperation);
  return guarded.value;
}

/** Retry a retained intent, including another owner's committed tombstone. An already
 * terminal Media outcome only needs bounded SQL repair; completion re-probes its objects. */
export async function replayMediaErasure(content: Pool, selection: MediaErasureSelection,
  preservationAccess: PreservationAccess, journal: MediaErasureJournal,
  objects?: (namespace: string) => ImmutableObjects,
  budget: MediaErasureBudget = { targets: [], indexedUnits: 0, inventoryEntries: 0, metadataBytes: 0, listingBytes: 0 },
  beforeApply?: () => Promise<void>): Promise<void> {
  checkSelection(selection);
  const guarded = await withPreservationFence(preservationAccess, assetIri(selection.asset), journal.erasureId, async () => {
    const client = await content.connect();
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'");
      const row = await lockMediaAssetState(client, selection.asset);
      const fence = await transactionFence(client);
      let inventory: MediaErasureInventory | undefined;
      if (row.lifecycle !== 'erased') {
        if (!objects) throw new MediaErasureUnsupported('media replay requires bounded namespace inventory');
        // Another owner may have committed before Media rolled back. Only this exact
        // Content tombstone can replace its raw manifest, and the retained closure
        // must still cover every current physical key before the owner may terminalize.
        inventory = await inventoryLocked(client, selection, row, objects,
          budget, fence.signal, journal);
      } else {
        // Terminal repair still preflights its indexed closure with the request's budget.
        await revisionIdentities(client, selection, budget);
        const { representations, uploads } = await indexedRows(client, selection.asset, budget);
        representationTargets(selection.asset, representations, uploads, budget);
        const report = await readErasure(journal.relay, journal.erasureId);
        if (budget.targets.some(target => !report.targets.some(retained => retained.kind === target.kind && retained.ref === target.ref))) {
          throw new MediaFenced('media replay representation differs from its retained journal inventory');
        }
      }
      await assertTransactionFence(client, fence);
      await beforeApply?.();
      const operationId = await applyLocked(client, selection, row, journal, inventory);
      fence.signal.throwIfAborted();
      await client.query('COMMIT');
      return operationId;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  });
  if (guarded.held) throw new MediaFenced('media is retained under a preservation hold');
  await settledContentPosition(content, guarded.value);
}
