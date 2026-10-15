import type { Pool, PoolClient } from 'pg';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withReferenceFence } from './reference-fence.ts';
import { CONTENT_LIVE_RETENTION, GRAPH_LIVE_RETENTION, GRAPH_COPY_RETENTION } from './retention-reasons.ts';
import { lockPreservationTarget, withPreservationFence, type PreservationFence } from '../public-report/preservation.ts';
import { ERASURE_DEFERRED_REASON, ERASURE_TARGET_OWNERS } from './schema.ts';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import type { ObjectRecoveryStore } from '../owner/object-coverage.ts';
import { applyLiveObjectErasure, objectErasureAbsent } from './replay-objects.ts';
import { replayMediaErasure, withMediaErasureInventory, MediaErasureUnsupported } from '../media/erasure.ts';
import { assetNamespace, assetVariant, MediaFenced, MediaStale } from '../media/store.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type GraphTerminalProof, type RegisteredAdmission } from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { GRAPHS, RV, iri, hash, type WorkActivationEnvironment } from '../work/activate.ts';
import { applyContentErasure, assertFreshContentTargets, ContentErasureGraphRequired,
  probeContentErasure, commandCustodyErasureTargets, applyCommandCustodyErasure,
  contentErasureResource, ContentErasureInvalid, ContentErasureStale } from './content.ts';
import { graphRevisionIds, isGraphErasureKind, resolveErasureRevisions } from './revision-kind.ts';
import { assertErasureJournalTargetBound, GraphErasureConflict, GraphErasureUnavailable,
  inventoryContributionPayloads, preflightGraphErasure, readGraphErasureProof, suppressGraphContentRevisions, erasureGraphClient } from './graph.ts';
