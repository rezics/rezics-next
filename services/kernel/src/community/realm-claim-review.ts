import { randomBytes } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { readPublicIdentities, type PublicIdentity } from '../access/account-data.ts';
import { accessClock } from '../access/access-clock.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { PLATFORM_RESOURCE } from '../access/bootstrap-governance.ts';
import globalContext from '../access/bootstrap-governance-read.sql';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import source from './realm-claim-review-source.sql';
import page from './realm-claim-review-page.sql';
import current from './realm-claim-review-current.sql';
import inspection from './realm-claim-review-page-inspection.sql';
import { readRealmHomePresentation } from './realm-home-presentation.ts';
import type { Access, Actor } from '../request/access.ts';

export type RealmClaimantPresentation = Readonly<{ label: string; href: string | null }>;
export type RealmClaimApprovalAdvice = Readonly<{
  method: 'POST';
  destination: string;
  requiredAction: 'realm:approve_claim';
  requiredHeader: 'Idempotency-Key';
}>;
export type RealmClaimReviewItem = Readonly<{
  realmId: string;
  requestId: string;
  claimantAccountId: string;
  state: 'pending';
  orphanedAt: string;
  claimEligibleAt: string;
  requestedAt: string;
  claimant: RealmClaimantPresentation;
  approvalAdvice: RealmClaimApprovalAdvice;
}>;
export type RealmClaimReviewInspection =
  | Readonly<{
      requestId: string;
      claimantAccountId: string;
      state: 'pending';
      orphanedAt: string;
      claimEligibleAt: string;
      requestedAt: string;
      currentEpisode: true;
      claimant: RealmClaimantPresentation;
      approvalAdvice: RealmClaimApprovalAdvice;
    }>
  | Readonly<{
      requestId: string;
      state: 'approved';
      orphanedAt: string;
      requestedAt: string;
      approvedAt: string;
      currentEpisode: false;
    }>;
export type RealmClaimReviewPresentation =
  | Readonly<{ state: 'available'; name: string; description: string }>
  | Readonly<{ state: 'unavailable' }>;
export type RealmClaimReviewPage = Readonly<{
  claimRequests: readonly RealmClaimReviewItem[];
  next: string | null;
  selectedRequest: RealmClaimReviewInspection | null;
  realmPresentation: RealmClaimReviewPresentation;
}>;

// The selected dependency interface has no token configuration. Cursors use the
// native signer with a process-lifetime key; restart requires a fresh first page.
const tokens: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const denied = () => new ProblemError('not_found');

type InspectionRow = NonNullable<Awaited<ReturnType<typeof inspection.run>>>;

function publicClaimant(identity: PublicIdentity | undefined): RealmClaimantPresentation {
  if (!identity || identity.state !== 'active') return { label: 'Claimant', href: null };
  const handle = identity.handle?.trim() || null;
  const label = identity.displayName?.trim() || (handle ? `@${handle}` : 'Claimant');
  return { label, href: handle ? `/@${encodeURIComponent(handle)}` : null };
}

async function readClaimantBatch(
  pool: Pool,
  accountIds: readonly string[],
): Promise<ReadonlyMap<string, RealmClaimantPresentation>> {
  if (accountIds.length > 20) throw new TypeError('Realm claim identity batch exceeds twenty accounts');
  if (accountIds.length === 0) return new Map();
  const routes = accountIds.map((accountId) => {
    const route = routeOf(accountId);
    if (route === null) throw new ProblemError('dependency_unavailable');
    return route;
  });
  try {
    const identities = await readPublicIdentities(pool, routes, accountIds);
    const byId = new Map(identities.map((identity) => [identity.id, identity]));
    return new Map(accountIds.map((accountId) => [accountId, publicClaimant(byId.get(accountId))]));
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    throw new ProblemError('dependency_unavailable', { detail: 'Current claimant identity is unavailable.' });
  }
}

function approvalAdvice(realmId: string, requestId: string): RealmClaimApprovalAdvice {
  return {
    method: 'POST',
    destination: `/v1/realms/${realmId}/claimRequests/${requestId}:approve`,
    requiredAction: 'realm:approve_claim',
    requiredHeader: 'Idempotency-Key',
  };
}

