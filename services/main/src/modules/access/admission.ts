import { assertControllerContinuity, lockControllerContinuity, principalControllerSubjects } from './controller-continuity.ts';
import { applyAccountDeletionAgents, continueAccountDeletionAgents, collectAccountDeletionAgents, assertAccountDeletionContinuity, lockAccountDeletionTopology,
  type AccountDeletionOptions } from './account-deletion-agents.ts';
import { captureAuthorityWitness, authorityWitnessCurrent, authorityWitnessDeadline,
  type AuthoritySource, type AuthorityWitness } from './authority-witness.ts';
import { admissionAuthorityAction, admissionPolicyAllowed } from './policy-decisions.ts';
import { PolicyUnavailable } from './policy-errors.ts';
import { withPreservationFence, type PreservationFence } from '../public-report/preservation.ts';
import { requirePlatformParticipation } from '../safety-queue/participation.ts';
import { requireRealmParticipation } from './realm-management-settings.ts';
import { withRealmPermit, type RealmPermit } from './realm-management-policy.ts';
import { RealmDirectoryIndex } from '../realm-directory/index.ts';
import { createHash } from 'node:crypto';
import { receiptFamilyFor } from './receipt-families.ts';
import { Pool, type PoolClient } from 'pg';
import { recordRatingAggregateHead, readRatingAggregateInventory,
  checkRatingAggregateFence, readRatingContextPolicyWitness, type StandingRatingCut } from '../rating/aggregate-inventory.ts';
import { directWorkCreateProof, selectedDirectWorkProof } from './direct-principal.ts';
import { groupWorkCreateProof, GroupUnavailable } from './groups.ts';
import { representedWorkProof, selectedRepresentedWorkProof, saveInvitedWorkProof,
  type RepresentedWorkProof } from './represented-work-proof.ts';
import { publicCatalogueWork, roleWorkCreateProof, roleWorkProof } from './role-proof.ts';
import { withWorkEditAuthority, type WorkEditAuthorityProof } from './work-edit-authority.ts';
import { issueTitleAdmission } from './title-admission.ts';
import type { CommandEnvelope } from '../../infrastructure/fuseki.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { baselineMemberProof, baselineProofCurrent, baselineTargetAllowed, baselineWorkTypesAllowed, baselineWorkPreviewAllowed,
  newBaselineProof, saveBaselineProof, savedBaselineProof, type ReplyRootDecision } from './baseline.ts';
import { resolveZonePageContent, savedZonePageContent, zonePageAdministratorAllowed,
  zoneEditScope, ZONE_PAGE_CONTENT_PROOF } from './zone-content-authority.ts';
import { reserveBaselineSpace, settleBaselineSpace } from './baseline-quota.ts';
import { zoneSpaceCreatorAllowed } from '../space/create-authority.ts';
import { ensureBaselineScopeGate, lockAccessKey, lockAdmissionKey } from './scope-gates.ts';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { recordInitialMaintainer } from '../work/maintainer-proof.ts';
import { publicInTransaction, readReferenceDisclosure, requireDisclosureGraph,
  SEMANTIC_DISCLOSURE_LIMIT } from './semantic-disclosure.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { disclosureGraphEnvironment } from '../disclosure/read.ts';
import { readableReplyRoot } from '../realm-reply/root.ts';
import { realmPermit } from './realm-management-policy.ts';
import { WorkReadMoved, WorkReadUnavailable } from '../work/read-session.ts';
import { SummaryGraphMoved } from '../media/summary.ts';
import { checkEditorialAdmission, registerEditorialAdmission, withCommandOwnerAuthority } from '../editorial-review/admission.ts';
import { platformAdministratorAction, platformAdministratorTargetAllowed, platformAdministratorProof,
  savedPlatformAdministratorProof, savePlatformAdministratorProof,
  platformAdministratorProofCurrent } from './platform-administrator.ts';
import { accessClient,withAccessClient,controlTransaction,requirePrincipal,requireMandate,ControlConflict,ControlDenied,ControlUnavailable } from './topology-control.ts';
import { realmTransaction,realmManager } from './realm-management-authority.ts';
import { RealmAdminDenied,RealmAdminUnavailable } from '../realm-admin/contract.ts';
import { realmRatingProof, savedRealmRatingProof, saveRealmRatingProof, ratingConfigurationAction } from './realm-roles-rating.ts';

export { AccountHasOwnedAgents, type AccountOwnedAgent, type AccountDeletionOptions } from './account-deletion-agents.ts';
export { hasRealmConceptPermission } from './realm-management-authority.ts';

/** Populated only by Account assertion verification, never from a request body. */
export interface VerifiedPrincipal {
  issuer: string;
  subject: string;
  /** Current Account introspection only; absent never implies verified. */
  emailVerified?: boolean;
  /** Live Account decision; never a cached JWT or client-supplied birthday. */
  contentEvidence?: { age: 'unknown' | 'under-15' | '15-17' | 'adult'; country: string | null;
    accountEligible: boolean; adultAvailable: boolean;
    nsfwDisplay?: 'mask' | 'show';
    categories: { general: boolean; r15: boolean; r18: boolean; r18g: boolean } };
  /** Server-only callback bound to the original token and OAuth scope ceiling. */
  currentAssertion?: () => Promise<VerifiedPrincipal>;
}

/** An actual acknowledged command from the Access ledger, not a receipt name
 * reconstructed by a consumer from an admission, component or revision. */
export interface AcknowledgedOwnerCommand {
  admissionId: string; receipt: string; action: string; actingSubject: string; scope: string;
  requestDigest: string; authorityEpoch: string; dataEpoch: string; sequence: string;
}

export interface AdmissionRequest {
  /** Owner-only restriction, bound by requestDigest: a sourced publication cannot borrow its transcriber's creator baseline. */
  requireExplicitGrant?: boolean;
  /** Server-issued, durable proposal/revision/owner-command permit. */
  editorialPermit?: string;
  principal: VerifiedPrincipal;
  actingSubject: string;
  /** Omitted by existing commands; direct authority is currently work.create only. */
  authorityPath?: 'represented-agent' | 'direct-principal';
  scope: string;
  action: string;
  idempotencyKey: string;
  requestDigest: string;
  /** Owner adapter only: authorizes creating an absent personal Collection. */
  baselineCollectionCreate?: boolean;
  /** Owner-bound rating target or translation source, covered by requestDigest. */
  baselineRelatedWork?: string;
  /** Owner-bound quoted Content revision; a public Work does not disclose drafts. */
  baselineSourceRevision?: string;
  /** Exact public contribution offered by the submission owner. */
  baselineContribution?: string;
  /** Server-resolved Zone that owns this Content page. Content sets it after
   * resolution and covers it in requestDigest; a request body must not. */
  resolvedZonePage?: string;
  /** Owner-bound type configuration, covered by the Work creation digest. */
  workSemanticTypes?: readonly string[];
}

interface MemberReplyAuthoringIntent {
  valid: boolean;
}

const nativeMemberReplyResource = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const memberReplyRevision = /^(?:[0-9a-f-]{36}|https:\/\/rezics\.com\/id\/[0-9a-f-]{36})$/;

/** Reply drafts and their Media uses carry their root only in owner-bound
 * admission metadata. Keep malformed or partial metadata out of Work authority. */
function memberReplyAuthoringIntent(request: AdmissionRequest): MemberReplyAuthoringIntent | null {
  const hasReplyRootMetadata = request.baselineRelatedWork !== undefined
    || request.baselineSourceRevision !== undefined;
  if (request.action === 'reply.create') {
    return { valid: /^reply:create:https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(request.scope)
      && request.baselineRelatedWork === undefined
      && memberReplyRevision.test(request.baselineSourceRevision ?? '')
      && request.baselineContribution === undefined
      && request.baselineCollectionCreate !== true
      && request.resolvedZonePage === undefined };
  }
  const memberReplyMedia = request.action === 'media.member-reply.use';
  if (!memberReplyMedia && (request.action !== 'content.draft' || !hasReplyRootMetadata)) return null;
  const prefix = 'content:draft:';
  const reply = request.scope.startsWith(prefix) ? request.scope.slice(prefix.length) : '';
  return { valid: nativeMemberReplyResource.test(reply)
    && nativeMemberReplyResource.test(request.baselineRelatedWork ?? '')
    && (memberReplyMedia ? nativeMemberReplyResource : memberReplyRevision)
      .test(request.baselineSourceRevision ?? '')
    && request.baselineContribution === undefined
    && request.baselineCollectionCreate !== true
    && request.resolvedZonePage === undefined };
}

export interface RegisteredAdmission {
  id: string;
  principalId: string;
  actingSubject: string;
  authorityPath?: 'represented-agent' | 'direct-principal';
  scope: string;
  action: string;
  idempotencyKey: string;
  requestDigest: string;
  authorityEpoch: string;
  /** Durable Access clock instant; daily rating requires it, legacy fixtures may omit it. */
  registeredAt?: string;
  expiresAt: string;
  state: 'registered' | 'claimed' | 'sealed';
  dispatchEligible: boolean;
  replayed: boolean;
}

export interface ClaimedAdmission extends RegisteredAdmission {
  claimedAt: string;
}

export interface StrongScopeClosure {
  scope: string;
  authorityEpoch: string;
  /** Commands and private search deliveries still requiring terminal resolution. */
  pending: number;
  pendingReads: number;
}

export interface StrongPrincipalDeactivation {
  principalId: string;
  enforcementEpoch: string;
  pending: number;
  pendingReads: number;
}

/** A single Contribution's private phrase admission; it is not an Access grant. */
export interface ContributionSearchReadLease {
  id: string;
  principalId: string;
  actingSubject: string;
  contribution: string;
  scope: string;
  authorityEpoch: string;
  principalEpoch: string;
  recoveryGeneration: string;
  expiresAt: string;
  state: 'admitted' | 'delivering';
}

export interface UnresolvedContributionSearchDelivery {
  id: string;
  principalId: string;
  scope: string;
  contribution: string;
  deliveryStartedAt: string;
  sendStartedAt: string | null;
  expiresAt: string;
}

/** Admission expires after ten seconds; the adapter must also stop delivery. */
export const CONTRIBUTION_SEARCH_READ_LEASE_MS = 10_000;
export const MAX_PRINCIPAL_SEARCH_READS = 16;
export const MAX_SCOPE_SEARCH_READS = 64;

export interface GraphTerminalProof {
  outcome: 'succeeded' | 'cancelled';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
}

export class AdmissionDenied extends Error {}
export class AdmissionUnavailable extends Error {}
export class AdmissionConflict extends Error {}
/** A command transaction timed out waiting for a row lock; retry the same key. */
export class AdmissionLockBusy extends Error {}
/** A removal that would leave a resource with no controller. Distinct from an idempotency clash. */
export class AdmissionControllerContinuity extends Error {}
export class AdmissionExpired extends Error {}

/** Admissions share the scope's policy/closure fence. Selected authority rows
 * stay locked through register and claim; terminal seals acknowledge an exact
 * graph receipt. Scope-wide policy changes remain exclusive. Receipt retries
 * and inventory moves serialize on their own key or object. */
const admissionGateLock = 'SHARE';
class AuthorityChecked extends Error {}

interface GateRow { authority_epoch: string; open: boolean; dispatch_open: boolean }

interface LockedAdmissionIdentity {
  gate: GateRow & { group_generation: string };
  principal: { id: string; active: boolean; enforcement_epoch: string };
}
interface SearchReadRow {
  id: string; principal_id: string; acting_subject: string; contribution: string;
  scope_id: string; representation_id: string; grant_id: string;
  authority_epoch: string; principal_epoch: string; subject_generation: string;
  recovery_generation: string;
  representation_generation: string; grant_generation: string;
  expires_at: Date; state: string;
  send_started_at: Date | null; receipt_digest: string | null;
}
const nativeContribution = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

function contributionSearchLease(row: SearchReadRow): ContributionSearchReadLease {
  return { id: row.id, principalId: row.principal_id, actingSubject: row.acting_subject,
    contribution: row.contribution, scope: row.scope_id,
    authorityEpoch: row.authority_epoch, principalEpoch: row.principal_epoch,
    recoveryGeneration: row.recovery_generation,
    expiresAt: row.expires_at.toISOString(),
    state: row.state as ContributionSearchReadLease['state'] };
}

/** Expired admissions cannot begin delivery. Delivering reads require an explicit
 * finish even after expiry: time alone cannot prove that bytes stopped flowing. */