import { ERASURE_JOURNAL_EPOCH, ErasureInvalid, ErasureNotFound, ErasureStale, ErasureUnavailable,
  createErasurePreflightBudget, consumeErasurePreflight, type ErasurePreflightBudget, erasurePreflightRemaining, ErasurePreflightUnsupported, findErasureByOperation,
  completeErasureTarget, failErasureTarget, isValidErasureTargetList, journalErasure,
  markErasureBlocked, markErasureSuppressed, readErasure, extendErasureTargets, erasureSuppressionReceipt, type ErasureTargetInput,
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
export { CONTENT_LIVE_RETENTION, GRAPH_LIVE_RETENTION } from './retention-reasons.ts';

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
  constructor(readonly relay: Pool, readonly content: Pool, readonly preservationAccess: Pool,
    readonly mediaObjects?: (namespace: string) => ImmutableObjects) {}
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

interface ErasurePreflightPlan {
  budget: ErasurePreflightBudget;
  /** Reserve the owner's second verification read before any destructive transition. */
  custodyReadReservation: number;
}

/**
 * Finish one journaled Content erasure. Every step is idempotent: the Content
 * tombstone, the journal fence, the Access seal and the retention inventory.
 */
async function completeContentErasure(service: ErasureService, graph: WorkActivationEnvironment,
  access: ErasureAccess, admission: RegisteredAdmission, erasureId: string): Promise<void> {
  const finish = await withPublicationFence(service, admission.scope.slice('erasure:'.length),
    client => completeFencedContentErasure(service, graph, access, admission, erasureId, false, client));
  await finish();
}

async function completeFencedContentErasure(service: ErasureService, graph: WorkActivationEnvironment,
  access: ErasureAccess, admission: RegisteredAdmission, erasureId: string,
  mediaApplied: boolean, publicationClient: PoolClient, preflight?: ErasurePreflightPlan): Promise<() => Promise<void>> {
  let journaled = await readErasure(service.relay, erasureId);
  if (journaled.stage === 'blocked') {
    return () => access.recordGraphOutcome(admission.id, proof(admission, 'succeeded', journaled.erasureEpoch));
  }
  validateCompletion(journaled, admission);
  const attempt = (await service.relay.query<{ token: string }>(`UPDATE relay.erasure
    SET live_completion_pending=true, live_completion_attempt=live_completion_attempt+1
    WHERE id=$1 AND stage IN ('requested','fenced','inventory_complete','deleting','reconciling')
    RETURNING live_completion_attempt::text AS token`, [erasureId])).rows[0]?.token;
  if (!attempt) throw new ErasureUnavailable('live completion attempt is unavailable');
  const resourceId = admission.scope.slice('erasure:'.length);
  const plan = preflight ?? { budget: createErasurePreflightBudget(), custodyReadReservation: 0 };
  const { budget } = plan;
  graph = { ...graph, fuseki: erasureGraphClient(graph.fuseki, budget) };
  budget.signal.throwIfAborted();
  budget.targets = journaled.targets.map(({ kind, ref }) => ({ kind, ref }));
  if (!preflight) {
    const contentIds = journaled.targets.filter(target => target.kind === 'content_revision').map(target => target.ref);
    if (contentIds.length) {
      // Revalidate the admitted resource even when its bytes already carry this tombstone.
      const resolved = await resolveErasureRevisions(service.content, graph.fuseki, resourceId, contentIds);
      if (resolved.some(revision => revision.content?.erasureId
        && (revision.content.erasureId !== erasureId || revision.content.erasureEpoch !== journaled.erasureEpoch))) {
        throw new ContentErasureStale('Content revision is no longer available to erase');
      }
      const homes = await selectingHomeTargets(graph, resourceId, contentIds, graphRevisionIds(journaled.targets).length);
      await extendErasureTargets(service.relay, erasureId, journaled.erasureEpoch, admission.id, homes);
      journaled = await readErasure(service.relay, erasureId);
      budget.targets = journaled.targets.map(({ kind, ref }) => ({ kind, ref }));
    }
    await preflightGraphErasure(graph.fuseki, graphRevisionIds(journaled.targets), budget);
    await retainContributionManifests(service, graph, journaled, resourceId, budget);
    const custody = await commandCustodyErasureTargets(publicationClient,
      journaled.targets.filter(target => isGraphErasureKind(target.kind)).map(target => `https://rezics.com/id/${target.ref}`), budget);
    for (const target of custody.filter(target => !target.payloadAbsent)) {
      const bytesBefore = budget.metadataBytes;
      const source = await graph.receiptCustody?.readCommitted(target.receipt, budget);
      if (!source || source.terminal.revision !== target.revision || source.payloadSha256 !== target.payloadSha256) {
        throw new ContentErasureStale('command custody is unavailable for erasure');
      }
      const bytes = budget.metadataBytes - bytesBefore;
      consumeErasurePreflight(budget, 'metadataBytes', bytes);
      plan.custodyReadReservation += bytes;
    }
  }
  await reserveLiveCompletion(graph, journaled.targets, budget);
  const suppressionReceipt = await erasureSuppressionReceipt(service.relay, erasureId);
  const guarded = await withErasureFence(service, resourceId, erasureId,
    async (fence, accessClient) => {
      if (!mediaApplied) {
        const variants = journaled.targets.filter(target => target.kind === 'content_variant');
        if (variants.length) {
          if (!service.mediaObjects || variants.length !== 1
            || variants[0]!.ref !== assetVariant(resourceId.slice(-36))) {
            throw new ErasureInvalid('media erasure inventory is unavailable');
          }
          await replayMediaErasure(service.content, { asset: resourceId.slice(-36),
            revisionIds: journaled.targets.filter(target => target.kind === 'content_revision').map(target => target.ref),
            admission }, fence, { relay: service.relay, erasureId, erasureEpoch: journaled.erasureEpoch,
            graph }, service.mediaObjects, budget, () => suppressGraphContentRevisions(graph.fuseki,
            graph.lineage, journaled.erasureId, journaled.erasureEpoch, graphRevisionIds(journaled.targets), suppressionReceipt, budget));
        }
      }
      // Media commits its exact namespace inventory before other owners clear their bytes.
      await applyRevisionOwners(service, graph, admission, journaled, fence, accessClient, plan, suppressionReceipt);
      await markErasureSuppressed(service.relay, erasureId);
      // Disclosure is suppressed even while physical objects await retry.
      return completeLiveTargets(service, graph, journaled, accessClient, budget);
    }, publicationClient);
  if (guarded.held) {
    if (journaled.stage !== 'requested') throw new ContentErasureStale('Content erasure is deferred');
    await markErasureBlocked(service.relay, erasureId, ERASURE_DEFERRED_REASON);
    return () => access.recordGraphOutcome(admission.id, proof(admission, 'succeeded', journaled.erasureEpoch));
  }
  return async () => {
    await access.recordGraphOutcome(admission.id, proof(admission, 'succeeded', journaled.erasureEpoch));
    // Publication takes Access before Relay. Release this Access lookup before
    // taking Relay so a competing publication can finish its journal reads.
    const hasCustody = (await commandCustodyErasureTargets(service.preservationAccess,
      journaled.targets.filter(target => isGraphErasureKind(target.kind)).map(target => `https://rezics.com/id/${target.ref}`))).length > 0;
    await relayTransaction(service.relay, async retentionClient => {
      await ensureRetentionDomain(service.relay, { label: CONTENT_LIVE_DOMAIN, owner: 'content',
        store: 'postgresql', custody: 'live' }, retentionClient);
      await ensureRetentionDomain(service.relay, { label: CONTENT_WAL_DOMAIN, owner: 'content',
        store: 'postgresql_wal', custody: 'live' }, retentionClient);
      if (hasCustody) {
        for (const [store, label] of [['postgresql', 'access:postgresql:live'],
          ['postgresql_wal', 'access:postgresql-wal:live']] as const) {
          await ensureRetentionDomain(service.relay, { label, owner: 'access', store, custody: 'live' }, retentionClient);
        }
      }
      for (const [store, label] of [
        ['tdb2_generation', `graph:tdb2:live:${graph.lineage.dataEpoch}`],
        ['lucene', `graph:lucene:live:${graph.lineage.dataEpoch}`],
      ] as const) {
        await ensureRetentionDomain(service.relay, { label, owner: 'graph', store, custody: 'live' }, retentionClient);
      }
      for (const [store, label, holdReason, custody] of [
        ['snapshot', 'graph:snapshot:unverified', GRAPH_COPY_RETENTION.snapshot, 'archive'],
        ['tdb2', 'graph:backup:unverified', GRAPH_COPY_RETENTION.backup, 'backup'],
        ['media', 'graph:media:unverified', GRAPH_COPY_RETENTION.media, 'archive'],
      ] as const) {
        await ensureRetentionDomain(service.relay, { label, owner: 'graph', store, custody, holdReason }, retentionClient);
      }
    });
    await recordErasureInventory(service.relay, erasureId,
      { owners: hasCustody ? ['content', 'graph', 'access'] : ['content', 'graph'], liveRetentionReason: CONTENT_LIVE_RETENTION,
        liveRetentionReasons: { graph: GRAPH_LIVE_RETENTION } });
    // Target flags can commit before sealing or inventory. Only this last marker
    // lets the bounded pending worker skip a fully completed live transaction.
    if (guarded.value) await service.relay.query(`UPDATE relay.erasure SET stage = 'reconciling', live_completion_pending=false
      WHERE id = $1 AND live_completion_attempt=$2
        AND stage IN ('fenced', 'inventory_complete', 'deleting', 'reconciling')`, [erasureId, attempt]);
  };
}

/** The Access transaction holds the existing preservation fence. Bounded reads
 * borrow its client; custody mutation retains its own receipt-session commit. */
function withErasureFence<T>(service: ErasureService, resourceId: string, operationId: string,
  write: (fence: PreservationFence, client: PoolClient) => Promise<T>, borrowed?: PoolClient) {
  if (borrowed) return withPreservationFence(borrowed, resourceId, operationId, fence => write(fence, borrowed));
  return relayTransaction(service.preservationAccess, client =>
    withPreservationFence(client, resourceId, operationId, fence => write(fence, client)));
}

async function selectingHomeTargets(graph: WorkActivationEnvironment, resourceId: string,
  contentIds: readonly string[], retainedGraphCount: number): Promise<ErasureTargetInput[]> {
  if (!contentIds.length) return [];
  if (retainedGraphCount > 64) throw new ErasurePreflightUnsupported('erasure closure exceeds the supported preflight bound');
  const result = await graph.fuseki.query(`PREFIX rv: <${RV}>
    SELECT DISTINCT ?revision ?owner ?erased ?owned WHERE {
      VALUES ?content { ${contentIds.map(id => iri(`urn:rezics:content:revision:${id}`)).join(' ')} }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?binding rv:contentRevision ?content .
        ?revision a rv:ZoneHomeRevision, rv:RevisionAnchor ; rv:component ?owner ; rv:publishedPage ?binding .
        BIND(EXISTS { ?revision a rv:ErasedRevision } AS ?erased)
        BIND(?owner = ${iri(resourceId)} AS ?owned)
      }
    } ORDER BY ?revision LIMIT 65`, 65_536);
  const rows = result.results?.bindings;
  if (!rows || rows.some(row => row.revision?.type !== 'uri'
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(row.revision.value)
    || row.owner?.type !== 'uri' || row.owner.value !== resourceId
    || row.owned?.type !== 'literal' || row.owned.datatype !== 'http://www.w3.org/2001/XMLSchema#boolean'
    || row.owned.value !== 'true' || row.erased?.type !== 'literal'
    || row.erased.datatype !== 'http://www.w3.org/2001/XMLSchema#boolean'
    || !['true', 'false'].includes(row.erased.value))) {
    throw new ContentErasureInvalid('Home erasure targets are unavailable');
  }
  const targets = rows.map(row => ({ kind: 'semantic_revision' as const, ref: row.revision!.value.slice(-36) }));
  // The retry caller merges retained H identities before applying the aggregate bound.
  if (new Set(targets.map(target => target.ref)).size !== targets.length || targets.length > 64) {
    throw new ErasurePreflightUnsupported('erasure closure exceeds the supported preflight bound');
  }
  return targets;
}

function validateCompletion(report: ErasureReport, admission: RegisteredAdmission): void {
  const primary = graphRevisionIds(report.targets);
  if (primary.length > 64) throw new ErasurePreflightUnsupported('erasure closure exceeds the supported preflight bound');
  if (report.kind !== 'revision' || report.authority !== 'access_admission'
    || report.operationId !== `erasure:${admission.id}` || report.admissionId !== admission.id
    || report.principalId !== admission.principalId || report.authorityEpoch !== admission.authorityEpoch
    || report.requestDigest !== admission.requestDigest || !isValidErasureTargetList(report.targets)
    || !primary.length
    || report.targets.some(target => target.owner !== ERASURE_TARGET_OWNERS[target.kind]
      || !(target.kind === 'content_revision' || isGraphErasureKind(target.kind)
        || target.kind === 'content_variant' || target.kind === 'object'))
    || report.targets.some(target => target.completionState === 'legacy')) {
    throw new ErasureInvalid('erasure targets are unavailable or invalid');
  }
}

async function applyRevisionOwners(service: ErasureService, graph: WorkActivationEnvironment,
  admission: RegisteredAdmission, report: ErasureReport, fence: PreservationFence,
  accessClient: PoolClient, plan: ErasurePreflightPlan, suppressionReceipt?: string): Promise<void> {
  const graphIds = graphRevisionIds(report.targets);
  await suppressGraphContentRevisions(graph.fuseki, graph.lineage, report.erasureId, report.erasureEpoch, graphIds, suppressionReceipt, plan.budget);
  const graphProof = await readGraphErasureProof(graph.fuseki, graph.lineage, report.erasureId,
    report.erasureEpoch, graphIds);
  const contentIds = report.targets.filter(target => target.kind === 'content_revision').map(target => target.ref);
  if (contentIds.length) await applyContentErasure(service.content, { erasureId: report.erasureId,
    erasureEpoch: report.erasureEpoch, resourceId: admission.scope.slice('erasure:'.length),
    revisionIds: contentIds, graphProof, preservationAccess: fence, budget: plan.budget });
  const custody = await commandCustodyErasureTargets(accessClient,
    report.targets.filter(target => isGraphErasureKind(target.kind)).map(target => `https://rezics.com/id/${target.ref}`));
  // Transfer the preflight reservation back to remaining bytes. The owner consumes
  // this same shared budget while revalidating its exact immutable source under lock.
  plan.budget.metadataBytes -= plan.custodyReadReservation;
  plan.custodyReadReservation = 0;
  await applyCommandCustodyErasure(graph.receiptCustody, custody, { erasureId: report.erasureId,
    erasureEpoch: report.erasureEpoch,
    objectRefs: new Set(report.targets.filter(target => target.kind === 'object').map(target => target.ref)) }, plan.budget);
}

/** Retained replays need only the preserved manifest, never already erased bytes. */
async function retainContributionManifests(service: ErasureService, graph: WorkActivationEnvironment,
  report: ErasureReport, resourceId: string, budget: ErasurePreflightBudget): Promise<void> {
  const drafts = report.targets.filter(target => target.kind === 'text_contribution_draft');
  if (!drafts.length) return;
  const resolved = await resolveErasureRevisions(service.content, graph.fuseki, resourceId, drafts.map(target => target.ref));
  for (const revision of resolved) {
    const manifest = revision.manifest!;
    if ([...budget.contributionManifests.values()].some(roots => roots.some(root => root.manifest === manifest))) continue;
    const path = join(graph.objectDirectory, manifest.slice('urn:rezics:sha256:'.length));
    const remaining = erasurePreflightRemaining(budget, 'metadataBytes');
    if ((await stat(path)).size > remaining) throw new ErasurePreflightUnsupported('manifest exceeds metadata allowance');
    const bytes = await readFile(path, { signal: budget.signal });
    consumeErasurePreflight(budget, 'metadataBytes', bytes.length);
    if (hash(bytes) !== manifest.slice('urn:rezics:sha256:'.length)) throw new ContentErasureStale('manifest digest differs');
    const value = JSON.parse(bytes.toString('utf8')) as { format: string; component: string; payload: string };
    if (value.format !== 'rezics-manifest-v1' || value.component !== revision.resourceId
      || !/^sha256:[0-9a-f]{64}$/.test(value.payload)) throw new ContentErasureStale('manifest reference differs');
    const roots = budget.contributionManifests.get(value.payload) ?? [];
    roots.push({ manifest, component: revision.resourceId });
    budget.contributionManifests.set(value.payload, roots);
  }
}

/** Reverse indexes are read under the same digest fence as every reference writer.
 * Tombstones retain identities, so absence of payload bytes never removes protection. */
async function freshObjectProtection(client: PoolClient,
  graph: WorkActivationEnvironment, ref: string, budget: ErasurePreflightBudget): Promise<Set<string>> {
  const digest = ref.slice(-64);
  const references = new Set<string>();
  // Equal bytes in another asset do not reference this asset/upload namespace.
  const owners = await client.query<{ protected: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM content.revision WHERE byte_digest=$1 AND availability <> 'erased')
    OR EXISTS (SELECT 1 FROM media.representation r JOIN media.asset a ON a.id=r.asset_id
      JOIN media.asset_state s ON s.id=a.state_head
      WHERE r.byte_digest=$1 AND (($2::uuid IS NULL AND $3::uuid IS NULL)
        OR r.asset_id=coalesce($2::uuid, (SELECT u.asset_id FROM media.upload u WHERE u.id=$3::uuid)))
        AND r.availability <> 'erased' AND s.lifecycle <> 'erased') AS protected`,
  [digest, /^media-asset:v1:([0-9a-f-]{36}):/.exec(ref)?.[1] ?? null,
    /^media-quarantine:v1:([0-9a-f-]{36}):/.exec(ref)?.[1] ?? null]);
  if (owners.rows[0]?.protected !== false) references.add(ref);
  const manifests = new Map<string, string | undefined>([[`urn:rezics:sha256:${digest}`, undefined]]);
  for (const root of budget.contributionManifests.get(ref) ?? []) manifests.set(root.manifest, root.component);
  for (const [manifest, component] of manifests) {
    budget.signal.throwIfAborted();
    const limit = budget.objectReferenceReservations.get(ref)?.get(manifest);
    if (limit === undefined) throw new ErasurePreflightUnsupported('object reference refresh was not reserved');
    const result = await graph.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?revision ?component ?manifest ?erased ?duplicate WHERE {
      VALUES ?manifest { ${iri(manifest)} }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RevisionAnchor ; rv:component ?component ; rv:manifest ?manifest }
      BIND(EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } } AS ?erased)
      BIND(EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:manifest ?otherManifest
        FILTER(!sameTerm(?otherManifest, ?manifest)) } } AS ?duplicate)
    } ORDER BY ?revision LIMIT ${limit + 1}`, 65_536);
    const rows = result.results?.bindings;
    if (!rows || component !== undefined && !rows.length || rows.length > limit || rows.some(row => row.manifest?.type !== 'uri' || row.manifest.value !== manifest
      || component !== undefined && row.component?.value !== component || row.duplicate?.value !== 'false'
      || row.component?.type !== 'uri' || row.revision?.type !== 'uri'
      || row.erased?.type !== 'literal' || row.erased.datatype !== 'http://www.w3.org/2001/XMLSchema#boolean'
      || row.duplicate?.type !== 'literal' || row.duplicate.datatype !== 'http://www.w3.org/2001/XMLSchema#boolean'
      || !['true', 'false'].includes(row.erased.value))) {
      throw new ContentErasureStale('Contribution reverse references are unavailable');
    }
    if (rows.some(row => row.erased?.value !== 'true')) references.add(ref);
  }
  return references;
}