function inspectionView(
  row: InspectionRow | null | undefined,
  realmId: string,
  claimant: RealmClaimantPresentation = { label: 'Claimant', href: null },
): RealmClaimReviewInspection | null {
  if (!row?.request_id || !row.request_orphaned_at || !row.requested_at || !row.request_claim_eligible_at) return null;
  if (row.state === 'approved' && row.approved_at !== null)
    return {
      requestId: row.request_id,
      state: 'approved',
      orphanedAt: new Date(row.request_orphaned_at).toISOString(),
      requestedAt: new Date(row.requested_at).toISOString(),
      approvedAt: new Date(row.approved_at).toISOString(),
      currentEpisode: false,
    };
  if (
    row.state === 'pending' &&
    row.account_id &&
    row.ownership_state === 'orphaned' &&
    row.current_episode &&
    row.current_request &&
    row.realm_claim_eligible_at
  )
    return {
      requestId: row.request_id,
      claimantAccountId: row.account_id,
      state: 'pending',
      orphanedAt: new Date(row.request_orphaned_at).toISOString(),
      claimEligibleAt: new Date(row.realm_claim_eligible_at).toISOString(),
      requestedAt: new Date(row.requested_at).toISOString(),
      currentEpisode: true,
      claimant,
      approvalAdvice: approvalAdvice(realmId, row.request_id),
    };
  return null;
}

function sameInspection(left: InspectionRow | null | undefined, right: InspectionRow | null | undefined): boolean {
  if (!left || !right) return left === right;
  return (
    left.head_revision_id === right.head_revision_id &&
    left.lifecycle_version === right.lifecycle_version &&
    left.discovery_epoch === right.discovery_epoch &&
    left.ownership_state === right.ownership_state &&
    left.realm_orphaned_at === right.realm_orphaned_at &&
    left.realm_claim_eligible_at === right.realm_claim_eligible_at &&
    left.request_id === right.request_id &&
    left.account_id === right.account_id &&
    left.state === right.state &&
    left.request_orphaned_at === right.request_orphaned_at &&
    left.requested_at === right.requested_at &&
    left.approved_at === right.approved_at
  );
}

/** One current episode, one bounded seek, then fresh authority and source checks.
 * Accounts' approval command remains the only writer and grant producer.
 */