async function pendingSearchReads(client: PoolClient, column: 'scope_id' | 'principal_id',
  value: string, close = false): Promise<number> {
  await client.query(`UPDATE access.search_read_lease SET state = 'expired',
      finished_at = clock_timestamp()
    WHERE ${column} = $1 AND state = 'admitted' AND expires_at <= clock_timestamp()`, [value]);
  if (close) {
    // The gate/principal lock makes a later delivery start impossible. Work that
    // has not started delivery can be aborted without waiting for its query.
    await client.query(`UPDATE access.search_read_lease SET state = 'aborted',
        finished_at = clock_timestamp()
      WHERE ${column} = $1 AND state = 'admitted'`, [value]);
  }
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM access.search_read_lease
     WHERE ${column} = $1 AND state IN ('admitted', 'delivering')`, [value]);
  return Number(result.rows[0]?.count ?? '0');
}
interface AdmissionRow {
  authority_witness: AuthorityWitness[] | null;
  id: string;
  principal_id: string;
  acting_subject: string;
  authority_path: 'represented-agent' | 'direct-principal';
  direct_grant_id: string | null;
  attribution_id: string | null;
  direct_grant_generation: string | null;
  attribution_generation: string | null;
  direct_subject_generation: string | null;
  direct_principal_epoch: string | null;
  private_group_member_id: string | null;
  private_group_member_generation: string | null;
  private_group_grant_id: string | null;
  private_group_grant_generation: string | null;
  private_group_generation: string | null;
  private_role_binding_id: string | null;
  private_role_binding_generation: string | null;
  private_role_family_id: string | null;
  private_role_revision: string | null;
  group_member_id: string | null;
  group_grant_id: string | null;
  group_generation: string | null;
  represented_representation_id: string | null;
  represented_representation_generation: string | null;
  represented_grant_id: string | null;
  represented_grant_generation: string | null;
  represented_subject_generation: string | null;
  represented_principal_epoch: string | null;
  role_binding_id: string | null;
  role_binding_generation: string | null;
  role_family_id: string | null;
  role_revision: string | null;
  scope_id: string;
  action: string;
  idempotency_key: string;
  request_digest: string;
  authority_epoch: string;
  expires_at: Date;
  registered_at: Date;
  state: string;
  eligible: boolean;
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
}

function admissionError(error: unknown): unknown {
  if (error instanceof GroupUnavailable || error instanceof PolicyUnavailable) {
    return new AdmissionUnavailable(error.message);
  }
  if (error && typeof error === 'object' && 'code' in error && String(error.code) === '55P03') {
    return new AdmissionLockBusy('Access admission lock timed out');
  }
  // A failed indexed authority read, including a PostgreSQL timeout or a
  // connection failure, cannot become evidence that authority is absent.
  if (error && typeof error === 'object' && 'code' in error) {
    return new AdmissionUnavailable('Access admission could not complete');
  }
  return error;
}

async function admissionClient(pool: Pool): Promise<PoolClient> {
  try { return await pool.connect(); }
  catch { throw new AdmissionUnavailable('Access admission store could not be reached'); }
}

/** Reads whose only writes are FOR SHARE locks commit asynchronously; see controlRead. */
const READ_BEGIN = 'BEGIN; SET LOCAL synchronous_commit = off';

/** A passed client is the caller's checkout and transaction. Otherwise this
 * read opens and ends its own. */
async function readAdmission<T>(pool: Pool, client: PoolClient | undefined,
  work: (client: PoolClient) => Promise<T>): Promise<T> {
  const borrowed = client ?? accessClient(pool);
  return withAccessClient(pool, async connected => {
    if (borrowed) return work(connected);
    try {
      await connected.query(READ_BEGIN);
      await connected.query("SET LOCAL lock_timeout = '2s'");
      await connected.query("SET LOCAL statement_timeout = '5s'");
      const value = await work(connected);
      await connected.query('COMMIT');
      return value;
    } catch (error) {
      await rollback(connected);
      throw error;
    }
  }, borrowed);
}

async function requireRecoveryOpen(client: PoolClient): Promise<string> {
  const result = await client.query<{ open: boolean; generation: string }>(
    'SELECT open, generation FROM access.recovery_fence WHERE id = true FOR SHARE');
  if (result.rows[0]?.open !== true) throw new AdmissionUnavailable('Access is held for recovery');
  return result.rows[0]!.generation;
}

async function baselineMemberDecision(client: PoolClient, principal: VerifiedPrincipal,
  actingSubject: string): Promise<boolean> {
  await requireRecoveryOpen(client);
  const identity = await client.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
  [principal.issuer, principal.subject]);
  return !!identity.rows[0] && !!await baselineMemberProof(client, identity.rows[0].id, actingSubject);
}

interface ScopedReadFacts {
  principalId?: string;
  gateOpen?: boolean;
  hasPolicy: boolean;
  authority?: { subject: boolean; represented?: string; granted?: string };
}

const nativeReadTarget = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
function checkedReadTargets(targets: readonly string[]): string[] {
  const unique = [...new Set(targets.filter(target => nativeReadTarget.test(target)))];
  if (unique.length > 101) throw new RangeError('read target batch exceeds its immutable range');
  return unique;
}

/** Singleton and page reads load the same facts and use the same decision.
 * Exact baselines and policy evaluation below remain the owner's existing proofs. */
async function scopedResourceDecisions(client: PoolClient, graph: Pick<FusekiClient, 'query'> | undefined,
  principal: VerifiedPrincipal, actingSubject: string, scopes: readonly string[], action: string,
  privatePreview = false): Promise<ReadonlySet<string>> {
  const unique = [...new Set(scopes)], allowed = new Set<string>();
  if (!unique.length) return allowed;
  await requireRecoveryOpen(client);
  const gates = unique.length === 1
    ? (await client.query<{ open: boolean }>('SELECT open FROM access.scope_gate WHERE id = $1 FOR SHARE', unique))
      .rows.map(row => ({ id: unique[0]!, open: row.open }))
    : (await client.query<{ id: string; open: boolean }>(
      'SELECT id, open FROM access.scope_gate WHERE id = ANY($1::text[]) FOR SHARE', [unique])).rows;
  const gateById = new Map(gates.map(row => [row.id, row.open]));
  if (unique.every(scope => gateById.get(scope) === false)) return allowed;
  const identity = await client.query<{ id: string }>(
    `SELECT id FROM access.principal WHERE account_issuer = $1 AND account_subject = $2
      AND active FOR SHARE`, [principal.issuer, principal.subject]);
  const principalId = identity.rows[0]?.id;
  if (!principalId) return allowed;
  const policies = unique.length === 1
    ? (await client.query('SELECT id FROM access.policy WHERE scope_id = $1', unique)).rows.map(() => unique[0]!)
    : (await client.query<{ scope_id: string }>('SELECT scope_id FROM access.policy WHERE scope_id = ANY($1::text[])',
      [unique])).rows.map(row => row.scope_id);
  const installed = new Set(policies);
  let authorities: Map<string, NonNullable<ScopedReadFacts['authority']>> | undefined;
  if (unique.length > 1) {
    const subject = await client.query('SELECT id FROM access.authority_subject WHERE id = $1 AND active FOR SHARE', [actingSubject]);
    const represented = await client.query<{ id: string }>(
      `SELECT id FROM access.representation WHERE principal_id = $1 AND subject_id = $2
        AND action = $3 AND active AND valid_until > clock_timestamp()
        ORDER BY id LIMIT 1 FOR SHARE`, [principalId, actingSubject, action]);
    const grants = await client.query<{ id: string; scope_id: string }>(
      `SELECT wanted.scope_id, granted.id FROM unnest($2::text[]) AS wanted(scope_id)
        JOIN LATERAL (SELECT id FROM access.permission_grant WHERE recipient_subject = $1
          AND scope_id = wanted.scope_id AND action = $3 AND active AND valid_until > clock_timestamp()
          ORDER BY id LIMIT 1 FOR SHARE) granted ON true`, [actingSubject, unique, action]);
    const grantByScope = new Map(grants.rows.map(row => [row.scope_id, row.id]));
    authorities = new Map(unique.map(scope => [scope, { subject: subject.rowCount === 1,
      represented: represented.rowCount === 1 ? represented.rows[0]!.id : undefined, granted: grantByScope.get(scope) }]));
  }
  for (const scope of unique) {
    if (await scopedResourceDecision(client, graph, principal, actingSubject, scope, action,
      { principalId, gateOpen: gateById.get(scope), hasPolicy: installed.has(scope), authority: authorities?.get(scope) }, privatePreview)) {
      allowed.add(scope);
    }
  }
  return allowed;
}

async function scopedResourceDecision(client: PoolClient, graph: Pick<FusekiClient, 'query'> | undefined,
  principal: VerifiedPrincipal, actingSubject: string, scope: string, action: string,
  facts: ScopedReadFacts, privatePreview = false): Promise<boolean> {
  const { principalId, gateOpen, hasPolicy } = facts;
  if (gateOpen === false || !principalId) return false;
  // A batched explicit permit is sufficient without probing alternate graph
  // baselines for every member. Installed policy still evaluates its witness.
  if (gateOpen && !hasPolicy && facts.authority?.subject
    && facts.authority.represented && facts.authority.granted) return true;
  if (!privatePreview && platformAdministratorAction(action, scope)
    && !hasPolicy
    && await platformAdministratorProof(client, principalId, actingSubject)
    && await platformAdministratorTargetAllowed(client, graph, principalId, actingSubject, action, scope)) {
    return true;
  }
  const readKind = action === 'work.read' ? 'work' : action === 'semantic.read' ? 'collection'
    : action === 'contribution.read' ? 'contribution' : null;
  const targetId = scope.slice(scope.indexOf(':', scope.indexOf(':') + 1) + 1);
  if (action === 'work.read' && principal.emailVerified === true
    && !hasPolicy
    && await baselineWorkPreviewAllowed(client, graph, principalId, actingSubject, targetId)) {
    return true;
  }
  if (action === 'semantic.read'
    && !hasPolicy
    && await zoneSpaceCreatorAllowed(client, graph, principalId, actingSubject, targetId)) {
    return true;
  }
  if (!privatePreview && readKind && principal.emailVerified === true
    && !hasPolicy
    && await baselineMemberProof(client, principalId, actingSubject)
    && await baselineTargetAllowed(client, graph, principalId, actingSubject,
      { kind: readKind, id: targetId }, false)) {
    return true;
  }
  if (!gateOpen) return false;
  const subject = facts.authority ? { rowCount: facts.authority.subject ? 1 : 0 } : await client.query(
    'SELECT id FROM access.authority_subject WHERE id = $1 AND active FOR SHARE', [actingSubject]);
  const represented = facts.authority ? { rowCount: facts.authority.represented ? 1 : 0,
    rows: [{ id: facts.authority.represented! }] } : await client.query(
    `SELECT id FROM access.representation WHERE principal_id = $1 AND subject_id = $2
      AND action = $3 AND active AND valid_until > clock_timestamp()
      ORDER BY id LIMIT 1 FOR SHARE`, [principalId, actingSubject, action]);
  const granted = facts.authority ? { rowCount: facts.authority.granted ? 1 : 0,
    rows: [{ id: facts.authority.granted! }] } : await client.query(
    `SELECT id FROM access.permission_grant WHERE recipient_subject = $1 AND scope_id = $2
      AND action = $3 AND active AND valid_until > clock_timestamp()
      ORDER BY id LIMIT 1 FOR SHARE`, [actingSubject, scope, action]);
  if (subject.rowCount !== 1 || represented.rowCount !== 1 || granted.rowCount !== 1) return false;
  if (!hasPolicy) return true;
  const witness = await captureAuthorityWitness(client, [
    { table: 'representation', id: represented.rows[0]!.id },
    { table: 'permission_grant', id: granted.rows[0]!.id },
  ]);
  return admissionPolicyAllowed(client, principalId, actingSubject, scope, action, { witness, eligible: true });
}

/** Operator-only fence. The update waits for in-flight ordinary Access transactions. */
export async function engageAccessRecoveryFence(pool: Pool): Promise<string> {
  const result = await pool.query<{ generation: string }>(
    `UPDATE access.recovery_fence SET open = false,
       generation = generation + CASE WHEN open THEN 1 ELSE 0 END
     WHERE id = true RETURNING generation`);
  if (result.rowCount !== 1) throw new AdmissionUnavailable('Access recovery fence is unavailable');
  return result.rows[0]!.generation;
}

/** Release follows successful graph/authority reconciliation. */
export async function lockAccessRecoveryFenceForRelease(client: PoolClient, generation: string): Promise<void> {
  if (!/^[0-9]+$/.test(generation)) throw new AdmissionUnavailable('invalid Access recovery generation');
  const fence = (await client.query<{ open: boolean; generation: string }>(
    'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true FOR UPDATE')).rows[0];
  if (fence?.open !== false || fence.generation !== generation) {
    throw new AdmissionUnavailable('Access recovery fence changed');
  }
  const delivering = (await client.query<{ delivering: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM access.search_read_lease WHERE state = 'delivering')
    OR EXISTS (SELECT 1 FROM access.download_read_lease WHERE state = 'delivering') AS delivering`)).rows[0];
  if (delivering?.delivering !== false) throw new AdmissionUnavailable('Access delivery is still active');
}

export async function releaseAccessRecoveryFence(pool: Pool | PoolClient, generation: string): Promise<void> {
  if (!/^[0-9]+$/.test(generation)) throw new AdmissionUnavailable('invalid Access recovery generation');
  const result = await pool.query(
    `UPDATE access.recovery_fence SET open = true, generation = generation + 1
     WHERE id = true AND open = false AND generation = $1
       AND NOT EXISTS (SELECT 1 FROM access.search_read_lease WHERE state = 'delivering')
       AND NOT EXISTS (SELECT 1 FROM access.download_read_lease WHERE state = 'delivering')`, [generation]);
  if (result.rowCount !== 1) throw new AdmissionUnavailable('Access recovery fence changed');
}

export class AccessAdmissionRegistry {
  withRealmPolicy<T>(principal: VerifiedPrincipal, actor: string, realm: string,
    purpose: 'read' | 'reply' | 'submission', operation: (permit: RealmPermit, client?: PoolClient) => Promise<T>) {
    return withRealmPermit(this.pool, principal, actor, realm, purpose, operation);
  }

  async realmReadProof(principal: VerifiedPrincipal, actor: string, realm: string): Promise<string | null> {
    try { return await this.withRealmPolicy(principal, actor, realm, 'read', async permit => permit.stamp); }
    catch (error) { if (error instanceof AdmissionDenied) return null; throw error; }
  }
  realmHistoryFloor(principal: VerifiedPrincipal, actor: string, realm: string) {
    return this.withRealmPolicy(principal, actor, realm, 'read', async permit => permit.historyFloor);
  }
  readonly realmDirectory: RealmDirectoryIndex;
  constructor(private readonly pool: Pool, private readonly titleAdmissionKey = Bun.env.FUSEKI_TITLE_ADMISSION_KEY) {
    this.realmDirectory = new RealmDirectoryIndex(pool);
  }