/** Charge the refresh from retained reverse-index counts before suppression.
 * Unknown command/Media roots use one aggregate lookahead read, never a scan. */
async function reserveLiveCompletion(graph: WorkActivationEnvironment,
  targets: readonly (ErasureTargetInput & { completionState?: string | null })[],
  budget: ErasurePreflightBudget): Promise<void> {
  const objects = targets.filter(target => target.kind === 'object');
  const manifestsFor = (ref: string) => [...new Set([`urn:rezics:sha256:${ref.slice(-64)}`,
    ...(budget.contributionManifests.get(ref) ?? []).map(root => root.manifest)])];
  const unknown = [...new Set(objects.flatMap(target => manifestsFor(target.ref)))].filter(manifest =>
    !budget.contributionReferenceCounts.has(manifest));
  if (unknown.length) {
    const limit = erasurePreflightRemaining(budget, 'inventoryEntries');
    const result = await graph.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?revision ?component ?manifest ?erased ?duplicate WHERE {
      VALUES ?manifest { ${unknown.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RevisionAnchor ; rv:component ?component ; rv:manifest ?manifest }
      BIND(EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } } AS ?erased)
      BIND(EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:manifest ?otherManifest
        FILTER(!sameTerm(?otherManifest, ?manifest)) } } AS ?duplicate)
    } ORDER BY ?manifest ?revision LIMIT ${limit + 1}`, 65_536);
    const rows = result.results?.bindings;
    if (!rows) throw new ContentErasureStale('object reverse-reference inventory is unavailable');
    consumeErasurePreflight(budget, 'inventoryEntries', rows.length);
    for (const manifest of unknown) budget.contributionReferenceCounts.set(manifest, 0);
    for (const row of rows) {
      if (row.manifest?.type !== 'uri' || !unknown.includes(row.manifest.value)
        || row.revision?.type !== 'uri' || row.component?.type !== 'uri'
        || row.duplicate?.value !== 'false' || !['true', 'false'].includes(row.erased?.value ?? '')) {
        throw new ContentErasureStale('object reverse-reference inventory differs');
      }
      const count = budget.contributionReferenceCounts.get(row.manifest.value)! + 1;
      if (count > 64) throw new ErasurePreflightUnsupported('object reverse-reference fanout exceeds 64');
      budget.contributionReferenceCounts.set(row.manifest.value, count);
    }
  }
  for (const target of objects) {
    if (budget.objectReferenceReservations.has(target.ref)) continue;
    const reserved = new Map(manifestsFor(target.ref).map(manifest =>
      [manifest, budget.contributionReferenceCounts.get(manifest)!] as const));
    consumeErasurePreflight(budget, 'inventoryEntries', [...reserved.values()].reduce((sum, count) => sum + count, 0));
    budget.objectReferenceReservations.set(target.ref, reserved);
  }
  const sweep = objects.filter(target => target.completionState === 'completed')
    .reduce((sum, target) => sum + (target.ref.startsWith('sha256:') ? 2 : 1), 0);
  const repair = objects.length ? 2 : 0;
  if (sweep + repair > erasurePreflightRemaining(budget, 'absenceProbes'))
    throw new ErasurePreflightUnsupported('object absence sweep leaves no repair allowance');
  budget.liveProbeShares = { sweep, repair };
}

/** Inject a shared deadline into the existing object owners, including uncached probes. */
function deadlineObjects(objects: ImmutableObjects | undefined, signal: AbortSignal): ImmutableObjects | undefined {
  if (!objects) return undefined;
  return { put: (bytes, supplied) => objects.put(bytes, supplied ?? signal),
    get: (digest, maxBytes, supplied) => objects.get(digest, maxBytes, supplied ?? signal),
    ...(objects.probe ? { probe: (digest: string) => objects.probe!(digest, signal) } : {}),
    ...(objects.deleteAndVerifyAbsent
      ? { deleteAndVerifyAbsent: (digest: string) => objects.deleteAndVerifyAbsent!(digest, signal) } : {}) };
}

async function completeLiveTargets(service: ErasureService, graph: WorkActivationEnvironment,
  report: ErasureReport, accessClient: PoolClient, budget: ErasurePreflightBudget): Promise<boolean> {
  const { signal } = budget;
  const objects: ObjectRecoveryStore = { directory: graph.objectDirectory,
    workObjects: deadlineObjects(graph.workObjects, signal),
    mediaObjects: { asset: id => deadlineObjects(service.mediaObjects?.(assetNamespace(id)), signal),
      quarantine: id => deadlineObjects(service.mediaObjects?.(`media-quarantine/${id}/`), signal) } };
  const objectTargets = report.targets.filter(target => target.kind === 'object');
  if (!budget.liveProbeShares || objectTargets.length && budget.liveProbeShares.repair < 2)
    throw new ErasurePreflightUnsupported('live object probe shares were not reserved');
  const completedPresent = new Set<number>();
  const absent = new Map<number, boolean>();
  for (const target of objectTargets.filter(target => target.completionState === 'completed')) {
    signal.throwIfAborted();
    // Replanted bytes need the same exact replay; progress is never an exemption.
    const missing = await objectErasureAbsent(objects, target.ref, budget);
    absent.set(target.ordinal, missing);
    if (!missing) completedPresent.add(target.ordinal);
  }
  // Completed presence is already known. Its verified repair spends two probes,
  // so a maximal 510-probe sweep always retains one repair instead of starving.
  let repairAllowance = erasurePreflightRemaining(budget, 'absenceProbes');
  const attempted: typeof objectTargets = [];
  for (const target of [...objectTargets.filter(target => completedPresent.has(target.ordinal)),
    ...objectTargets.filter(target => target.completionState !== 'completed')]) {
    if (attempted.length === 16) break;
    const cost = completedPresent.has(target.ordinal) ? 2 : 4;
    if (repairAllowance < cost) continue;
    repairAllowance -= cost;
    attempted.push(target);
  }
  for (const target of attempted) {
    signal.throwIfAborted();
    const digest = target.ref.slice(-64);
    const outcome = await withReferenceFence(service.content, digest, async client => {
      const references = await freshObjectProtection(client, graph, target.ref, budget);
      return applyLiveObjectErasure(objects, target.ref, { kind: 'live-bounded', references }, true, budget,
        completedPresent.has(target.ordinal));
    });
    absent.set(target.ordinal, outcome !== 'conflict');
    if (outcome === 'conflict') {
      if (target.completionState !== 'completed') {
        await failErasureTarget(service.relay, report.erasureId, target.ordinal, 'live_copy_unavailable');
      }
    } else {
      if (target.completionState !== 'completed') {
        await completeErasureTarget(service.relay, report.erasureId, target.ordinal, completionEvidence(report, target));
      }
    }
  }
  // This attempt's probes and verified deletes are fresh evidence. Completed
  // flags are never used as absence evidence, and no key spends the budget twice.
  signal.throwIfAborted();
  const contentIds = report.targets.filter(target => target.kind === 'content_revision').map(target => target.ref);
  const contentProofs = contentIds.length
    ? await probeContentErasure(service.content, report.erasureId, contentIds, report.erasureEpoch) : new Map();
  const custody = await commandCustodyErasureTargets(accessClient,
    report.targets.filter(target => isGraphErasureKind(target.kind)).map(target => `https://rezics.com/id/${target.ref}`));
  if (contentIds.some(id => contentProofs.get(id) !== 'erased')
    || custody.some(target => !target.payloadAbsent || target.erasureId !== report.erasureId
      || target.erasureEpoch !== report.erasureEpoch)) {
    throw new ErasureUnavailable('live SQL erasure completion is unavailable');
  }
  const variants = report.targets.filter(target => target.kind === 'content_variant');
  if (variants.length) {
    const asset = /^urn:rezics:variant:([0-9a-f-]{36})$/.exec(variants[0]!.ref)?.[1];
    const terminal = asset ? (await service.content.query(`SELECT a.id FROM media.asset a
      JOIN media.asset_state s ON s.id=a.state_head
      JOIN content.receipt r ON r.operation_id=s.operation_id
      WHERE a.id=$1 AND s.lifecycle='erased' AND r.outcome='succeeded'
        AND r.operation_id=$2 AND NOT EXISTS (SELECT 1 FROM media.representation p
          WHERE p.asset_id=a.id AND p.availability='available')`,
    [asset, `media-erasure:${report.erasureId}:${asset}`])).rowCount : 0;
    if (terminal !== 1) throw new ErasureUnavailable('media erasure completion is unavailable');
  }
  await readGraphErasureProof(graph.fuseki, graph.lineage, report.erasureId, report.erasureEpoch,
    graphRevisionIds(report.targets));
  signal.throwIfAborted();
  // Earlier journal evidence is immutable even when the current proof format differs.
  // Every owner above was re-probed; a completed marker never substitutes for absence.
  await relayTransaction(service.relay, async client => {
    for (const target of report.targets.filter(target => target.kind !== 'object'
      && target.completionState !== 'completed')) {
      await completeErasureTarget(service.relay, report.erasureId, target.ordinal, completionEvidence(report, target), client);
    }
  });
  const durable = (await service.relay.query<{ complete: boolean }>(`SELECT NOT EXISTS (
    SELECT 1 FROM relay.erasure_target WHERE erasure_id=$1
      AND completion_state IS DISTINCT FROM 'completed') AS complete`, [report.erasureId])).rows[0];
  const complete = objectTargets.every(target => absent.get(target.ordinal) === true)
    && durable?.complete === true;
  await service.relay.query(`UPDATE relay.erasure SET stage = 'deleting'
    WHERE id = $1 AND stage IN ('fenced', 'inventory_complete', 'deleting', 'reconciling')`,
  [report.erasureId]);
  if (!complete && objectTargets.some(target => target.completionState === 'completed' && !absent.get(target.ordinal))) {
    throw new ErasureUnavailable('completed object erasure differs from live storage');
  }
  return complete;
}
function completionEvidence(report: ErasureReport, target: ErasureReport['targets'][number]): string {
  return sha256(canonical({ erasureId: report.erasureId, erasureEpoch: report.erasureEpoch,
    ordinal: target.ordinal, owner: target.owner, kind: target.kind, ref: target.ref, liveState: 'erased' }));
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
function withPublicationFence<T>(service: ErasureService, resourceId: string,
  operation: (client: PoolClient) => Promise<T>): Promise<T> {
  return relayTransaction(service.preservationAccess, async client => {
    await lockPreservationTarget(client, resourceId);
    return operation(client);
  });
}

/** Content and its selecting home cuts share the publisher's resource fence. */
export async function requestContentErasure(service: ErasureService,
  graph: WorkActivationEnvironment, account: Pick<AccountAssertionVerifier, 'verify'>,
  access: ErasureAccess, request: Request, input: ContentErasureInput):
  Promise<{ report: ErasureReport; replayed: boolean }> {
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
  const erasureId = await findErasureByOperation(service.relay, operationId);
  if (registered.state === 'sealed') {
    if (!erasureId) throw new ErasureNotApplied('erasure admission was cancelled');
    await completeContentErasure(service, graph, access, registered, erasureId);
    return { report: await readErasure(service.relay, erasureId), replayed: true };
  }
  try { await access.claim(registered.id, requestDigest); }
  catch (error) {
    if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
    // A journaled erasure is committed intent; an unjournaled one is cancelled.
    if (!erasureId) await cancel(access, registered, new ErasureDenied('erasure dispatch is not admitted', { cause: error }));
  }
  try {
    const result = await withPublicationFence(service, input.resourceId,
      client => requestFencedContentErasure(service, graph, access, registered, input, erasureId, client));
    await result.finish();
    return { report: await readErasure(service.relay, result.erasureId), replayed: result.replayed };
  } catch (error) {
    if (error instanceof ContentErasureInvalid || error instanceof ContentErasureStale
      || error instanceof ContentErasureGraphRequired || error instanceof ErasureStale
      || error instanceof GraphErasureUnavailable || error instanceof MediaErasureUnsupported
      || error instanceof ErasurePreflightUnsupported || error instanceof MediaFenced || error instanceof MediaStale) {
      if (!await findErasureByOperation(service.relay, operationId)) await cancel(access, registered, error);
    }
    throw error;
  }
}

async function requestFencedContentErasure(service: ErasureService, graph: WorkActivationEnvironment,
  access: ErasureAccess, registered: RegisteredAdmission, input: ContentErasureInput,
  erasureId: string | null, publicationClient: PoolClient):
  Promise<{ erasureId: string; replayed: boolean; finish: () => Promise<void> }> {
  const operationId = `erasure:${registered.id}`, requestDigest = registered.requestDigest;
  // A competing same-key caller may have journaled while this caller waited for publication.
  erasureId = await findErasureByOperation(service.relay, operationId);
  let finish: (() => Promise<void>) | undefined;
  let replayed = Boolean(erasureId);
  let finished = false;
  let preflight: ErasurePreflightPlan | undefined;
  if (!erasureId) {
    preflight = { budget: createErasurePreflightBudget(), custodyReadReservation: 0 };
    const { budget } = preflight;
    graph = { ...graph, fuseki: erasureGraphClient(graph.fuseki, budget) };
    const resolved = await resolveErasureRevisions(service.content, graph.fuseki,
      input.resourceId, input.revisionIds);
    if (resolved.some(revision => revision.erased)) {
      throw new ContentErasureStale('Erasure revision is already erased');
    }
    const privatePayloads = await inventoryContributionPayloads(
      graph.fuseki, graph.objectDirectory, resolved, budget);
    const custody = await commandCustodyErasureTargets(publicationClient,
      resolved.filter(revision => isGraphErasureKind(revision.kind)).map(revision => revision.graphIri), budget);
    for (const target of custody) {
      if (!Number.isSafeInteger(target.payloadBytes) || target.payloadBytes! < 0
        || target.payloadBytes! > erasurePreflightRemaining(budget, 'metadataBytes')) {
        throw new ErasurePreflightUnsupported('erasure closure exceeds the supported preflight bound');
      }
      if (!graph.receiptCustody || !graph.workObjects || target.payloadAbsent || target.erasureId) {
        throw new ContentErasureStale('command custody is unavailable for erasure');
      }
      const bytesBefore = budget.metadataBytes;
      const source = await graph.receiptCustody.readCommitted(target.receipt, budget);
      if (!source || source.terminal.revision !== target.revision || source.payloadSha256 !== target.payloadSha256) {
        throw new ContentErasureStale('command custody is unavailable for erasure');
      }
      const bytes = budget.metadataBytes - bytesBefore;
      consumeErasurePreflight(budget, 'metadataBytes', bytes);
      preflight.custodyReadReservation += bytes;
    }
    const targets: ErasureTargetInput[] = [
      ...resolved.map(revision => ({ kind: revision.kind, ref: revision.ref })),
      ...(await selectingHomeTargets(graph, input.resourceId,
        resolved.filter(revision => revision.kind === 'content_revision').map(revision => revision.ref), resolved.length))
        .filter(home => !resolved.some(revision => isGraphErasureKind(revision.kind) && revision.ref === home.ref)),
      ...[...new Set([...privatePayloads.map(payload => payload.payloadRef),
        ...custody.map(target => `sha256:${target.payloadSha256}`)])]
        .map(ref => ({ kind: 'object' as const, ref })),
    ];
    budget.targets = targets;
    if (graphRevisionIds(targets).length > 64) {
      throw new ErasurePreflightUnsupported('erasure closure exceeds the supported preflight bound');
    }
    assertErasureJournalTargetBound(targets);
    const contentTargets = resolved.filter(revision => revision.kind === 'content_revision');
    if (contentTargets.length) {
      assertFreshContentTargets(contentTargets.map(revision => ({
        id: revision.ref, resource_id: revision.resourceId,
        availability: revision.content?.availability ?? '',
        pending_pin: revision.content?.pendingPin === true,
        active_pin: revision.content?.activePin === true,
        erasure_id: revision.content?.erasureId ?? null,
        erasure_epoch: revision.content?.erasureEpoch ?? null,
      })), contentTargets.map(revision => revision.ref), input.resourceId, true);
    }
    await preflightGraphErasure(graph.fuseki,
      graphRevisionIds(targets), budget);
    const journal = async (completeTargets: readonly ErasureTargetInput[]) => {
      assertErasureJournalTargetBound(completeTargets);
      await reserveLiveCompletion(graph, completeTargets, budget);
      const journaled = await journalErasure(service.relay, { operationId, requestDigest,
        kind: 'revision', principalId: registered.principalId, admissionId: registered.id,
        authorityEpoch: registered.authorityEpoch, targets: [...completeTargets] });
      erasureId = journaled.erasureId;
      replayed = journaled.replayed;
      return journaled;
    };
    const asset = contentTargets.length ? (await service.content.query<{ id: string }>(
      'SELECT id::text FROM media.asset WHERE id=$1', [input.resourceId.slice(-36)])).rows[0]?.id : undefined;
    if (asset) {
      if (!service.mediaObjects) throw new MediaErasureUnsupported('media object inventory is unavailable');
      const guarded = await withErasureFence(service, input.resourceId, operationId,
        async fence => {
          await withMediaErasureInventory(service.content, { asset,
            revisionIds: contentTargets.map(target => target.ref), admission: registered }, fence,
          service.mediaObjects!, async (_inventory, apply) => {
            const intent = await journal(budget.targets);
            const report = await readErasure(service.relay, intent.erasureId);
            validateCompletion(report, registered);
            await suppressGraphContentRevisions(graph.fuseki, graph.lineage, report.erasureId,
              report.erasureEpoch, graphRevisionIds(report.targets), undefined, budget);
            await apply({ relay: service.relay, erasureId: report.erasureId,
              erasureEpoch: report.erasureEpoch, graph });
          }, budget);
        }, publicationClient);
      if (guarded.held) throw new MediaFenced('media is retained under a preservation hold');
      // Media committed while the shared publication and preservation fence remains held.
      await markErasureSuppressed(service.relay, erasureId!);
      finish = await completeFencedContentErasure(service, graph, access, registered, erasureId!, true, publicationClient, preflight);
      finished = true;
    } else {
      await journal(targets);
    }
  }
  if (!finished) finish = await completeFencedContentErasure(service, graph, access, registered, erasureId!, false, publicationClient, replayed ? undefined : preflight);
  return { erasureId: erasureId!, replayed, finish: finish! };
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
 * Operator reconciler for unfinished live erasures after a lost response or
 * crash. Each tick handles one exact retained intent, with one lookahead.
 */
export async function completePendingContentErasures(service: ErasureService,
  graph: WorkActivationEnvironment, access: ErasureAccess,
  limit = 1): Promise<{ completed: number; failed: string[]; continuation: boolean }> {
  if (!Number.isInteger(limit) || limit < 1) throw new ErasureInvalid('pending erasure limit is invalid');
  const pending = await relayTransaction(service.relay, async client => {
    const rows = (await client.query<{
    id: string; admission_id: string; request_digest: string; authority_epoch: string }>(
    `SELECT id, admission_id, request_digest, authority_epoch::text AS authority_epoch
     FROM relay.erasure WHERE live_completion_pending AND kind = 'revision'
       AND stage IN ('requested', 'fenced', 'inventory_complete', 'deleting', 'reconciling')
     ORDER BY last_completion_attempt NULLS FIRST, erasure_epoch LIMIT 2 FOR UPDATE SKIP LOCKED`)).rows;
    if (rows[0]) await client.query(`UPDATE relay.erasure SET last_completion_attempt=clock_timestamp() WHERE id=$1`, [rows[0].id]);
    return rows;
  });
  const failed: string[] = [];
  let completed = 0, continuation = pending.length > 1;
  for (const row of pending.slice(0, 1)) {
    try {
      const admitted = (await service.preservationAccess.query<{ id: string; principalId: string;
        actingSubject: string; scope: string; action: string; idempotencyKey: string;
        requestDigest: string; authorityEpoch: string; expiresAt: string }>(`SELECT id::text,
        principal_id::text AS "principalId", acting_subject AS "actingSubject", scope_id AS scope, action,
        idempotency_key AS "idempotencyKey", request_digest AS "requestDigest",
        authority_epoch::text AS "authorityEpoch", expires_at::text AS "expiresAt"
        FROM access.admission WHERE id=$1`, [row.admission_id])).rows[0];
      if (!admitted || admitted.requestDigest !== row.request_digest || admitted.authorityEpoch !== row.authority_epoch) {
        throw new ErasureInvalid('retained erasure admission is unavailable');
      }
      await completeContentErasure(service, graph, access, { ...admitted, state: 'sealed',
        dispatchEligible: false, replayed: true }, row.id);
      const report = await readErasure(service.relay, row.id);
      if (report.stage === 'blocked' || report.stage === 'reconciling'
        && report.targets.every(target => target.completionState === 'completed')) completed++;
      else continuation = true;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failed.push(row.id);
    }
  }
  return { completed, failed, continuation: continuation || failed.length > 0 };
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
  let proofIds: string[] = [];
  try {
    const report = await readErasure(relay, row.id);
    const contentTargets = report.targets.filter(target => target.owner === 'content'
      && target.kind === 'content_revision');
    const known = report.targets.every(target => target.owner === ERASURE_TARGET_OWNERS[target.kind]
      && (target.kind === 'content_revision' || isGraphErasureKind(target.kind)
        || target.kind === 'content_variant' || target.kind === 'object'));
    ids = contentTargets.map(target => target.ref);
    proofIds = graphRevisionIds(report.targets);
    if (!isValidErasureTargetList(report.targets)
      || !known || contentTargets.some(target => !UUID.test(target.ref))
      || report.erasureEpoch !== row.epoch) return done('malformed');
    if (!ids.length) return done('foreign');
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
        const graphProof = await readGraphErasureProof(graph.fuseki, graph.lineage, row.id, row.epoch, proofIds);
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
