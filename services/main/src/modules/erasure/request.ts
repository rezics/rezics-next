import type { Pool } from 'pg';
import { withPreservationFence } from '../public-report/preservation.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type GraphTerminalProof, type RegisteredAdmission } from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { applyContentErasure, checkContentErasureTargets, ContentErasureGraphRequired,
  contentErasureResource, ContentErasureInvalid, ContentErasureStale } from './content.ts';
import { readGraphErasureProof, suppressGraphContentRevisions } from './graph.ts';
import { ERASURE_JOURNAL_EPOCH, ErasureNotFound, ErasureStale, findErasureByOperation,
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
  preservationAccess?: Pool;
  constructor(readonly relay: Pool, readonly content: Pool) {}
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
  if (journaled.stage === 'blocked' && journaled.blockedReason?.startsWith('Governance preservation hold')) {
    await access.recordGraphOutcome(admission.id, proof(admission, 'succeeded', journaled.erasureEpoch));
    return;
  }
  if (journaled.stage === 'requested') {
    try {
      const resourceId = admission.scope.slice('erasure:'.length);
      const erase = async () => {
        await suppressGraphContentRevisions(graph.fuseki, graph.lineage, erasureId,
          journaled.erasureEpoch, revisionIds);
        const graphProof = await readGraphErasureProof(graph.fuseki, graph.lineage, erasureId,
          journaled.erasureEpoch, revisionIds);
        await applyContentErasure(service.content, { erasureId, erasureEpoch: journaled.erasureEpoch,
          resourceId, revisionIds, graphProof });
        await markErasureSuppressed(service.relay, erasureId);
      };
      const held = service.preservationAccess
        ? (await withPreservationFence(service.preservationAccess, resourceId, erasureId, erase)).held
        : (await erase(), false);
      if (held) {
        await markErasureBlocked(service.relay, erasureId, 'Governance preservation hold: material retained');
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