  /** Anonymous reads and readiness share the same restore gate as admissions. */
  async assertRecoveryOpen(): Promise<void> {
    const row = (await (accessClient(this.pool) ?? this.pool).query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true')).rows[0];
    if (row?.open !== true) throw new AdmissionUnavailable('Access is held for recovery');
  }

  async hasRealmMemberAdmission(id: string): Promise<boolean> {
    return (await this.pool.query(`SELECT 1 FROM access.baseline_admission
      WHERE admission_id = $1 AND realm_membership IS NOT NULL`, [id])).rowCount === 1;
  }

  async publicRealmCount(realm: string): Promise<{ kind: 'exact'; value: number; revision: string }> {
    const row = (await (accessClient(this.pool) ?? this.pool).query<{ value: string; revision: string }>(`
      SELECT c.value, c.revision FROM access.recovery_fence f
      LEFT JOIN access.realm_member_count c ON c.realm = $1 WHERE f.id AND f.open`, [realm])).rows[0];
    if (!row) throw new AdmissionUnavailable('Realm count recovery is held');
    const value = Number(row?.value ?? '0');
    if (!Number.isSafeInteger(value) || value < 0) throw new AdmissionUnavailable('Realm count is unavailable');
    return { kind: 'exact', value, revision: row?.revision ?? '0' };
  }

  private baselineGraph?: Pick<FusekiClient, 'query'>;

  /** Composition supplies the existing bounded graph client; Access owns the rules. */
  configureBaseline(graph: Pick<FusekiClient, 'query'>): void { this.baselineGraph = graph; }

  /** Root visibility is resolved per request using this admission's held client. */
  private replyRootDecision(client: PoolClient, principal: VerifiedPrincipal,
    actingSubject: string): ReplyRootDecision {
    return async (resource, revision) => {
      const graph = this.baselineGraph;
      const environment = graph && disclosureGraphEnvironment(graph);
      if (!environment) throw new AdmissionUnavailable('authenticated reply root environment is unavailable');
      const readers = {
        realmReadProof: async (_principal: VerifiedPrincipal, _actor: string, realm: string) => {
          try { return (await realmPermit(client, principal, actingSubject, realm, 'read')).stamp; }
          catch (error) { if (error instanceof AdmissionDenied) return null; throw error; }
        },
        canReadWork: (_principal: VerifiedPrincipal, _actor: string, work: string) =>
          this.canReadWork(principal, actingSubject, work, client),
        canReadSemanticResource: (_principal: VerifiedPrincipal | null, _actor: string | null,
          semanticResource: string, semanticRevision?: string) => this.canReadSemanticResource(
          principal, actingSubject, semanticResource, semanticRevision, graph, client),
        client,
      };
      try {
        return await readableReplyRoot(environment, resource, revision, readers, principal, actingSubject);
      } catch (error) {
        if (error instanceof WorkReadMoved || error instanceof SummaryGraphMoved
          || error instanceof AdmissionDenied || error instanceof AdmissionConflict
          || error instanceof AdmissionUnavailable || error instanceof AdmissionExpired) throw error;
        if (error instanceof WorkReadUnavailable) {
          throw new AdmissionUnavailable('authenticated reply root owner is unavailable', { cause: error });
        }
        if (error && typeof error === 'object' && 'code' in error) throw error;
        throw new AdmissionUnavailable('authenticated reply root owner is unavailable', { cause: error });
      }
    };
  }

  issueTitleAdmission(admission: RegisteredAdmission, command: CommandEnvelope) {
    return issueTitleAdmission(this.pool, admission, command, this.titleAdmissionKey);
  }

  readRatingAggregateInventory(context: string, mainVersion: string, signal?: AbortSignal, onlySlot?: string) {
    return readRatingAggregateInventory(this.pool, context, mainVersion, signal, onlySlot);
  }

  checkRatingAggregateFence(generation: string, signal?: AbortSignal, cuts?: readonly StandingRatingCut[]) {
    return checkRatingAggregateFence(this.pool, generation, signal, cuts);
  }

  readRatingContextPolicyWitness(context: string, signal?: AbortSignal) {
    return readRatingContextPolicyWitness(this.pool, context, signal);
  }

  async withWorkEditAuthority<T>(principal: VerifiedPrincipal, actingSubject: string,
    work: string, commit: (proof: WorkEditAuthorityProof) => Promise<T>): Promise<T> {
    return withWorkEditAuthority(this.pool, principal, actingSubject, work, commit, this.baselineGraph);
  }

  /** Read the independent Access ledger for a Content revision's immutable author proof. */
  async verifyContentDraftProof(proof: {
    admissionId: string; author: string; scope: string; requestDigest: string;
    authorityEpoch: string; contentEpoch: string; contentSequence: string;
  }): Promise<boolean> {
    const result = await this.pool.query<{
      acting_subject: string; scope_id: string; request_digest: string;
      authority_epoch: string; state: string; graph_outcome: string;
      graph_receipt: string; graph_data_epoch: string; graph_sequence: string;
    }>(`SELECT acting_subject, scope_id, request_digest, authority_epoch,
        state, graph_outcome, graph_receipt, graph_data_epoch, graph_sequence
      FROM access.admission
      WHERE id = $1 AND action = 'content.draft'`, [proof.admissionId]);
    const row = result.rows[0];
    const expectedReceipt = `urn:rezics:receipt:${createHash('sha256')
      .update(`${proof.admissionId}\0content-draft-save`).digest('hex')}`;
    return result.rowCount === 1 && row?.state === 'sealed'
      && row.graph_outcome === 'succeeded' && row.graph_receipt === expectedReceipt
      && row.acting_subject === proof.author && row.scope_id === proof.scope
      && row.request_digest === proof.requestDigest
      && row.authority_epoch === proof.authorityEpoch
      && row.graph_data_epoch === proof.contentEpoch
      && row.graph_sequence === proof.contentSequence;
  }

  /** Current Work-specific disclosure decision; no historical grant is reused. */
  async canReadWork(principal: VerifiedPrincipal, actingSubject: string, work: string,
    client?: PoolClient): Promise<boolean> {
    return (await this.canReadWorks(principal, actingSubject, [work], client)).has(work);
  }

  /** Only the native maintainer proof or an explicit current read grant selects
   * private revisions. Public reading and platform status supply no preview. */
  async canPreviewWork(principal: VerifiedPrincipal, actingSubject: string, work: string): Promise<boolean> {
    if (!nativeReadTarget.test(work) || !nativeReadTarget.test(actingSubject)) return false;
    const scope = `work:read:${work}`;
    return readAdmission(this.pool, undefined, async client =>
      (await scopedResourceDecisions(client, this.baselineGraph, principal, actingSubject,
        [scope], 'work.read', true)).has(scope));
  }

  canReadWorks(principal: VerifiedPrincipal, actingSubject: string, works: readonly string[],
    client?: PoolClient): Promise<ReadonlySet<string>> {
    const unique = checkedReadTargets(works);
    if (!unique.length || !nativeReadTarget.test(actingSubject)) return Promise.resolve(new Set());
    return readAdmission(this.pool, client, async held => {
      const scopes = await scopedResourceDecisions(held, this.baselineGraph, principal, actingSubject,
        unique.map(work => `work:read:${work}`), 'work.read');
      return new Set(unique.filter(work => scopes.has(`work:read:${work}`)));
    });
  }

  /** Current person-Agent baseline for private reader state on public chapters.
   * A client the caller already holds is queried and left open. */
  async canReadAsBaselineMember(principal: VerifiedPrincipal, actingSubject: string,
    client?: PoolClient): Promise<boolean> {
    if (!principal.emailVerified || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) {
      return false;
    }
    return readAdmission(this.pool, client, held => baselineMemberDecision(held, principal, actingSubject));
  }

  /** Current disclosure decision for a semantic Resource or relation occurrence. */
  async canReadSemanticResource(principal: VerifiedPrincipal | null, actingSubject: string | null,
    resource: string, revision?: string, graph = this.baselineGraph, client?: PoolClient): Promise<boolean> {
    return (await this.canReadSemanticResources(principal, actingSubject, [resource], revision, graph, client)).has(resource);
  }

  canReadSemanticResources(principal: VerifiedPrincipal | null, actingSubject: string | null,
    resources: readonly string[], revision?: string, graph = this.baselineGraph,
    client?: PoolClient): Promise<ReadonlySet<string>> {
    const unique = checkedReadTargets(resources);
    if (!unique.length) return Promise.resolve(new Set());
    const disclosureGraph = requireDisclosureGraph(graph);
    return readAdmission(this.pool, client, async held => {
      await requireRecoveryOpen(held);
      const allowed = new Set<string>();
      for (let at = 0; (revision === undefined || nativeReadTarget.test(revision)) && at < unique.length;
        at += SEMANTIC_DISCLOSURE_LIMIT) {
        for (const resource of await publicInTransaction(held, disclosureGraph,
          unique.slice(at, at + SEMANTIC_DISCLOSURE_LIMIT), revision)) allowed.add(resource);
      }
      if (!principal || !actingSubject || !nativeReadTarget.test(actingSubject)) return allowed;
      const scopes = await scopedResourceDecisions(held, this.baselineGraph, principal, actingSubject,
        unique.filter(resource => !allowed.has(resource)).map(resource => `semantic:read:${resource}`), 'semantic.read');
      for (const resource of unique) if (scopes.has(`semantic:read:${resource}`)) allowed.add(resource);
      return allowed;
    });
  }

  canReadZoneNavigationTargets(principal: VerifiedPrincipal, workPrincipal: VerifiedPrincipal | null,
    actingSubject: string, resources: readonly string[]): Promise<ReadonlySet<string>> {
    const unique = checkedReadTargets(resources);
    if (!unique.length) return Promise.resolve(new Set());
    const graph = requireDisclosureGraph(this.baselineGraph);
    return readAdmission(this.pool, undefined, async held => {
      await requireRecoveryOpen(held);
      const rows = (await graph.query(`PREFIX schema: <https://schema.org/>
        PREFIX rv: <https://rezics.com/vocab/>
        SELECT ?resource ?publicCollection WHERE { VALUES ?resource { ${unique.map(iri).join(' ')} }
          { GRAPH ${iri(GRAPHS.current)} { ?resource a schema:CreativeWork } }
          UNION {
            GRAPH ${iri(GRAPHS.current)} { ?resource a rv:Collection ;
              rv:collectionState rv:Active ; rv:disclosure rv:Public ; rv:structure ?structure .
              ?structure a rv:Structure ; rv:structureOf ?resource ;
                rv:structureProfile rv:CollectionMembership ; rv:structureHead ?head . }
            FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?resource rv:protectionHead ?protection } }
            FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ErasedRevision } }
            BIND(true AS ?publicCollection)
          } }
        LIMIT ${unique.length + 1}`, 32_768)).results?.bindings ?? [];
      const typed = new Set(rows.map(row => row.resource?.value));
      if (rows.length !== typed.size || rows.length > unique.length
        || [...typed].some(resource => !resource || !unique.includes(resource))
        || rows.some(row => row.publicCollection && row.publicCollection.value !== 'true')) {
        throw new AdmissionUnavailable('Zone navigation target types are ambiguous');
      }
      const works = new Set(rows.filter(row => !row.publicCollection).map(row => row.resource!.value));
      // Collection delivery uses its own current disclosure, not a SemanticRevision
      // or the Zone editor's mandate. Keep the independent semantic gate and policy.
      const publicCollections = new Set((await held.query<{ resource: string }>(`SELECT wanted.resource
        FROM unnest($1::text[]) AS wanted(resource)
        WHERE NOT EXISTS (SELECT 1 FROM access.scope_gate
          WHERE id = 'semantic:read:' || wanted.resource AND NOT open)
          AND NOT EXISTS (SELECT 1 FROM access.policy
            WHERE scope_id = 'semantic:read:' || wanted.resource AND ended_at IS NULL)`,
      [rows.filter(row => row.publicCollection).map(row => row.resource!.value)])).rows.map(row => row.resource));
      const semantics = await this.canReadSemanticResources(principal, actingSubject,
        unique.filter(resource => !works.has(resource) && !publicCollections.has(resource)), undefined, graph, held);
      const readableWorks = workPrincipal ? await this.canReadWorks(workPrincipal, actingSubject,
        unique.filter(resource => works.has(resource)), held) : new Set<string>();
      return new Set([...publicCollections, ...semantics, ...readableWorks]);
    });
  }

  /** The page equivalent of semantic disclosure followed by Work disclosure. */
  canReadReferences(principal: VerifiedPrincipal | null, actingSubject: string | null,
    resources: readonly string[]): Promise<ReadonlySet<string>> {
    return readReferenceDisclosure({ pool: this.pool, graph: this.baselineGraph },
      principal, actingSubject, resources);
  }

  /** Official links also need a source-revision admission; this is target edit authority. */
  async canLinkTranslation(principal: VerifiedPrincipal, actingSubject: string,
    work: string): Promise<boolean> {
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) return false;
    return this.canReadScopedResource(principal, actingSubject,
      `translation:link:${work}`, 'translation.link');
  }

  /** Release coverage requires the same grant or author baseline as a Work edit. */
  async canEditWork(principal: VerifiedPrincipal, actingSubject: string,
    work: string): Promise<boolean> {
    try {
      return await this.withWorkEditAuthority(principal, actingSubject, work, async () => true);
    } catch (error) {
      if (error instanceof AdmissionDenied) return false;
      throw error;
    }
  }

  /** Platform media field controls use the existing administrator proof and fences. */
  async canProtectMedia(principal: VerifiedPrincipal, actingSubject: string, media: string,
    action:'media.labels.protect'|'media.conceal.protect'='media.labels.protect'): Promise<boolean> {
    if (!await this.canActAsPlatformAdministrator(principal,actingSubject)) return false;
    return this.canReadScopedResource(principal, actingSubject, `media:protect:${media}`, action);
  }

  async canActAsPlatformAdministrator(principal:VerifiedPrincipal,actingSubject:string):Promise<boolean> {
    return withAccessClient(this.pool, async client => {
      const principalId=await this.activePrincipalId(principal);
      return !!principalId && !!await platformAdministratorProof(client,principalId,actingSubject);
    });
  }

  async canManageMedia(principal: VerifiedPrincipal, actingSubject: string): Promise<boolean> {
    return this.canReadScopedResource(principal, actingSubject, `media:owner:${actingSubject}`, 'media.upload');
  }