export async function listRealmClaimRequests(
  deps: { pool: Pool; access: Access; clock?: () => Date },
  actor: Actor,
  input: { realmId: string; cursor?: string; limit?: number; inspectRequestId?: string },
  context: { deadline: number },
): Promise<RealmClaimReviewPage> {
  const { realmId } = input;
  const route = routeOf(realmId);
  if (actor.kind !== 'account' || route === null) throw denied();
  if (!Number.isFinite(context.deadline) || Date.now() >= context.deadline) throw new ProblemError('deadline_exceeded');
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
  const examined = Math.min(limit, 20);
  const inspectRequestId =
    input.inspectRequestId !== undefined && routeOf(input.inspectRequestId) === route
      ? input.inspectRequestId
      : undefined;
  const clock = deps.clock ?? accessClock(deps.access);
  const accessContext = { pool: deps.pool, deadline: context.deadline };
  const binding = {
    operation: 'community.realm.claim-review',
    parameters: {
      realmId,
      limit,
      viewer: actor.accountId,
      client: actor.clientId,
      requestedBy: actor.requestedBy,
    },
  };
  // Mint on a released connection before ordinary Access prepares actor evidence.
  async function admission() {
    const time = await withConnection(deps.pool, (client) =>
      mintReadTime(deadlineClient(client, context.deadline), clock),
    );
    try {
      const check = await accessCheck(deps.access, actor, 'realm:approve_claim', PLATFORM_RESOURCE, {
        ...accessContext,
        time,
      });
      return { time, check };
    } catch (error) {
      releaseOperationalTime(time);
      throw error;
    }
  }
  async function snapshot<T>(work: (client: ReturnType<typeof deadlineClient>) => Promise<T>): Promise<T> {
    return withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    });
  }
  async function partition(client: ReturnType<typeof deadlineClient>, targetRoute: number) {
    const value = await readPartition(client, partitionOf(targetRoute));
    if (!value || value.writeState === 'moved') throw new ProblemError('partition_unavailable');
    return value;
  }
  async function authorize(client: ReturnType<typeof deadlineClient>, prepared: Awaited<ReturnType<typeof admission>>) {
    await partition(client, PLATFORM_RESOURCE.route);
    if (
      !(await globalContext.run(client, { route: PLATFORM_RESOURCE.route, resource_id: PLATFORM_RESOURCE.id }))
        ?.global ||
      !(await prepared.check(client, prepared.time))
    )
      throw denied();
  }
  async function readPresentation(): Promise<RealmClaimReviewPresentation> {
    if (Date.now() >= context.deadline) throw new ProblemError('deadline_exceeded');
    try {
      const community = await readRealmHomePresentation(
        {
          pool: deps.pool,
          access: deps.access,
          ...(deps.clock === undefined ? {} : { clock: deps.clock }),
        },
        realmId,
        { actor, deadline: context.deadline },
      );
      return community === null
        ? { state: 'unavailable' }
        : { state: 'available', name: community.name, description: community.description };
    } catch (error) {
      if (Date.now() >= context.deadline || (error instanceof ProblemError && error.code === 'deadline_exceeded'))
        throw new ProblemError('deadline_exceeded');
      return { state: 'unavailable' };
    }
  }

  const initialAccess = await admission();
  let initial;
  try {
    // Reject unauthorized callers before checking out any Realm source.
    await snapshot((client) => authorize(client, initialAccess));
    initial = await snapshot(async (client) => {
      const home = await partition(client, route);
      const at = authoritativeTimeValue(initialAccess.time);
      const realm = await source.run(client, { route, realm: realmId, at });
      let after = '00000000-0000-0000-0000-000000000000';
      if (input.cursor !== undefined) {
        if (!realm?.orphaned_at || !realm.claim_eligible_at) throw denied();
        const decoded = decodeCursor(tokens, binding, input.cursor);
        if (
          !decoded.ok ||
          decoded.after.length !== 4 ||
          typeof decoded.after[0] !== 'string' ||
          routeOf(decoded.after[0]) !== route
        )
          throw new ProblemError('invalid_cursor');
        if (
          decoded.epoch !== home.epoch ||
          decoded.after[1] !== realm.orphaned_at ||
          decoded.after[2] !== realm.lifecycle_version ||
          decoded.after[3] !== realm.discovery_epoch
        )
          throw new ProblemError('stale_cursor');
        after = decoded.after[0];
      }
      const rows =
        realm?.orphaned_at && realm.claim_eligible_at
          ? await page.run(client, {
              route,
              realm: realmId,
              orphaned: realm.orphaned_at,
              after,
              limit: examined,
              at,
            })
          : [];
      const selected = inspectRequestId
        ? await inspection.run(client, { route, realm: realmId, request: inspectRequestId, at })
        : undefined;
      if (!realm && inspectionView(selected, realmId)?.state !== 'approved') throw denied();
      return { realm, rows, epoch: home.epoch, selected };
    });
  } finally {
    releaseOperationalTime(initialAccess.time);
  }

  const pageIdentityIds = [...new Set(initial.rows.filter((row) => row.current_request).map((row) => row.account_id))];
  const initialSelection = inspectionView(initial.selected, realmId);
  const separateSelectionIds =
    initialSelection?.state === 'pending' && !pageIdentityIds.includes(initialSelection.claimantAccountId)
      ? [initialSelection.claimantAccountId]
      : [];
  const readIdentityRound = async () => ({
    page: await readClaimantBatch(deps.pool, pageIdentityIds),
    selected: await readClaimantBatch(deps.pool, separateSelectionIds),
  });
  const firstIdentities = await readIdentityRound();
  const firstPresentation = await readPresentation();
  // Recheck hydrated Accounts and optional presentation outside the Realm checkout.
  const finalIdentities = await readIdentityRound();
  const finalPresentation = await readPresentation();
  const sameIdentityMap = (
    ids: readonly string[],
    left: ReadonlyMap<string, RealmClaimantPresentation>,
    right: ReadonlyMap<string, RealmClaimantPresentation>,
  ) => canonicalize(ids.map((id) => [id, left.get(id)])) === canonicalize(ids.map((id) => [id, right.get(id)]));
  if (
    !sameIdentityMap(pageIdentityIds, firstIdentities.page, finalIdentities.page) ||
    !sameIdentityMap(separateSelectionIds, firstIdentities.selected, finalIdentities.selected)
  )
    throw denied();
  const realmPresentation =
    canonicalize(firstPresentation) === canonicalize(finalPresentation)
      ? finalPresentation
      : { state: 'unavailable' as const };

  // Reprepare outside source checkout, then bind serialization to the current
  // permission, Realm episode, exact selection and partition observations.
  const finalAccess = await admission();
  try {
    return await snapshot(async (client) => {
      const home = await partition(client, route);
      const at = authoritativeTimeValue(finalAccess.time);
      const realm = await source.run(client, { route, realm: realmId, at });
      if (home.epoch !== initial.epoch) throw denied();
      if (initial.realm) {
        if (!realm || canonicalize(realm) !== canonicalize(initial.realm)) throw denied();
      } else if (realm) {
        throw denied();
      }
      const selected = inspectRequestId
        ? await inspection.run(client, { route, realm: realmId, request: inspectRequestId, at })
        : undefined;
      if (
        !initial.realm &&
        (!sameInspection(initial.selected, selected) || inspectionView(selected, realmId)?.state !== 'approved')
      )
        throw denied();
      const rows =
        !realm || initial.rows.length === 0
          ? []
          : await current.run(client, {
              route,
              realm: realmId,
              orphaned: realm.orphaned_at,
              requests: initial.rows.map((row) => row.request_id),
              at,
            });
      const verified = new Map(rows.map((row) => [row.request_id, row]));
      const claimRequests: RealmClaimReviewItem[] = [];
      for (const row of initial.rows) {
        const live = verified.get(row.request_id);
        if (
          !row.current_request ||
          !live?.current_request ||
          live.account_id !== row.account_id ||
          live.requested_at !== row.requested_at
        )
          continue;
        claimRequests.push({
          realmId,
          requestId: row.request_id,
          claimantAccountId: row.account_id,
          state: 'pending',
          orphanedAt: new Date(realm!.orphaned_at).toISOString(),
          claimEligibleAt: new Date(realm!.claim_eligible_at).toISOString(),
          requestedAt: new Date(row.requested_at).toISOString(),
          claimant: finalIdentities.page.get(row.account_id) ?? { label: 'Claimant', href: null },
          approvalAdvice: approvalAdvice(realmId, row.request_id),
        });
      }
      // Ordinary Access evaluates the exact action directly on Global, in this
      // fresh snapshot, using the actual actor. No target-local role can replace it.
      await authorize(client, finalAccess);
      const stableSelection = sameInspection(initial.selected, selected) ? inspectionView(selected, realmId) : null;
      const selectedRequest =
        stableSelection?.state === 'pending'
          ? {
              ...stableSelection,
              claimant: finalIdentities.page.get(stableSelection.claimantAccountId) ??
                finalIdentities.selected.get(stableSelection.claimantAccountId) ?? { label: 'Claimant', href: null },
            }
          : stableSelection;
      const last = initial.rows.at(-1);
      const next =
        initial.realm && initial.rows.length === examined && last
          ? encodeCursor(tokens, binding, {
              epoch: home.epoch,
              after: [last.request_id, realm!.orphaned_at, realm!.lifecycle_version, realm!.discovery_epoch],
            })
          : null;
      return { claimRequests, next, selectedRequest, realmPresentation };
    });
  } finally {
    releaseOperationalTime(finalAccess.time);
  }
}