  /** Drafts require their own current grant, independent of Work or publication reads. */
  async canReadContributionDraft(
    principal: VerifiedPrincipal, actingSubject: string, contribution: string,
  ): Promise<boolean> {
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(contribution)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) return false;
    return this.canReadScopedResource(principal, actingSubject,
      `contribution:read:${contribution}`, 'contribution.read');
  }

  /** Register one private Contribution search before crossing into Content/Jena.
   * Shared authority fences exclude strong closure; the target inventory lock
   * and principal lock bound concurrent private deliveries. */
  async admitContributionSearchRead(principal: VerifiedPrincipal,
    actingSubject: string, contribution: string): Promise<ContributionSearchReadLease> {
    if (!nativeContribution.test(contribution) || !nativeContribution.test(actingSubject)
      || !principal.issuer || !principal.subject) {
      throw new AdmissionDenied('invalid private search subject');
    }
    const scope = `contribution:read:${contribution}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recoveryGeneration = await requireRecoveryOpen(client);
      const gate = (await client.query<GateRow>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE',
        [scope])).rows[0];
      if (!gate || !gate.open || !gate.dispatch_open) throw new AdmissionDenied('private search scope is closed');
      await lockAccessKey(client, `search-read-inventory:${scope}`);
      const identity = (await client.query<{ id: string; enforcement_epoch: string }>(
        `SELECT id, enforcement_epoch FROM access.principal
         WHERE account_issuer = $1 AND account_subject = $2 AND active FOR UPDATE`,
        [principal.issuer, principal.subject])).rows[0];
      if (!identity) throw new AdmissionDenied('private search principal is unavailable');
      const subject = (await client.query<{ generation: string }>(
        'SELECT generation FROM access.authority_subject WHERE id = $1 AND active FOR SHARE',
        [actingSubject])).rows[0];
      const representation = (await client.query<{
        id: string; generation: string; valid_until: Date;
      }>(`SELECT id, generation, valid_until FROM access.representation
          WHERE principal_id = $1 AND subject_id = $2 AND action = 'contribution.read'
            AND active AND valid_until > clock_timestamp() + interval '1 second'
          ORDER BY id LIMIT 1 FOR SHARE`, [identity.id, actingSubject])).rows[0];
      const grant = (await client.query<{
        id: string; generation: string; valid_until: Date;
      }>(`SELECT id, generation, valid_until FROM access.permission_grant
          WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'contribution.read'
            AND active AND valid_until > clock_timestamp() + interval '1 second'
          ORDER BY id LIMIT 1 FOR SHARE`, [actingSubject, scope])).rows[0];
      if (!subject || !representation || !grant) throw new AdmissionDenied('private search is not admitted');
      if (await pendingSearchReads(client, 'principal_id', identity.id) >= MAX_PRINCIPAL_SEARCH_READS
        || await pendingSearchReads(client, 'scope_id', scope) >= MAX_SCOPE_SEARCH_READS) {
        throw new AdmissionUnavailable('private search admission capacity is exhausted');
      }
      const inserted = await client.query<SearchReadRow>(
        `WITH deadline AS (
           SELECT LEAST(clock_timestamp() + ($14 * interval '1 millisecond'), $15, $16)
             AS expires_at
         )
         INSERT INTO access.search_read_lease
          (id, principal_id, acting_subject, contribution, scope_id, representation_id,
           grant_id, authority_epoch, principal_epoch, recovery_generation,
           subject_generation, representation_generation, grant_generation, expires_at, state)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           deadline.expires_at, 'admitted'
         FROM deadline WHERE deadline.expires_at > clock_timestamp() + interval '1 second'
         RETURNING *`,
        [Bun.randomUUIDv7(), identity.id, actingSubject, contribution, scope,
          representation.id, grant.id, gate.authority_epoch, identity.enforcement_epoch,
          recoveryGeneration, subject.generation, representation.generation, grant.generation,
          CONTRIBUTION_SEARCH_READ_LEASE_MS, representation.valid_until, grant.valid_until]);
      if (!inserted.rows[0]) throw new AdmissionExpired('private search authority expires too soon');
      await client.query('COMMIT');
      return contributionSearchLease(inserted.rows[0]!);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
  }

  /** Final authority check. A transport must arm before its first sensitive
   * send, then finish with a matched receipt. A checked lease is not reusable. */
  async beginContributionSearchDelivery(leaseId: string, principal: VerifiedPrincipal,
    actingSubject: string, contribution: string): Promise<ContributionSearchReadLease> {
    if (!/^[0-9a-f-]{36}$/.test(leaseId) || !nativeContribution.test(actingSubject)
      || !nativeContribution.test(contribution) || !principal.issuer || !principal.subject) {
      throw new AdmissionDenied('invalid private search delivery');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recoveryGeneration = await requireRecoveryOpen(client);
      const locator = (await client.query<Pick<SearchReadRow, 'scope_id' | 'principal_id'>>(
        'SELECT scope_id, principal_id FROM access.search_read_lease WHERE id = $1', [leaseId])).rows[0];
      if (!locator) throw new AdmissionDenied('private search lease is unavailable');
      const gate = (await client.query<GateRow>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE',
        [locator.scope_id])).rows[0];
      const identity = (await client.query<{
        id: string; enforcement_epoch: string; active: boolean;
      }>(`SELECT id, enforcement_epoch, active FROM access.principal
          WHERE id = $1 AND account_issuer = $2 AND account_subject = $3 FOR SHARE`,
        [locator.principal_id, principal.issuer, principal.subject])).rows[0];
      const lease = (await client.query<SearchReadRow>(
        'SELECT * FROM access.search_read_lease WHERE id = $1 FOR UPDATE', [leaseId])).rows[0];
      if (!gate || !gate.open || !gate.dispatch_open || !identity?.active || !lease
        || lease.state !== 'admitted' || lease.scope_id !== locator.scope_id
        || lease.principal_id !== identity.id || lease.contribution !== contribution
        || lease.acting_subject !== actingSubject
        || lease.authority_epoch !== gate.authority_epoch
        || lease.principal_epoch !== identity.enforcement_epoch
        || lease.recovery_generation !== recoveryGeneration) {
        throw new AdmissionDenied('private search delivery is fenced');
      }
      if (lease.expires_at.getTime() <= Date.now()) throw new AdmissionExpired('private search lease expired');
      const dependencies = await client.query<{ id: string }>(
        `SELECT s.id FROM access.authority_subject s
          JOIN access.representation r ON r.id = $2
          JOIN access.permission_grant g ON g.id = $3
          WHERE s.id = $1 AND s.active AND s.generation = $4
            AND r.principal_id = $5 AND r.subject_id = s.id
            AND r.action = 'contribution.read' AND r.active AND r.generation = $6
            AND r.valid_until > clock_timestamp()
            AND g.recipient_subject = s.id AND g.scope_id = $7
            AND g.action = 'contribution.read' AND g.active AND g.generation = $8
            AND g.valid_until > clock_timestamp()
          FOR SHARE OF s, r, g`, [actingSubject, lease.representation_id, lease.grant_id,
          lease.subject_generation, identity.id, lease.representation_generation,
          lease.scope_id, lease.grant_generation]);
      if (dependencies.rowCount !== 1) throw new AdmissionDenied('private search proof changed');
      const started = await client.query<SearchReadRow>(
        `UPDATE access.search_read_lease SET state = 'delivering',
           delivery_started_at = clock_timestamp()
         WHERE id = $1 AND state = 'admitted' AND expires_at > clock_timestamp()
         RETURNING *`, [leaseId]);
      if (!started.rows[0]) throw new AdmissionExpired('private search lease expired');
      await client.query('COMMIT');
      return contributionSearchLease(started.rows[0]);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
  }

  /** Commit the no-return point before invoking a transport send. A crash after
   * this commit is conservatively unresolved, even if no byte actually left. */
  async armContributionSearchSend(leaseId: string, receiptToken: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(leaseId) || !/^[0-9a-f]{64}$/.test(receiptToken)) {
      throw new AdmissionDenied('invalid private search receipt challenge');
    }
    const digest = createHash('sha256').update(receiptToken).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recoveryGeneration = await requireRecoveryOpen(client);
      const locator = (await client.query<Pick<SearchReadRow, 'scope_id' | 'principal_id'>>(
        'SELECT scope_id, principal_id FROM access.search_read_lease WHERE id = $1', [leaseId])).rows[0];
      if (!locator) throw new AdmissionDenied('private search lease is unavailable');
      const gate = (await client.query<GateRow>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE',
        [locator.scope_id])).rows[0];
      const identity = (await client.query<{
        id: string; enforcement_epoch: string; active: boolean;
      }>('SELECT id, enforcement_epoch, active FROM access.principal WHERE id = $1 FOR SHARE',
        [locator.principal_id])).rows[0];
      const lease = (await client.query<SearchReadRow>(
        'SELECT * FROM access.search_read_lease WHERE id = $1 FOR UPDATE', [leaseId])).rows[0];
      if (!gate?.open || !gate.dispatch_open || !identity?.active || !lease
        || lease.state !== 'delivering' || lease.send_started_at !== null
        || lease.scope_id !== locator.scope_id || lease.principal_id !== identity.id
        || lease.authority_epoch !== gate.authority_epoch
        || lease.principal_epoch !== identity.enforcement_epoch
        || lease.recovery_generation !== recoveryGeneration) {
        throw new AdmissionDenied('private search send is fenced');
      }
      if (lease.expires_at.getTime() <= Date.now()) {
        throw new AdmissionExpired('private search lease expired before send');
      }
      const dependencies = await client.query<{ id: string }>(
        `SELECT s.id FROM access.authority_subject s
          JOIN access.representation r ON r.id = $2
          JOIN access.permission_grant g ON g.id = $3
          WHERE s.id = $1 AND s.active AND s.generation = $4
            AND r.principal_id = $5 AND r.subject_id = s.id
            AND r.action = 'contribution.read' AND r.active AND r.generation = $6
            AND r.valid_until > clock_timestamp()
            AND g.recipient_subject = s.id AND g.scope_id = $7
            AND g.action = 'contribution.read' AND g.active AND g.generation = $8
            AND g.valid_until > clock_timestamp()
          FOR SHARE OF s, r, g`, [lease.acting_subject, lease.representation_id,
          lease.grant_id, lease.subject_generation, identity.id,
          lease.representation_generation, lease.scope_id, lease.grant_generation]);
      if (dependencies.rowCount !== 1) throw new AdmissionDenied('private search send proof changed');
      const result = await client.query(
        `UPDATE access.search_read_lease
         SET send_started_at = clock_timestamp(), receipt_digest = $2
         WHERE id = $1 AND state = 'delivering' AND send_started_at IS NULL
           AND recovery_generation = $3 AND expires_at > clock_timestamp()`,
        [leaseId, digest, recoveryGeneration]);
      if (result.rowCount !== 1) throw new AdmissionConflict('private search send cannot be armed');
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
  }

  /** A matched peer receipt proves the full single-frame result was received.
   * Abort is permitted only when no sensitive send could have been attempted. */
  async finishContributionSearchRead(leaseId: string, outcome: 'delivered' | 'aborted',
    receiptToken?: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(leaseId) || !['delivered', 'aborted'].includes(outcome)
      || (outcome === 'delivered' && !/^[0-9a-f]{64}$/.test(receiptToken ?? ''))
      || (outcome === 'aborted' && receiptToken !== undefined)) {
      throw new AdmissionDenied('invalid private search finish');
    }
    const digest = receiptToken && createHash('sha256').update(receiptToken).digest('hex');
    const result = await this.pool.query<{ state: string }>(
      `UPDATE access.search_read_lease SET state = $2, finished_at = clock_timestamp()
       WHERE id = $1 AND state IN ('admitted', 'delivering')
         AND (($2 = 'aborted' AND send_started_at IS NULL)
           OR ($2 = 'delivered' AND state = 'delivering'
             AND send_started_at IS NOT NULL AND receipt_digest = $3))
       RETURNING state`, [leaseId, outcome, digest ?? null]);
    if (result.rowCount === 1) return;
    const prior = await this.pool.query<{ state: string; receipt_digest: string | null }>(
      'SELECT state, receipt_digest FROM access.search_read_lease WHERE id = $1', [leaseId]);
    if (prior.rows[0]?.state !== outcome
      || (outcome === 'delivered' && prior.rows[0].receipt_digest !== digest)) {
      throw new AdmissionConflict('private search finish conflicts with lease');
    }
  }

  /** Recovery/operations view. A post-send disconnect or crash stays here until
   * the exact receipt is reconciled; expiry never converts it into an abort. */
  async unresolvedContributionSearchDeliveries(limit = 100): Promise<UnresolvedContributionSearchDelivery[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new AdmissionDenied('invalid unresolved delivery limit');
    }
    const result = await this.pool.query<{
      id: string; principal_id: string; scope_id: string; contribution: string;
      delivery_started_at: Date; send_started_at: Date | null; expires_at: Date;
    }>(`SELECT id, principal_id, scope_id, contribution, delivery_started_at,
          send_started_at, expires_at
        FROM access.search_read_lease WHERE state = 'delivering' AND target_kind = 'contribution'
        ORDER BY delivery_started_at, id LIMIT $1`, [limit]);
    return result.rows.map(row => ({ id: row.id, principalId: row.principal_id,
      scope: row.scope_id, contribution: row.contribution,
      deliveryStartedAt: row.delivery_started_at.toISOString(),
      sendStartedAt: row.send_started_at?.toISOString() ?? null,
      expiresAt: row.expires_at.toISOString() }));
  }

  async canReadStandingRating(
    principal: VerifiedPrincipal, actingSubject: string, context: string,
  ): Promise<boolean> {
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(context)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) return false;
    return this.canReadScopedResource(principal, actingSubject,
      `rating:read:${context}`, 'rating.observation.read');
  }

  /** The separate platform grant gates official Zone identity and route changes. */
  async canMarkOfficialZone(principal: VerifiedPrincipal, actingSubject: string, zone: string)
    : Promise<boolean> {
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(zone)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) return false;
    return this.canReadScopedResource(principal, actingSubject,
      `zone:official:${zone}`, 'zone.official');
  }

  /** Returns only a currently active Access counting identity for an introspected Account subject. */
  async activePrincipalId(principal: VerifiedPrincipal): Promise<string | null> {
    // Autocommit holds the recovery row lock through the whole statement. No
    // authority result survives this call; workRead repeats it before delivery.
    const row = (await (accessClient(this.pool) ?? this.pool).query<{ open: boolean; id: string | null }>(`WITH fence AS MATERIALIZED (
      SELECT open FROM access.recovery_fence WHERE id FOR SHARE
    ) SELECT fence.open, p.id FROM fence LEFT JOIN access.principal p
      ON p.account_issuer = $1 AND p.account_subject = $2 AND p.active`,
    [principal.issuer, principal.subject])).rows[0];
    if (!row?.open) throw new AdmissionUnavailable('Access recovery is held');
    return row.id;
  }

  /** Private owner verification: the verified Account subject must own the
   * admission. A sealed receipt conveys acknowledgment, never current authority. */
  async readAcknowledgedOwnerCommand(principal: VerifiedPrincipal, receipt: string):
    Promise<AcknowledgedOwnerCommand | null> {
    if (!/^urn:rezics:receipt:[a-f0-9]{64}$/.test(receipt)) return null;
    const principalId = await this.activePrincipalId(principal);
    if (!principalId) return null;
    const row = (await (accessClient(this.pool) ?? this.pool).query<{
      id: string; graph_receipt: string; action: string; acting_subject: string; scope_id: string;
      request_digest: string; authority_epoch: string; graph_data_epoch: string; graph_sequence: string;
    }>(`SELECT id,graph_receipt,action,acting_subject,scope_id,request_digest,
      authority_epoch::text,graph_data_epoch,graph_sequence::text
      FROM access.admission WHERE principal_id=$1 AND graph_receipt=$2
        AND state='sealed' AND graph_outcome='succeeded' LIMIT 2`, [principalId, receipt])).rows;
    if (row.length !== 1) return null;
    if (await this.activePrincipalId(principal) !== principalId) return null;
    const proof = row[0]!;
    return { admissionId: proof.id, receipt: proof.graph_receipt, action: proof.action,
      actingSubject: proof.acting_subject, scope: proof.scope_id, requestDigest: proof.request_digest,
      authorityEpoch: proof.authority_epoch, dataEpoch: proof.graph_data_epoch, sequence: proof.graph_sequence };
  }

  private async canReadScopedResource(
    principal: VerifiedPrincipal, actingSubject: string, scope: string, action: string,
    client?: PoolClient,
  ): Promise<boolean> {
    return readAdmission(this.pool, client, async held =>
      (await scopedResourceDecisions(held, this.baselineGraph, principal, actingSubject, [scope], action)).has(scope));
  }

  /** Import authority uses creation's grant/group/role path, never member baseline.
   * Cost: indexed identity/mandate/grant reads and at most 16 role bindings;
   * discovery supplies its separately bounded candidate set. No admission or
   * graph receipt is manufactured for a Source-owned SQL operation. */
  async hasNonBaselineWorkCreateAuthority(principal: VerifiedPrincipal, actingSubject: string,
    authorityPath: 'represented-agent' | 'direct-principal' = 'represented-agent'): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query(READ_BEGIN);
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      const gate = (await client.query<GateRow>(`SELECT open, dispatch_open, authority_epoch
        FROM access.scope_gate WHERE id = 'work:create:root' FOR SHARE`)).rows[0];
      const identity = (await client.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
      [principal.issuer, principal.subject])).rows[0];
      let allowed = false;
      if (gate?.open && gate.dispatch_open && identity) {
        if (authorityPath === 'represented-agent'
          && !(await client.query("SELECT id FROM access.policy WHERE scope_id = 'work:create:root'")).rowCount
          && await platformAdministratorProof(client, identity.id, actingSubject, true,
            { action: 'work.create', scope: 'work:create:root' })) {
          allowed = true;
        } else
        if (authorityPath === 'direct-principal') {
          allowed = !!await directWorkCreateProof(client, identity.id, actingSubject);
        } else {
          const proof = await representedWorkProof(client, identity.id, actingSubject);
          allowed = !!proof && !proof.path && (!!proof.grantId
            || !!await groupWorkCreateProof(client, actingSubject)
            || !!await roleWorkCreateProof(client, actingSubject));
        }
      }
      await client.query('COMMIT');
      return allowed;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
  }

  withPreservationFence<T>(
    resource: string,
    operationId: string,
    write: (fence: PreservationFence) => Promise<T>,
  ) {
    return withPreservationFence(this.pool, resource, operationId, write);
  }

  async register(request: AdmissionRequest, transaction?: PoolClient): Promise<RegisteredAdmission> {
    return this.registerRequest(request,transaction);
  }

  /** Probe the ordinary registration policy without retaining an admission,
   * outbox event or lazily created gate. The same policy runs again at dispatch.
   * Cost matches one registration's bounded authority reads, with no owner IO. */
  async assertAuthority(request: Omit<AdmissionRequest, 'editorialPermit' | 'idempotencyKey' | 'requestDigest'>,
    publicationWork?: string | null): Promise<void> {
    const borrowed = accessClient(this.pool);
    return withAccessClient(this.pool, async client => {
      await client.query(borrowed ? 'SAVEPOINT authority_probe' : 'BEGIN');
      try {
        const probe = { ...request,idempotencyKey: `authority:${Bun.randomUUIDv7()}`,requestDigest: '0'.repeat(64) };
        await withCommandOwnerAuthority(client,probe,this.baselineGraph,
          () => this.registerRequest(probe,client,true),publicationWork);
      } catch (error) {
        if (!(error instanceof AuthorityChecked)) throw error;
      } finally {
        if (borrowed) {
          await client.query('ROLLBACK TO SAVEPOINT authority_probe');
          await client.query('RELEASE SAVEPOINT authority_probe');
        } else await rollback(client);
      }
    }, borrowed);
  }

  /** Commit an Access-owned SQL effect under the ordinary, live admission
   * policy. No graph admission is created. All selected authority locks stay
   * held until the callback and its owner receipt commit in this transaction. */
  async withOwnerAuthority<T>(request: Omit<AdmissionRequest, 'editorialPermit' | 'idempotencyKey' | 'requestDigest'>,
    operation: (client: PoolClient) => Promise<T>): Promise<T> {
    if (request.action === 'agent.control') {
      if (request.scope !== `agent:control:${request.actingSubject}`) throw new AdmissionDenied('Agent control scope differs');
      try { return await controlTransaction(this.pool,async client => {
        const principal = await requirePrincipal(client,request.principal);
        await requireMandate(client,principal.id,request.actingSubject,'agent.control');
        return operation(client);
      }); } catch (error) { if (error instanceof ControlDenied) throw new AdmissionDenied(error.message);
        if (error instanceof ControlUnavailable) throw new AdmissionUnavailable(error.message);throw error; }
    }
    if (request.action === 'realm.settings.manage' && request.scope.startsWith('governance:realm:')) {
      const realm = request.scope.slice('governance:realm:'.length);
      let ownerError: unknown;
      try { return await realmTransaction(this.pool,realm,true,async client => {
        try { await realmManager(client,request.principal,realm,request.actingSubject,'realm.settings.manage'); }
        catch (error) { if (!(error instanceof RealmAdminDenied)) throw error;
          await realmManager(client,request.principal,realm,request.actingSubject,'realm.owner'); }
        try { return await withAccessClient(this.pool, operation, client); } catch (error) { ownerError = error;throw error; }
      }); } catch (error) { if (ownerError !== undefined) throw ownerError;
        if (error instanceof RealmAdminDenied) throw new AdmissionDenied(error.message);
        if (error instanceof RealmAdminUnavailable) throw new AdmissionUnavailable(error.message);throw error; }
    }
    const borrowed = accessClient(this.pool);
    return withAccessClient(this.pool, async client => {
      try {
        if (!borrowed) await client.query('BEGIN');
        const probe = { ...request, idempotencyKey: `authority:${Bun.randomUUIDv7()}`, requestDigest: '0'.repeat(64) };
        const result = await withCommandOwnerAuthority(client, probe, this.baselineGraph, async () => {
          try { await this.registerRequest(probe, client, true); }
          catch (error) { if (!(error instanceof AuthorityChecked)) throw error; }
          return operation(client);
        });
        if (!borrowed) await client.query('COMMIT');
        return result;
      } catch (error) { if (!borrowed) await rollback(client); throw error; }
    }, borrowed);
  }

  private async registerRequest(request: AdmissionRequest, transaction?: PoolClient, authorityOnly = false,
    lockedIdentity?: LockedAdmissionIdentity): Promise<RegisteredAdmission> {
    const memberReply = memberReplyAuthoringIntent(request);
    if (memberReply && (!memberReply.valid || request.editorialPermit)) {
      throw new AdmissionDenied('member reply intent is malformed');
    }
    if (request.editorialPermit) {
      const principalId = await this.activePrincipalId(request.principal);
      if (!principalId) throw new AdmissionDenied('principal is not admitted');
      await requirePlatformParticipation(this.pool, principalId);
      return registerEditorialAdmission(this.pool, request, this.baselineGraph, (client,ordinary) => this.register(ordinary,client));
    }
    if (request.action === 'publication.reject.organization') {
      throw new AdmissionDenied('organization moderation requires its atomic episode admission');
    }
    const authorityPath = request.authorityPath ?? 'represented-agent';
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(request.idempotencyKey)
      || !/^[a-z][a-z0-9.:-]{1,127}$/.test(request.action)
      || !/^[0-9a-f]{64}$/.test(request.requestDigest)
      || !['represented-agent', 'direct-principal'].includes(authorityPath)
      || (authorityPath === 'direct-principal'
        && (request.action !== 'work.create' || request.scope !== 'work:create:root'))) {
      throw new AdmissionDenied('invalid admission request');
    }
    const client = transaction ?? await admissionClient(this.pool);
    try {
      if (!transaction) await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      if (!lockedIdentity) {
        await requireRecoveryOpen(client);
        await ensureBaselineScopeGate(client, request.scope);
        if (platformAdministratorAction(request.action, request.scope)) {
          await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [request.scope]);
        }
      }
      const gate = lockedIdentity?.gate ?? (await client.query<GateRow & { group_generation: string }>(
        `SELECT authority_epoch, group_generation, open, dispatch_open
         FROM access.scope_gate WHERE id = $1 FOR ${admissionGateLock}`, [request.scope])).rows[0];
      if (!gate) throw new AdmissionUnavailable('scope gate is unavailable');

      const principal = lockedIdentity?.principal ?? (await client.query<{
        id: string; active: boolean; enforcement_epoch: string;
      }>(
        `SELECT id, active, enforcement_epoch FROM access.principal
         WHERE account_issuer = $1 AND account_subject = $2 FOR SHARE`,
        [request.principal.issuer, request.principal.subject])).rows[0];
      if (principal?.active !== true) throw new AdmissionDenied('principal is not admitted');
      const principalId = principal.id;
      await requirePlatformParticipation(client, principalId);
      if (!lockedIdentity) {
        // A shared gate no longer serializes retries of one key; this lock does.
        await lockAdmissionKey(client, principalId, request.action, request.idempotencyKey);
      }

      const existingResult = authorityOnly ? { rows: [] } : await client.query<AdmissionRow>(
        `SELECT authority_witness, id, principal_id, acting_subject, authority_path, scope_id, action, idempotency_key, request_digest,
                authority_epoch, registered_at, expires_at, state, group_member_id, group_grant_id, group_generation,
                direct_grant_id, direct_grant_generation, attribution_id, attribution_generation,
                direct_subject_generation, direct_principal_epoch,
                private_group_member_id, private_group_member_generation,
                private_group_grant_id, private_group_grant_generation, private_group_generation,
                private_role_binding_id, private_role_binding_generation,
                private_role_family_id, private_role_revision,
                represented_representation_id, represented_representation_generation,
                represented_grant_id, represented_grant_generation,
                represented_subject_generation, represented_principal_epoch,
                role_binding_id, role_binding_generation, role_family_id, role_revision,
                (expires_at > clock_timestamp()) AS eligible
         FROM access.admission
         WHERE principal_id = $1 AND action = $2 AND idempotency_key = $3`,
        [principalId, request.action, request.idempotencyKey]);
      const existing = existingResult.rows[0];
      if (existing) {
        // Receipt disclosure uses today's ordinary authority, independently of
        // the saved witness that still decides whether this admission dispatches.
        // The probe retains the same transaction's authority locks and writes
        // no admission, proof, receipt or effect.
        // The identical request borrows this transaction's recovery, scope,
        // principal and key locks. All ordinary authority and policy reads stay live.
        try { await this.registerRequest(request, client, true, { gate, principal }); }
        catch (error) { if (!(error instanceof AuthorityChecked)) throw error; }
      }
      if (existing && (existing.request_digest !== request.requestDigest
        || existing.acting_subject !== request.actingSubject
        || existing.authority_path !== authorityPath || existing.scope_id !== request.scope)) {
        throw new AdmissionConflict('idempotency key belongs to a different intent');
      }
      // Fence Realm policy before selecting membership rows, as Realm managers do.
      const participationSources = await requireRealmParticipation(client, request.scope, request.action, principalId, request.actingSubject);
      const selectedCurrent = !existing?.authority_witness
        || await authorityWitnessCurrent(client, existing.authority_witness);
      const policyAllowed = !existing || await admissionPolicyAllowed(client, principalId, request.actingSubject,
        request.scope, request.action, { witness: existing.authority_witness ?? [], eligible: selectedCurrent });
      const witnessCurrent = selectedCurrent && policyAllowed;

      const ratingConfiguration = ratingConfigurationAction(request.action);
      const savedRating = existing && ratingConfiguration ? await savedRealmRatingProof(client, existing.id) : null;
      if (existing && savedRating) {
        if (existing.request_digest !== request.requestDigest || existing.acting_subject !== request.actingSubject
          || existing.authority_path !== authorityPath || existing.scope_id !== request.scope) {
          throw new AdmissionConflict('idempotency key belongs to a different intent');
        }
        const dispatchEligible = witnessCurrent && ['registered', 'claimed'].includes(existing.state) && existing.eligible
          && gate.open && gate.dispatch_open && existing.authority_epoch === gate.authority_epoch
          && !!await realmRatingProof(client, this.baselineGraph, principalId, request.actingSubject,
            request.action, request.scope, savedRating);
        if (!transaction) await client.query('COMMIT');
        return { id: existing.id, principalId, actingSubject: existing.acting_subject,
          authorityPath: existing.authority_path, scope: existing.scope_id, action: existing.action,
          idempotencyKey: existing.idempotency_key, requestDigest: existing.request_digest,
          authorityEpoch: existing.authority_epoch, registeredAt: existing.registered_at.toISOString(),
          expiresAt: existing.expires_at.toISOString(), state: existing.state as RegisteredAdmission['state'],
          dispatchEligible, replayed: true };
      }

      const zonePage = resolveZonePageContent(request);
      const savedBaseline = existing ? await savedBaselineProof(client, existing.id) : null;
      // Old reply drafts may have only an administrator or generic grant proof.
      // Keep their receipt replayable, but never let a nonbaseline proof dispatch.
      if (existing && memberReply && !savedBaseline) {
        if (!transaction) await client.query('COMMIT');
        return { id: existing.id, principalId: existing.principal_id,
          actingSubject: existing.acting_subject, authorityPath: existing.authority_path,
          scope: existing.scope_id, action: existing.action, idempotencyKey: existing.idempotency_key,
          requestDigest: existing.request_digest, authorityEpoch: existing.authority_epoch,
          registeredAt: existing.registered_at.toISOString(), expiresAt: existing.expires_at.toISOString(),
          state: existing.state as RegisteredAdmission['state'], dispatchEligible: false, replayed: true };
      }
      const savedAdministrator = existing && !memberReply
        ? await savedPlatformAdministratorProof(client, existing.id) : null;
      if (existing && savedAdministrator) {
        if (existing.request_digest !== request.requestDigest
          || existing.acting_subject !== request.actingSubject
          || existing.authority_path !== authorityPath || existing.scope_id !== request.scope
          || zonePage.kind === 'refused'
          || (savedAdministrator.resolved_zone_page ?? null) !== (zonePage.kind === 'zone' ? zonePage.zone : null)) {
          throw new AdmissionConflict('idempotency key belongs to a different intent');
        }
        const dispatchEligible = witnessCurrent && ['registered', 'claimed'].includes(existing.state) && existing.eligible
          && gate.open && gate.dispatch_open && existing.authority_epoch === gate.authority_epoch
          && await platformAdministratorProofCurrent(client, savedAdministrator, principalId, request.actingSubject)
          && (savedAdministrator.resolved_zone_page
            ? await zonePageAdministratorAllowed(client, this.baselineGraph, principalId,
              request.actingSubject, savedAdministrator, request.action)
            : await platformAdministratorTargetAllowed(client, this.baselineGraph, principalId,
              request.actingSubject, request.action, request.scope))
          && !(await client.query('SELECT id FROM access.policy WHERE scope_id = $1', [request.scope])).rowCount;
        if (!transaction) await client.query('COMMIT');
        return { id: existing.id, principalId, actingSubject: existing.acting_subject,
          authorityPath: existing.authority_path, scope: existing.scope_id, action: existing.action,
          idempotencyKey: existing.idempotency_key, requestDigest: existing.request_digest,
          authorityEpoch: existing.authority_epoch, registeredAt: existing.registered_at.toISOString(),
          expiresAt: existing.expires_at.toISOString(), state: existing.state as RegisteredAdmission['state'],
          dispatchEligible, replayed: true };
      }

      if (existing && savedBaseline) {
        if (existing.request_digest !== request.requestDigest
          || existing.acting_subject !== request.actingSubject
          || existing.authority_path !== authorityPath || existing.scope_id !== request.scope
          || savedBaseline.collection_create !== (request.baselineCollectionCreate === true)
          || savedBaseline.related_work !== (request.baselineRelatedWork ?? null)
          || savedBaseline.source_revision !== (request.baselineSourceRevision ?? null)
          || (savedBaseline.submission_contribution ?? null) !== (request.baselineContribution ?? null)
          || zonePage.kind === 'refused'
          || savedZonePageContent(savedBaseline, existing.action) !== (zonePage.kind === 'zone' ? zonePage.zone : null)) {
          throw new AdmissionConflict('idempotency key belongs to a different intent');
        }
        const dispatchEligible = witnessCurrent
          && request.principal.emailVerified === true
          && baselineWorkTypesAllowed(request)
          && ['registered', 'claimed'].includes(existing.state) && existing.eligible
          && gate.open && gate.dispatch_open && existing.authority_epoch === gate.authority_epoch
          && await baselineProofCurrent(client, this.baselineGraph, savedBaseline, existing,
            this.replyRootDecision(client, request.principal, request.actingSubject));
        if (!transaction) await client.query('COMMIT');
        return { id: existing.id, principalId: existing.principal_id,
          actingSubject: existing.acting_subject, authorityPath: existing.authority_path,
          scope: existing.scope_id, action: existing.action, idempotencyKey: existing.idempotency_key,
          requestDigest: existing.request_digest, authorityEpoch: existing.authority_epoch,
          registeredAt: existing.registered_at.toISOString(), expiresAt: existing.expires_at.toISOString(),
          state: existing.state as RegisteredAdmission['state'], dispatchEligible, replayed: true };
      }

      // Current authority permits disclosure; the original selected proof,
      // rather than a newly selected alternative, still decides dispatch.
      if (existing && authorityPath === 'represented-agent'
        && (request.action === 'work.create' && request.scope === 'work:create:root'
          || ['work.edit', 'relation.change', 'work.derive'].includes(request.action) && existing.represented_representation_id)) {
        if (existing.request_digest !== request.requestDigest
          || existing.acting_subject !== request.actingSubject
          || existing.authority_path !== authorityPath
          || existing.scope_id !== request.scope) {
          throw new AdmissionConflict('idempotency key belongs to a different intent');
        }
        const dispatchEligible = witnessCurrent && ['registered', 'claimed'].includes(existing.state) && existing.eligible
          && gate.open && gate.dispatch_open
          && existing.authority_epoch === gate.authority_epoch
          && await selectedRepresentedWorkProof(client, existing,
            principal.enforcement_epoch, this.baselineGraph);
        if (!transaction) await client.query('COMMIT');
        return {
          id: existing.id, principalId: existing.principal_id,
          actingSubject: existing.acting_subject, scope: existing.scope_id,
          authorityPath: existing.authority_path,
          action: existing.action, idempotencyKey: existing.idempotency_key,
          requestDigest: existing.request_digest,
          authorityEpoch: existing.authority_epoch,
          registeredAt: existing.registered_at.toISOString(), expiresAt: existing.expires_at.toISOString(), state: existing.state as RegisteredAdmission['state'],
          dispatchEligible, replayed: true,
        };
      }
      if (existing && authorityPath === 'direct-principal') {
        if (existing.request_digest !== request.requestDigest
          || existing.acting_subject !== request.actingSubject
          || existing.authority_path !== authorityPath || existing.scope_id !== request.scope) {
          throw new AdmissionConflict('idempotency key belongs to a different intent');
        }
        const dispatchEligible = witnessCurrent && ['registered', 'claimed'].includes(existing.state) && existing.eligible
          && gate.open && gate.dispatch_open && existing.authority_epoch === gate.authority_epoch
          && await selectedDirectWorkProof(client, existing, principal.enforcement_epoch);
        if (!transaction) await client.query('COMMIT');
        return { id: existing.id, principalId: existing.principal_id,
          actingSubject: existing.acting_subject, scope: existing.scope_id,
          authorityPath: existing.authority_path, action: existing.action,
          idempotencyKey: existing.idempotency_key, requestDigest: existing.request_digest,
          authorityEpoch: existing.authority_epoch, registeredAt: existing.registered_at.toISOString(), expiresAt: existing.expires_at.toISOString(),
          state: existing.state as RegisteredAdmission['state'], dispatchEligible, replayed: true };
      }

      if (existing?.authority_witness) {
        // Current authority may disclose the original receipt. A newly selected
        // alternative grant never repairs this admission's dispatch witness.
        if (!transaction) await client.query('COMMIT');
        return { id: existing.id, principalId, actingSubject: existing.acting_subject,
          authorityPath: existing.authority_path, scope: existing.scope_id, action: existing.action,
          idempotencyKey: existing.idempotency_key, requestDigest: existing.request_digest,
          authorityEpoch: existing.authority_epoch, registeredAt: existing.registered_at.toISOString(),
          expiresAt: existing.expires_at.toISOString(), state: existing.state as RegisteredAdmission['state'],
          dispatchEligible: witnessCurrent && gate.open && gate.dispatch_open && existing.eligible
            && existing.state !== 'sealed' && existing.authority_epoch === gate.authority_epoch,
          replayed: true };
      }

      const subject = await client.query<{ active: boolean; kind: string }>(
        'SELECT active, kind FROM access.authority_subject WHERE id = $1 FOR SHARE', [request.actingSubject]);
      if (subject.rows[0]?.active !== true) throw new AdmissionDenied('acting subject is not active');
      let directGrantId: string | null = null;
      let attributionId: string | null = null;
      let directGrantGeneration: string | null = null;
      let attributionGeneration: string | null = null;
      let directSubjectGeneration: string | null = null;
      let directPrincipalEpoch: string | null = null;
      let privateGroupMemberId: string | null = null;
      let privateGroupMemberGeneration: string | null = null;
      let privateGroupGrantId: string | null = null;
      let privateGroupGrantGeneration: string | null = null;
      let privateGroupGeneration: string | null = null;
      let privateRoleBindingId: string | null = null;
      let privateRoleBindingGeneration: string | null = null;
      let privateRoleFamilyId: string | null = null;
      let privateRoleRevision: string | null = null;
      let groupMemberId: string | null = null;
      let groupGrantId: string | null = null;
      let groupGeneration: string | null = null;
      let representedRepresentationId: string | null = null;
      let representedRepresentationGeneration: string | null = null;
      let representedGrantId: string | null = null;
      let representedGrantGeneration: string | null = null;
      let representedSubjectGeneration: string | null = null;
      let representedPrincipalEpoch: string | null = null;
      let roleBindingId: string | null = null;
      let roleBindingGeneration: string | null = null;
      let roleFamilyId: string | null = null;
      let roleRevision: string | null = null;
      const authoritySources: AuthoritySource[] = [
        { table: 'authority_subject', id: request.actingSubject },
      ];
      let publishingProof: RepresentedWorkProof | null = null;
      authoritySources.push(...participationSources);
      // Policy writers need the exclusive scope gate. Its held SHARE lock
      // proves absence through this transaction, including baseline and the
      // final policy decision; three identical probes add no authority.
      const scopePolicyAbsent = !(await client.query('SELECT id FROM access.policy WHERE scope_id = $1', [request.scope])).rowCount;
      const administratorCandidate = !existing && zonePage.kind !== 'refused' && authorityPath === 'represented-agent'
        && !memberReply
        && platformAdministratorAction(request.action, request.scope)
        && scopePolicyAbsent
        ? await platformAdministratorProof(client, principalId, request.actingSubject, true,
          zonePage.kind === 'zone' ? { action: 'zone.edit', scope: zoneEditScope(zonePage.zone) } : undefined) : null;
      const administratorTarget = administratorCandidate
        ? { ...administratorCandidate, resolved_zone_page: zonePage.kind === 'zone' ? zonePage.zone : null } : null;
      const administrator = administratorTarget && (administratorTarget.resolved_zone_page
        ? await zonePageAdministratorAllowed(client, this.baselineGraph, principalId,
          request.actingSubject, administratorTarget, request.action)
        : await platformAdministratorTargetAllowed(client, this.baselineGraph, principalId,
          request.actingSubject, request.action, request.scope)) ? administratorTarget : null;
      if (!existing && ['media.labels.protect','media.conceal.protect'].includes(request.action) && !administrator) {
        throw new AdmissionDenied('media protection requires the platform administrator proof');
      }
      const baseline = !existing && !administrator && !request.requireExplicitGrant ? await newBaselineProof(client, this.baselineGraph, request,
        principalId, memberReply ? this.replyRootDecision(client, request.principal, request.actingSubject) : undefined,
        scopePolicyAbsent) : null;
      if (!existing && zonePage.kind === 'refused') {
        throw new AdmissionDenied('Content zone page target is unresolved');
      }
      if (!existing && zonePage.kind === 'zone' && !baseline && !administrator
        && scopePolicyAbsent) {
        throw new AdmissionDenied('Zone edit authority is unavailable');
      }
      const rating = !existing && authorityPath === 'represented-agent' && ratingConfiguration
        ? await realmRatingProof(client, this.baselineGraph, principalId, request.actingSubject,
          request.action, request.scope) : null;
      if (memberReply && (!baseline || administrator)) {
        throw new AdmissionDenied('member reply authoring requires a Person baseline proof');
      }
      if (administrator || baseline || rating) {
        // A named grant source with its own pinned proof, recorded below in the
        // same transaction as the ordinary admission, receipt and audit outbox.
      } else if (authorityPath === 'direct-principal') {
        if (subject.rows[0]?.kind !== 'agent') throw new AdmissionDenied('public attribution is not an Agent');
        const proof = await directWorkCreateProof(client, principalId, request.actingSubject);
        if (!proof) {
          throw new AdmissionDenied('direct principal or public attribution is not admitted');
        }
        directGrantId = proof.grantId;
        attributionId = proof.attributionId;
        directGrantGeneration = proof.grantGeneration;
        attributionGeneration = proof.attributionGeneration;
        directSubjectGeneration = proof.subjectGeneration;
        directPrincipalEpoch = principal.enforcement_epoch;
        privateGroupMemberId = proof.group?.memberId ?? null;
        privateGroupMemberGeneration = proof.group?.memberGeneration ?? null;
        privateGroupGrantId = proof.group?.grantId ?? null;
        privateGroupGrantGeneration = proof.group?.grantGeneration ?? null;
        privateGroupGeneration = proof.group?.groupGeneration ?? null;
        privateRoleBindingId = proof.role?.bindingId ?? null;
        privateRoleBindingGeneration = proof.role?.bindingGeneration ?? null;
        privateRoleFamilyId = proof.role?.familyId ?? null;
        privateRoleRevision = proof.role?.roleRevision ?? null;
      } else {
        // Recommendation edits have their own durable action and receipt, while
        // inheriting the exact Work editor mandate and grant boundary.
        const authorityAction = admissionAuthorityAction(request.action, request.scope);
        if (request.action === 'work.create' && request.scope === 'work:create:root'
          || ['work.edit', 'work.derive', 'relation.change'].includes(request.action)
            && /^work:edit:https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(request.scope)) {
          if (subject.rows[0]?.kind !== 'agent') throw new AdmissionDenied('acting subject is not an Agent');
          const proof = await representedWorkProof(client, principalId, request.actingSubject,
            authorityAction as 'work.create' | 'work.edit', request.scope);
          if (!proof) throw new AdmissionDenied('representation is not admitted');
          // Publishing invitations do not delegate administrator-only creation
          // kinds or imports. Controller/grant/group/role paths retain G-508's policy.
          if (proof.path && !baselineWorkTypesAllowed(request)) {
            throw new AdmissionDenied('publishing delegation does not cover administrator Work kinds');
          }
          publishingProof = proof;
          representedRepresentationId = proof.representationId;
          representedRepresentationGeneration = proof.representationGeneration;
          representedSubjectGeneration = proof.subjectGeneration;
          representedPrincipalEpoch = principal.enforcement_epoch;
          representedGrantId = proof.grantId;
          representedGrantGeneration = proof.grantGeneration;
          if (!proof.grantId) {
            const group = request.action === 'work.create'
              ? await groupWorkCreateProof(client, request.actingSubject) : null;
            groupMemberId = group?.memberId ?? null;
            groupGrantId = group?.grantId ?? null;
            groupGeneration = group?.groupGeneration ?? null;
            if (!group) {
              const role = await roleWorkProof(client, request.actingSubject,
                authorityAction as 'work.create' | 'work.edit');
              if (role && authorityAction === 'work.edit'
                && !await publicCatalogueWork(this.baselineGraph, request.scope.slice('work:edit:'.length))) {
                throw new AdmissionDenied('Catalogue edit roles require a publicly readable Work');
              }
              roleBindingId = role?.bindingId ?? null;
              roleBindingGeneration = role?.bindingGeneration ?? null;
              roleFamilyId = role?.familyId ?? null;
              roleRevision = role?.roleRevision ?? null;
            }
          }
          if (!representedGrantId && !groupGrantId && !roleBindingId) {
            throw new AdmissionDenied('permission is not granted');
          }
        } else {
          const represented = await client.query<{ id: string; generation: string }>(
            `SELECT id, generation FROM access.representation
             WHERE principal_id = $1 AND subject_id = $2
               AND action = ANY(CASE WHEN $3 IN ('review.decide','publication.adopt')
                 THEN ARRAY[$3,'agent.control'] ELSE ARRAY[$3] END)
               AND active AND valid_until > statement_timestamp()
             ORDER BY action, valid_until LIMIT 1 FOR SHARE`,
            [principalId, request.actingSubject, authorityAction]);
          if (represented.rowCount !== 1) throw new AdmissionDenied('representation is not admitted');
          const granted = await client.query<{ id: string; generation: string }>(
            `SELECT id, generation FROM access.permission_grant
             WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3
               AND active AND valid_until > statement_timestamp()
             ORDER BY valid_until LIMIT 1 FOR SHARE`,
            [request.actingSubject, request.scope, authorityAction]);
          if (granted.rowCount !== 1) throw new AdmissionDenied('permission is not granted');
          authoritySources.push(
            { table: 'representation', id: represented.rows[0]!.id, generation: represented.rows[0]!.generation },
            { table: 'permission_grant', id: granted.rows[0]!.id, generation: granted.rows[0]!.generation });
        }
      }

      if (existing) {
        if (existing.request_digest !== request.requestDigest
          || existing.acting_subject !== request.actingSubject
          || existing.authority_path !== authorityPath
          || existing.scope_id !== request.scope) {
          throw new AdmissionConflict('idempotency key belongs to a different intent');
        }
        if (!transaction) await client.query('COMMIT');
        return {
          id: existing.id, principalId: existing.principal_id,
          actingSubject: existing.acting_subject, scope: existing.scope_id,
          authorityPath: existing.authority_path,
          action: existing.action, idempotencyKey: existing.idempotency_key,
          requestDigest: existing.request_digest,
          authorityEpoch: existing.authority_epoch,
          registeredAt: existing.registered_at.toISOString(), expiresAt: existing.expires_at.toISOString(),
          state: existing.state as RegisteredAdmission['state'],
          dispatchEligible: witnessCurrent && gate.open && gate.dispatch_open
            && existing.authority_epoch === gate.authority_epoch && existing.state !== 'sealed' && existing.eligible,
          replayed: true,
        };
      }
      if (!gate.open) throw new AdmissionDenied('scope is closed');

      // 'open' is policy authority without a membership row. Claim still
      // rechecks that policy through baselineProofCurrent and participation.
      if (baseline?.realm_membership && baseline.realm_membership !== 'open'
        && baseline.realm_membership !== ZONE_PAGE_CONTENT_PROOF) {
        const [kind, membershipId, generation] = baseline.realm_membership.split(':');
        authoritySources.push({ table: kind === 'owner' ? 'permission_grant'
          : kind === 'private' ? 'private_membership' : 'membership', id: membershipId!, generation });
      }
      // The active principal's exact epoch is already held FOR SHARE above.
      const witness: AuthorityWitness[] = [{ table: 'principal', id: principalId,
        generation: principal.enforcement_epoch }, ...await captureAuthorityWitness(client, [...authoritySources,
        { table: 'principal_permission_grant', id: directGrantId, generation: directGrantGeneration },
        { table: 'principal_agent_attribution', id: attributionId, generation: attributionGeneration },
        { table: 'private_group_member', id: privateGroupMemberId, generation: privateGroupMemberGeneration },
        { table: 'group_permission_grant', id: privateGroupGrantId, generation: privateGroupGrantGeneration },
        { table: 'private_role_binding', id: privateRoleBindingId, generation: privateRoleBindingGeneration },
        { table: 'group_member', id: groupMemberId },
        { table: 'group_permission_grant', id: groupGrantId },
        { table: 'representation', id: representedRepresentationId, generation: representedRepresentationGeneration },
        { table: 'permission_grant', id: representedGrantId, generation: representedGrantGeneration },
        { table: 'role_binding', id: roleBindingId, generation: roleBindingGeneration },
        { table: 'authority_subject', id: publishingProof?.path?.origin ?? null },
        { table: 'representation_edge', id: publishingProof?.path?.edgeId ?? null,
          generation: publishingProof?.path?.edgeGeneration },
        { table: 'representation', id: baseline?.representation_id ?? administrator?.representation_id
          ?? rating?.representation_id ?? null, generation: baseline?.representation_generation
          ?? administrator?.representation_generation ?? rating?.representation_generation },
        { table: 'representation', id: baseline?.avatar_control_id ?? null, generation: baseline?.avatar_control_generation },
        { table: 'permission_grant', id: rating?.grant_id ?? null, generation: rating?.grant_generation },
      ])];
      if (!scopePolicyAbsent && !await admissionPolicyAllowed(client, principalId, request.actingSubject,
        request.scope, request.action, { witness, eligible: true })) {
        throw new AdmissionDenied('published policy denies admission');
      }
      if (authorityOnly) {
        if (!gate.dispatch_open) throw new AdmissionDenied('scope dispatch is closed');
        throw new AuthorityChecked();
      }
      const id = Bun.randomUUIDv7();
      const inserted = await client.query<{ expires_at: Date; registered_at: Date }>(
        `INSERT INTO access.admission
           (id, principal_id, acting_subject, authority_path, direct_grant_id, attribution_id,
            direct_grant_generation, attribution_generation, direct_subject_generation,
            direct_principal_epoch,
            private_group_member_id, private_group_member_generation,
            private_group_grant_id, private_group_grant_generation, private_group_generation,
            private_role_binding_id, private_role_binding_generation,
            private_role_family_id, private_role_revision,
            group_member_id, group_grant_id, group_generation,
            represented_representation_id, represented_representation_generation,
            represented_grant_id, represented_grant_generation,
            represented_subject_generation, represented_principal_epoch,
            role_binding_id, role_binding_generation, role_family_id, role_revision,
            scope_id, action, idempotency_key, request_digest, authority_epoch, expires_at, state, authority_witness)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19,
           $20, $21, $22, $23, $24, $25, $26, $27, $28,
           $29, $30, $31, $32, $33, $34, $35, $36, $37,
           LEAST(clock_timestamp() + interval '30 seconds', $39::timestamptz), 'registered', $38::jsonb
         WHERE $39::timestamptz IS NULL OR $39::timestamptz > clock_timestamp()
         RETURNING expires_at, registered_at`,
        [id, principalId, request.actingSubject, authorityPath, directGrantId, attributionId,
          directGrantGeneration, attributionGeneration, directSubjectGeneration,
          directPrincipalEpoch,
          privateGroupMemberId, privateGroupMemberGeneration,
          privateGroupGrantId, privateGroupGrantGeneration, privateGroupGeneration,
          privateRoleBindingId, privateRoleBindingGeneration,
          privateRoleFamilyId, privateRoleRevision,
          groupMemberId, groupGrantId, groupGeneration,
          representedRepresentationId, representedRepresentationGeneration,
          representedGrantId, representedGrantGeneration,
          representedSubjectGeneration, representedPrincipalEpoch,
          roleBindingId, roleBindingGeneration, roleFamilyId, roleRevision,
          request.scope, request.action, request.idempotencyKey,
          request.requestDigest, gate.authority_epoch, JSON.stringify(witness), authorityWitnessDeadline(witness)]);
      if (!inserted.rows[0]) throw new AdmissionDenied('selected authority expired during registration');
      if (baseline) {
        await saveBaselineProof(client, id, baseline);
        if (request.action === 'space.create') await reserveBaselineSpace(client, principalId, id, request.requestDigest);
      }
      if (administrator) await savePlatformAdministratorProof(client, id, administrator);
      if (rating) await saveRealmRatingProof(client, id, rating);
      if (publishingProof?.path) await saveInvitedWorkProof(client, id, principalId,
        principal.enforcement_epoch, request.actingSubject, publishingProof);
      await client.query(
        `INSERT INTO access.admission_receipt
           (admission_id, principal_id, action, idempotency_key, request_digest, outcome)
         VALUES ($1, $2, $3, $4, $5, 'registered')`,
        [id, principalId, request.action, request.idempotencyKey, request.requestDigest]);
      await client.query(
        `INSERT INTO access.outbox (id, kind, admission_id, scope_id, authority_epoch)
         VALUES ($1, 'admission.registered', $2, $3, $4)`,
        [Bun.randomUUIDv7(), id, request.scope, gate.authority_epoch]);
      if (!transaction) await client.query('COMMIT');
      return {
        id, principalId, actingSubject: request.actingSubject, authorityPath,
        scope: request.scope, action: request.action, idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        authorityEpoch: gate.authority_epoch,
        registeredAt: inserted.rows[0]!.registered_at.toISOString(),
        expiresAt: inserted.rows[0]!.expires_at.toISOString(), state: 'registered',
        dispatchEligible: true, replayed: false,
      };
    } catch (error) {
      if (!transaction) await rollback(client);
      throw admissionError(error);
    } finally {
      if (!transaction) client.release();
    }
  }

  /** Explicit import scope only: one locked authority cut, per-item immutable
   * admission/claim audit, then a separate atomic graph-proof acknowledgement.
   * SQL runs server-side so a catalogue does not pay 40 network trips per Work. */
  async admitCatalogue(principal: VerifiedPrincipal, actor: string,
    items: readonly { key: string; digest: string }[]): Promise<({ admission: RegisteredAdmission } | { status: 'denied' | 'conflict' })[]> {
    return this.catalogueTransaction(async client => {
      await requireRecoveryOpen(client);
      const result = await client.query<{ result: { principalId: string | null;
        items: { admission?: AdmissionRow; dispatchEligible?: boolean; replayed?: boolean; status?: 'denied' | 'conflict' }[] } }>(
        'SELECT access.catalogue_import_admit($1,$2,$3,$4::jsonb) AS result',
        [principal.issuer, principal.subject, actor, JSON.stringify(items)]);
      const body = result.rows[0]!.result;
      if (!body.principalId) return items.map(() => ({ status: 'denied' as const }));
      await requirePlatformParticipation(client, body.principalId);
      return body.items.map(item => {
        if (!item.admission) return { status: item.status! };
        const row = item.admission;
        return { admission: { id: row.id, principalId: row.principal_id, actingSubject: row.acting_subject,
          authorityPath: row.authority_path, scope: row.scope_id, action: row.action, idempotencyKey: row.idempotency_key,
          requestDigest: row.request_digest, authorityEpoch: String(row.authority_epoch),
          registeredAt: new Date(String(row.registered_at)).toISOString(), expiresAt: new Date(String(row.expires_at)).toISOString(),
          state: row.state as RegisteredAdmission['state'], dispatchEligible: item.dispatchEligible!, replayed: item.replayed! } };
      });
    });
  }
  async recordCatalogueOutcomes(proofs: readonly (GraphTerminalProof & { work?: string; mainVersion?: string })[]): Promise<void> {
    await this.catalogueTransaction(async client => {
      await requireRecoveryOpen(client);
      await client.query('SELECT access.catalogue_import_outcomes($1::jsonb)', [JSON.stringify(proofs)]);
    });
  }

  /** Bounded catalogue orchestration shares PostgreSQL durability, not an
   * authority shortcut. Register, claim and terminal proof retain their normal
   * fences. The caller stages objects and dispatches Jena only after commit. */
  private async catalogueTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await rollback(client); throw error; }
    finally { client.release(); }
  }

  /** Gate-first claim linearizes dispatch against a strong scope closure. */
  async claim(admissionId: string, requestDigest: string,
    accountPrincipal?: VerifiedPrincipal): Promise<ClaimedAdmission> {
    return this.claimOnClient(await admissionClient(this.pool), admissionId, requestDigest, accountPrincipal);
  }

  /** A Realm callback may lock and revalidate an independently committed claim,
   * but cannot create a claim that native effects could outlive on rollback. */
  fenceClaim(client: PoolClient, admissionId: string, requestDigest: string,
    accountPrincipal?: VerifiedPrincipal): Promise<ClaimedAdmission> {
    return this.claimOnClient(client, admissionId, requestDigest, accountPrincipal, true);
  }

  private async claimOnClient(client: PoolClient, admissionId: string, requestDigest: string,
    accountPrincipal?: VerifiedPrincipal, fence = false): Promise<ClaimedAdmission> {
    try {
      if (!fence) {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
      }
      await requireRecoveryOpen(client);
      const locator = await client.query<{ scope_id: string; action: string }>(
        'SELECT scope_id, action FROM access.admission WHERE id = $1', [admissionId]);
      if (locator.rowCount !== 1) throw new AdmissionDenied('unknown admission');
      const scope = locator.rows[0]!.scope_id;
      const gateResult = await client.query<GateRow & { group_generation: string }>(
        `SELECT authority_epoch, group_generation, open, dispatch_open FROM access.scope_gate
         WHERE id = $1 FOR ${admissionGateLock}`, [scope]);
      if (gateResult.rows[0]?.dispatch_open !== true) throw new AdmissionDenied('dispatch is fenced');
      // Source writers acquire the source before fixing their drain's admission
      // rows. Take the same order so claim cannot hold an admission while it
      // waits for the source that its revoker already owns.
      const cut = (await client.query<{ authority_witness: AuthorityWitness[] | null; eligible: boolean; topology: boolean }>(
        `SELECT authority_witness, EXISTS (SELECT 1 FROM access.admission_obligation o
          WHERE o.admission_id = a.id AND o.path_id IS NOT NULL) AS topology, expires_at > clock_timestamp() AND state IN ('registered','claimed') AS eligible
         FROM access.admission a WHERE id = $1`, [admissionId])).rows[0];
      if (cut?.topology && !(await client.query(
        "SELECT 1 FROM access.scope_gate WHERE id = 'access:representation-topology' AND open AND dispatch_open FOR SHARE")).rowCount) {
        throw new AdmissionDenied('representation topology is closed');
      }
      if (cut?.authority_witness && !await authorityWitnessCurrent(client, cut.authority_witness)) {
        throw new AdmissionDenied('selected authority changed before dispatch');
      }
      const result = await client.query<AdmissionRow & { claimed_at: Date | null }>(
        `SELECT authority_witness, id, principal_id, acting_subject, authority_path, direct_grant_id,
                attribution_id, direct_grant_generation, attribution_generation,
                direct_subject_generation, direct_principal_epoch,
                private_group_member_id, private_group_member_generation,
                private_group_grant_id, private_group_grant_generation, private_group_generation,
                private_role_binding_id, private_role_binding_generation,
                private_role_family_id, private_role_revision,
                group_member_id, group_grant_id, group_generation,
                represented_representation_id, represented_representation_generation,
                represented_grant_id, represented_grant_generation,
                represented_subject_generation, represented_principal_epoch,
                role_binding_id, role_binding_generation, role_family_id, role_revision,
                scope_id, action, idempotency_key,
                request_digest, authority_epoch, registered_at, expires_at, state, claimed_at,
                (expires_at > clock_timestamp()) AS eligible
         FROM access.admission WHERE id = $1 FOR UPDATE`, [admissionId]);
      const row = result.rows[0];
      if (!row || row.scope_id !== scope || !row.eligible || !['registered', 'claimed'].includes(row.state)) {
        throw new AdmissionExpired('admission is not dispatchable');
      }
      if (fence && row.state !== 'claimed') {
        throw new AdmissionDenied('native dispatch requires an independently committed claim');
      }
      if (row.action === 'publication.reject.organization') {
        throw new AdmissionDenied('organization moderation cannot use generic claim');
      }
      if (['reply.create', 'media.member-reply.use'].includes(row.action)
        && !await savedBaselineProof(client, row.id)) {
        throw new AdmissionDenied('member reply authoring requires a Person baseline admission');
      }
      if (row.authority_epoch !== gateResult.rows[0]?.authority_epoch) {
        throw new AdmissionDenied('admission scope epoch is stale');
      }
      const principal = await client.query<{ active: boolean; enforcement_epoch: string;
        account_issuer: string; account_subject: string }>(
        'SELECT active, enforcement_epoch, account_issuer, account_subject FROM access.principal WHERE id = $1 FOR SHARE',
        [row.principal_id]);
      if (principal.rows[0]?.active !== true) throw new AdmissionDenied('principal dispatch is fenced');
      await requirePlatformParticipation(client, row.principal_id);
      await requireRealmParticipation(client, row.scope_id, row.action, row.principal_id, row.acting_subject);
      const rating = ratingConfigurationAction(row.action)
        ? await savedRealmRatingProof(client, row.id) : null;
      if (rating && !await realmRatingProof(client, this.baselineGraph, row.principal_id, row.acting_subject,
        row.action, row.scope_id, rating)) {
        throw new AdmissionDenied('Realm rating authority changed before claim');
      }
      await checkEditorialAdmission(client, row.id,this.baselineGraph, {
        principal: accountPrincipal ?? { issuer: principal.rows[0]!.account_issuer, subject: principal.rows[0]!.account_subject },
        actingSubject: row.acting_subject, action: row.action, scope: row.scope_id,
        idempotencyKey: row.idempotency_key, requestDigest: row.request_digest,
      });
      const administrator = await savedPlatformAdministratorProof(client, row.id);
      const baseline = await savedBaselineProof(client, row.id);
      // Reply-root metadata is request-local for content.draft. Replay marks an
      // old nonbaseline member-reply intent nondispatchable before its owner
      // reaches claim; ordinary administrator-backed Work and Post drafts have
      // no baseline proof and still need this claim path.
      if (administrator) {
        let current: VerifiedPrincipal | undefined;
        try { current = await accountPrincipal?.currentAssertion?.(); }
        catch (error) {
          if (error instanceof AccountAssertionDenied) throw new AdmissionDenied('administrator Account assertion is inactive');
          throw error;
        }
        if (!current || current.issuer !== principal.rows[0]!.account_issuer
          || current.subject !== principal.rows[0]!.account_subject
          || !platformAdministratorAction(row.action, row.scope_id)
          || !await platformAdministratorProofCurrent(client, administrator, row.principal_id, row.acting_subject)
          || !(administrator.resolved_zone_page
            ? await zonePageAdministratorAllowed(client, this.baselineGraph, row.principal_id,
              row.acting_subject, administrator, row.action)
            : await platformAdministratorTargetAllowed(client, this.baselineGraph, row.principal_id,
              row.acting_subject, row.action, row.scope_id))
          || (await client.query('SELECT id FROM access.policy WHERE scope_id = $1', [row.scope_id])).rowCount) {
          throw new AdmissionDenied('platform administrator authority changed before claim');
        }
      }
      if (row.action === 'review.decide' || row.action === 'publication.adopt') {
        const current = await client.query(`SELECT 1 FROM access.representation r
          JOIN access.authority_subject s ON s.id = r.subject_id AND s.active
          JOIN access.permission_grant g ON g.recipient_subject = s.id AND g.scope_id = $4
            AND g.action = $3 AND g.active AND g.valid_until > clock_timestamp()
            AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m
              WHERE m.id = g.membership_id AND m.state = 'joined' AND m.generation = g.membership_generation))
          WHERE r.principal_id = $1 AND r.subject_id = $2 AND r.action IN ($3,'agent.control')
            AND r.active AND r.valid_until > clock_timestamp() LIMIT 1 FOR SHARE OF r,s,g`,
        [row.principal_id, row.acting_subject, row.action, row.scope_id]);
        if (!current.rowCount) throw new AdmissionDenied('Reviewer authority changed before claim');
      }
      if (baseline) {
        const identity = principal.rows[0]!;
        let current: VerifiedPrincipal | undefined;
        try { current = await accountPrincipal?.currentAssertion?.(); }
        catch (error) {
          if (error instanceof AccountAssertionDenied) throw new AdmissionDenied('baseline Account assertion is inactive');
          throw error;
        }
        if (current?.emailVerified !== true || current.issuer !== identity.account_issuer
          || current.subject !== identity.account_subject) {
          throw new AdmissionDenied('baseline claim needs the current verified Account assertion');
        }
        accountPrincipal = current;
      }
      if (baseline && !await baselineProofCurrent(client, this.baselineGraph, baseline, row,
        this.replyRootDecision(client, accountPrincipal!, row.acting_subject))) {
        throw new AdmissionDenied('baseline member authority changed before claim');
      }
      if (baseline && (await client.query(`SELECT id FROM access.admission
        WHERE id = $1 AND expires_at > clock_timestamp()`, [row.id])).rowCount !== 1) {
        // Account and target reads can consume the remainder of the lease.
        throw new AdmissionExpired('baseline admission expired during claim verification');
      }
      if (row.authority_path === 'direct-principal') {
        if (!await selectedDirectWorkProof(client, row, principal.rows[0]!.enforcement_epoch)) {
          throw new AdmissionDenied('private principal authority changed before claim');
        }
      }
      if (!baseline && !administrator && row.authority_path === 'represented-agent'
        && (row.action === 'work.create' && row.scope_id === 'work:create:root'
          || ['work.edit', 'relation.change', 'work.derive'].includes(row.action) && row.represented_representation_id)
        && !await selectedRepresentedWorkProof(client, row,
          principal.rows[0]!.enforcement_epoch, this.baselineGraph)) {
        throw new AdmissionDenied('represented authority changed before claim');
      }
      if (!await admissionPolicyAllowed(client, row.principal_id, row.acting_subject,
        row.scope_id, row.action, { witness: row.authority_witness ?? [], eligible: true })) {
        throw new AdmissionDenied('published policy denies dispatch');
      }
      if (row.authority_witness && !await authorityWitnessCurrent(client, row.authority_witness)) {
        throw new AdmissionDenied('selected authority changed before dispatch');
      }
      if (row.request_digest !== requestDigest) throw new AdmissionConflict('claim digest differs');
      if (!(await client.query(`SELECT id FROM access.admission
        WHERE id = $1 AND expires_at > clock_timestamp()`, [row.id])).rowCount) {
        throw new AdmissionExpired('admission expired during claim verification');
      }
      let claimedAt = row.claimed_at;
      if (row.state === 'registered') {
        const updated = await client.query<{ claimed_at: Date }>(
          `UPDATE access.admission SET state = 'claimed', claimed_at = clock_timestamp()
           WHERE id = $1 AND expires_at > clock_timestamp() RETURNING claimed_at`,
          [admissionId]);
        if (!updated.rows[0]) throw new AdmissionExpired('admission expired before dispatch');
        claimedAt = updated.rows[0]!.claimed_at;
        await client.query(
          `INSERT INTO access.outbox (id, kind, admission_id, scope_id, authority_epoch)
           VALUES ($1, 'admission.claimed', $2, $3, $4)`,
          [Bun.randomUUIDv7(), admissionId, scope, row.authority_epoch]);
      }
      if (!fence) await client.query('COMMIT');
      return { id: row.id, principalId: row.principal_id, actingSubject: row.acting_subject,
        authorityPath: row.authority_path,
        scope, action: row.action, idempotencyKey: row.idempotency_key,
        requestDigest: row.request_digest, authorityEpoch: row.authority_epoch,
        registeredAt: row.registered_at.toISOString(), expiresAt: row.expires_at.toISOString(), state: 'claimed', dispatchEligible: true,
        replayed: row.state === 'claimed',
        claimedAt: claimedAt!.toISOString() };
    } catch (error) {
      if (!fence) await rollback(client);
      throw admissionError(error);
    } finally {
      if (!fence) client.release();
    }
  }

  /** Commits the strong fence; graph outcomes must still be sealed before completion. */
  async strongCloseScope(scope: string, expectedEpoch: string): Promise<StrongScopeClosure> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      const result = await client.query<GateRow>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE', [scope]);
      const gate = result.rows[0];
      if (!gate) throw new AdmissionUnavailable('scope gate is unavailable');
      let authorityEpoch = gate.authority_epoch;
      if (gate.dispatch_open) {
        if (gate.authority_epoch !== expectedEpoch) throw new AdmissionConflict('scope epoch changed');
        const changed = await client.query<{ authority_epoch: string }>(
          `UPDATE access.scope_gate SET open = false, dispatch_open = false,
                  authority_epoch = authority_epoch + 1 WHERE id = $1
           RETURNING authority_epoch`, [scope]);
        authorityEpoch = changed.rows[0]!.authority_epoch;
        await client.query(
          `INSERT INTO access.outbox (id, kind, scope_id, authority_epoch)
           VALUES ($1, 'scope.strong_closed', $2, $3)`,
          [Bun.randomUUIDv7(), scope, authorityEpoch]);
      }
      const pending = await client.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM access.admission WHERE scope_id = $1 AND state <> 'sealed'", [scope]);
      const pendingReads = await pendingSearchReads(client, 'scope_id', scope, true);
      await client.query('COMMIT');
      return { scope, authorityEpoch,
        pending: Number(pending.rows[0]?.count ?? '0') + pendingReads, pendingReads };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Commit the private principal fence; caller drains/seals pending graph outcomes. */
  async strongDeactivatePrincipal(
    principalId: string, expectedEpoch: string,
  ): Promise<StrongPrincipalDeactivation> {
    return this.deactivatePrincipal(principalId, expectedEpoch, false);
  }

  private async deactivatePrincipal(
    principalId: string, expectedEpoch: string, accountDeletion: boolean,
    options: AccountDeletionOptions = {}, heldClient?: PoolClient,
  ): Promise<StrongPrincipalDeactivation> {
    if (!/^[0-9a-f-]{36}$/.test(principalId) || !/^[0-9]+$/.test(expectedEpoch)) {
      throw new AdmissionDenied('invalid principal fence request');
    }
    const client = heldClient ?? await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      // The read budget requires indexed seeks even when small-table cost
      // estimates would favor scanning retained authority or other erasures.
      // Bitmap scans gather an entire matching range before a page's LIMIT.
      await client.query(accountDeletion
        ? "SET LOCAL statement_timeout = '5s'; SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off; SET LOCAL jit = off"
        : "SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      // Principal fences also remove controller authority. Serialize them with
      // topology changes and resumable deletion before taking the principal lock.
      await lockAccountDeletionTopology(client);
      const result = await client.query<{ active: boolean; enforcement_epoch: string }>(
        'SELECT active, enforcement_epoch FROM access.principal WHERE id = $1 FOR UPDATE',
        [principalId]);
      const principal = result.rows[0];
      if (!principal) throw new AdmissionUnavailable('principal is unavailable');
      let enforcementEpoch = principal.enforcement_epoch;
      let deletionOperationId = Bun.randomUUIDv7();
      let deletionPending = false;
      let deletionNeedsContinuity = false;
      if (principal.active) {
        const controlled = accountDeletion ? [] : await principalControllerSubjects(client, principalId);
        if (!accountDeletion) await lockControllerContinuity(client, controlled);
        if (enforcementEpoch !== expectedEpoch) throw new AdmissionConflict('principal epoch changed');
        if (accountDeletion) {
          const progress = await collectAccountDeletionAgents(client, principalId, deletionOperationId, options);
          if (progress) {
            deletionOperationId = progress.operation_id;
            const step = await applyAccountDeletionAgents(client, principalId, progress);
            deletionPending = step.pending;
            deletionNeedsContinuity = step.checkBoundary;
          }
          if (deletionPending) {
            await client.query('COMMIT');
            // Classification and orphan pages retain active Access. Release
            // transaction locks and resume the durable frontier on the next step.
            return await this.deactivatePrincipal(principalId, enforcementEpoch, true, options, client);
          }
        }
        const changed = await client.query<{ enforcement_epoch: string }>(
          `UPDATE access.principal SET active = false,
             enforcement_epoch = enforcement_epoch + 1 WHERE id = $1
           RETURNING enforcement_epoch`, [principalId]);
        if (accountDeletion && deletionNeedsContinuity) await assertAccountDeletionContinuity(client, principalId, deletionOperationId);
        else if (!accountDeletion) await assertControllerContinuity(client, controlled);
        enforcementEpoch = changed.rows[0]!.enforcement_epoch;
        await client.query(
          `INSERT INTO access.outbox (id, kind, principal_id, authority_epoch)
           VALUES ($1, 'principal.deactivated', $2, $3)`,
          [Bun.randomUUIDv7(), principalId, enforcementEpoch]);
      }
      if (accountDeletion && !principal.active) {
        const progress = await continueAccountDeletionAgents(client, principalId);
        if (progress) {
          deletionOperationId = progress.operationId;
          deletionPending = progress.pending;
        }
      }
      if (deletionPending) {
        await client.query('COMMIT');
        // Resume a pre-frontier operation already fenced by an older release.
        return await this.deactivatePrincipal(principalId, enforcementEpoch, true, options, client);
      }
      if (accountDeletion) {
        await client.query(
          `INSERT INTO access.outbox (id, kind, principal_id, authority_epoch)
           VALUES ($1, 'account.deletion_fenced', $2, $3)
           ON CONFLICT (principal_id) WHERE kind = 'account.deletion_fenced' DO NOTHING`,
          [deletionOperationId, principalId, enforcementEpoch]);
        const marker = await client.query<{ authority_epoch: string }>(
          `SELECT authority_epoch FROM access.outbox
           WHERE kind = 'account.deletion_fenced' AND principal_id = $1`, [principalId]);
        if (marker.rows[0]?.authority_epoch !== enforcementEpoch) {
          throw new AdmissionConflict('Account deletion fence epoch changed');
        }
      }
      const pending = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM access.admission WHERE principal_id = $1 AND state <> 'sealed'",
        [principalId]);
      const pendingReads = await pendingSearchReads(client, 'principal_id', principalId, true);
      await client.query('COMMIT');
      return { principalId, enforcementEpoch,
        pending: Number(pending.rows[0]?.count ?? '0') + pendingReads, pendingReads };
    } catch (error) {
      await rollback(client);
      // Keep the continuity wording. commandError maps the class, so this refusal
      // is not reported as an idempotency clash.
      if (error instanceof ControlConflict) throw new AdmissionControllerContinuity(error.message);
      if (error instanceof ControlUnavailable) throw new AdmissionUnavailable(error.message);
      throw error;
    } finally {
      if (!heldClient) client.release();
    }
  }

  /** Account deletion hook: fence an existing private binding before deleting credentials. */
  async strongDeactivateAccountSubject(
    issuer: string, subject: string, options: AccountDeletionOptions = {},
  ): Promise<StrongPrincipalDeactivation | null> {
    if (!issuer || !subject) throw new AdmissionDenied('invalid Account binding');
    if (options.leaveOwnedAgentsStanding !== undefined && typeof options.leaveOwnedAgentsStanding !== 'boolean') {
      throw new AdmissionDenied('invalid Account deletion consent');
    }
    const client = await this.pool.connect();
    let principal: { id: string; enforcement_epoch: string } | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL enable_seqscan = off; SET LOCAL jit = off");
      await requireRecoveryOpen(client);
      const result = await client.query<{ id: string; enforcement_epoch: string }>(
        `SELECT id, enforcement_epoch FROM access.principal
         WHERE account_issuer = $1 AND account_subject = $2`, [issuer, subject]);
      principal = result.rows[0];
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
    if (!principal) return null;
    return this.deactivatePrincipal(principal.id, principal.enforcement_epoch, true, options);
  }

  /** One bounded row. The caller proves an edit digest with this actor and no other. */
  async admittedActingSubject(admissionId: string): Promise<string> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(admissionId)) {
      throw new AdmissionDenied('unknown admission');
    }
    // Contributor provenance is also read under the publication fence. That
    // owner keeps its transaction and locks through the native publication CAS.
    const borrowed = accessClient(this.pool);
    const client = borrowed ?? await admissionClient(this.pool);
    try {
      if (!borrowed) {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '2s'");
      }
      const result = await client.query<{ acting_subject: unknown }>(
        'SELECT acting_subject FROM access.admission WHERE id = $1::uuid LIMIT 1', [admissionId]);
      if (!borrowed) await client.query('COMMIT');
      const subject = result.rows[0]?.acting_subject;
      if (result.rows.length !== 1 || typeof subject !== 'string') {
        throw new AdmissionDenied('unknown admission');
      }
      return subject;
    } catch (error) {
      if (!borrowed) await rollback(client);
      if (error instanceof AdmissionDenied || error instanceof AdmissionUnavailable) throw error;
      throw admissionError(error);
    } finally {
      if (!borrowed) client.release();
    }
  }

  async listUnsealedPrincipal(principalId: string, limit = 100): Promise<RegisteredAdmission[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AdmissionDenied('invalid seal batch limit');
    const result = await this.pool.query<AdmissionRow>(
      `SELECT authority_witness, id, principal_id, acting_subject, scope_id, action, idempotency_key,
              request_digest, authority_epoch, registered_at, expires_at, state,
              (expires_at > clock_timestamp()) AS eligible
       FROM access.admission WHERE principal_id = $1 AND state <> 'sealed'
       ORDER BY id LIMIT $2`, [principalId, limit]);
    return result.rows.map(row => ({ id: row.id, principalId: row.principal_id,
      actingSubject: row.acting_subject, scope: row.scope_id, action: row.action,
      idempotencyKey: row.idempotency_key, requestDigest: row.request_digest,
      authorityEpoch: row.authority_epoch,
      registeredAt: row.registered_at.toISOString(), expiresAt: row.expires_at.toISOString(), state: row.state as RegisteredAdmission['state'],
      dispatchEligible: false, replayed: true }));
  }

  async listUnsealed(scope: string, limit = 100): Promise<RegisteredAdmission[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AdmissionDenied('invalid seal batch limit');
    const result = await this.pool.query<AdmissionRow>(
      `SELECT authority_witness, id, principal_id, acting_subject, scope_id, action, idempotency_key,
              request_digest, authority_epoch, registered_at, expires_at, state,
              (expires_at > clock_timestamp()) AS eligible
       FROM access.admission WHERE scope_id = $1 AND state <> 'sealed'
       ORDER BY id LIMIT $2`, [scope, limit]);
    return result.rows.map(row => ({ id: row.id, principalId: row.principal_id,
      actingSubject: row.acting_subject, scope: row.scope_id, action: row.action,
      idempotencyKey: row.idempotency_key, requestDigest: row.request_digest,
      authorityEpoch: row.authority_epoch, registeredAt: row.registered_at.toISOString(), expiresAt: row.expires_at.toISOString(),
      state: row.state as RegisteredAdmission['state'], dispatchEligible: row.eligible,
      replayed: true }));
  }

  /** The caller supplies a just-read terminal Jena receipt, not a timeout inference.
   * Its graph effect has already committed: later revocation cannot prevent the
   * acknowledgement. Authorization must be enforced before owner dispatch. */
  async recordGraphOutcome(admissionId: string, proof: GraphTerminalProof): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      const locator = await client.query<{ scope_id: string; action: string }>(
        'SELECT scope_id, action FROM access.admission WHERE id = $1', [admissionId]);
      if (locator.rowCount !== 1) throw new AdmissionDenied('unknown admission');
      const scope = locator.rows[0]!.scope_id;
      const gate = await client.query<GateRow>(
        `SELECT authority_epoch, open, dispatch_open FROM access.scope_gate
         WHERE id = $1 FOR ${admissionGateLock}`, [scope]);
      if (gate.rowCount !== 1) throw new AdmissionUnavailable('scope gate is unavailable');
      const result = await client.query<AdmissionRow & {
        graph_receipt: string | null; graph_outcome: string | null;
        graph_data_epoch: string | null; graph_sequence: string | null;
      }>(
        `SELECT authority_witness, id, principal_id, acting_subject, scope_id, action, idempotency_key,
                request_digest, authority_epoch, registered_at, expires_at, state, graph_receipt,
                graph_outcome, graph_data_epoch, graph_sequence,
                (expires_at > clock_timestamp()) AS eligible
         FROM access.admission WHERE id = $1 FOR UPDATE`, [admissionId]);
      const row = result.rows[0];
      const receiptFamily = receiptFamilyFor(row?.action);
      const expectedReceipt = receiptFamily && `urn:rezics:receipt:${createHash('sha256')
        .update(`${admissionId}\0${receiptFamily}`).digest('hex')}`;
      if (!row || row.scope_id !== scope || proof.admissionId !== admissionId
        || proof.scope !== scope || proof.requestDigest !== row.request_digest
        || proof.authorityEpoch !== row.authority_epoch
        || !receiptFamily || proof.receipt !== expectedReceipt
        || !/^[0-9]+$/.test(proof.sequence) || !proof.dataEpoch) {
        throw new AdmissionConflict('graph outcome does not match admission');
      }
      if (row.state === 'sealed') {
        if (row.graph_receipt !== proof.receipt || row.graph_outcome !== proof.outcome
          || row.graph_data_epoch !== proof.dataEpoch || row.graph_sequence !== proof.sequence) {
          throw new AdmissionConflict('admission has a different terminal graph outcome');
        }
        await recordInitialMaintainer(client, row, proof);
        await client.query('COMMIT');
        return;
      }
      if (proof.outcome === 'succeeded' && row.state !== 'claimed') {
        throw new AdmissionConflict('unclaimed admission cannot succeed');
      }
      // Only this seal's inventory writes are covered by its graph outbox event.
      // Restore/repair writes retain Discovery's independent source fence.
      const ratingOutbox = proof.outcome === 'succeeded'
        && ['rating.context.create', 'rating.context.policy.set', 'rating.observation.set'].includes(row.action);
      if (ratingOutbox) await client.query("SELECT set_config('rezics.discovery_rating_outbox','on',true)");
      await recordRatingAggregateHead(client, row, proof);
      if (ratingOutbox) await client.query("SELECT set_config('rezics.discovery_rating_outbox','off',true)");
      await recordInitialMaintainer(client, row, proof);
      if (row.action === 'space.create') await settleBaselineSpace(client, admissionId, proof.outcome);
      await client.query(
        `UPDATE access.admission SET state = 'sealed', graph_receipt = $2,
             graph_outcome = $3, graph_data_epoch = $4, graph_sequence = $5,
             sealed_at = clock_timestamp() WHERE id = $1`,
        [admissionId, proof.receipt, proof.outcome, proof.dataEpoch, proof.sequence]);
      await client.query(
        `INSERT INTO access.outbox (id, kind, admission_id, scope_id, authority_epoch)
         VALUES ($1, 'admission.sealed', $2, $3, $4)`,
        [Bun.randomUUIDv7(), admissionId, scope, row.authority_epoch]);
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Ordinary closure fences new claims; already claimed work remains finite. */
  async closeScope(scope: string, expectedEpoch: string): Promise<{ authorityEpoch: string; pending: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      const changed = await client.query<{ authority_epoch: string }>(
        `UPDATE access.scope_gate
         SET open = false, authority_epoch = authority_epoch + 1
         WHERE id = $1 AND authority_epoch = $2 AND open
         RETURNING authority_epoch`, [scope, expectedEpoch]);
      if (changed.rowCount !== 1) throw new AdmissionConflict('scope gate changed or was already closed');
      const epoch = changed.rows[0]!.authority_epoch;
      await client.query(
        `INSERT INTO access.outbox (id, kind, scope_id, authority_epoch)
         VALUES ($1, 'scope.closed', $2, $3)`, [Bun.randomUUIDv7(), scope, epoch]);
      const pending = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM access.admission
         WHERE scope_id = $1 AND state = 'registered' AND expires_at > clock_timestamp()`, [scope]);
      await client.query('COMMIT');
      return { authorityEpoch: epoch, pending: Number(pending.rows[0]?.count ?? '0') };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
