import type { Pool } from 'pg';
import { createResourcePublicEligibility } from '../access/index.ts';
import { grantGroupRole } from '../access/resource-group-grant.ts';
import { requireResourceCommand, ResourceAccessWriteDeniedError } from '../access/resource-denials.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { commandTime, mintReadTime, type AuthoritativeTime, type CommandTransaction } from '../command/command.ts';
import { accessCheck, type Access, type AccessClient, type Actor, type Resource } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { ProblemError } from '../http/problem.ts';
import { routeOf } from '../route/route.ts';
import read from './realm-read.sql';
import { realmReadEligibility } from './realm.ts';
import { participationEligibilityAccessWork } from './eligibility-access-work.ts';

export type RealmParticipationReadDecision = { readable?: boolean };
export type RealmParticipationCheck = (
  client: AccessClient,
  input: Readonly<{ realmId: string; actor: Actor; readDecision?: RealmParticipationReadDecision }>,
  time?: AuthoritativeTime,
) => Promise<boolean>;

export type RealmParticipationResult = Readonly<{
  realmId: string | null;
  allowed: boolean;
  readable: boolean | undefined;
}>;

/** Prepare participation and its separate Realm read result before the caller
 * checks out its content anchor. Both decisions belong to the supplied command T.
 */
export async function prepareRealmParticipationResult(
  pool: Pool,
  check: RealmParticipationCheck | undefined,
  actor: Actor,
  realmId: string | null,
  time: AuthoritativeTime,
  deadline: number,
): Promise<RealmParticipationResult> {
  if (realmId === null || !check) return { realmId, allowed: true, readable: true };
  return within(deadline, async () => {
    // Access prepares its evidence through independent pool reads before it
    // evaluates the Realm anchor. Passing a checked-out client here would hold
    // one connection across those reads and deadlock a bounded single-connection
    // pool. Keep this client lazy so each anchored query gets its own checkout.
    const readDecision: RealmParticipationReadDecision = {};
    const allowed = await check(deadlineClient(pool, deadline), { realmId, actor, readDecision }, time);
    return { realmId, allowed, readable: readDecision.readable };
  });
}

/** The native participation eligibility shared by checks and parent validation. */
export function realmParticipationAnchor(resource: Resource) {
  let visibility: 'public' | 'protected' | null = null;
  const native = participationEligibilityAccessWork<{ route: number; id: string }>(resource);
  const eligibility = createResourcePublicEligibility({
    resource,
    action: 'realm:participate',
    work: native.work,
    prepare(context) {
      return native.prepare(context, async () => ({ route: resource.route, id: resource.id }));
    },
    verify(context) {
      return native.verify(context, async (dispatch) => {
        const { client, at } = context;
        const parameters = { route: resource.route, id: resource.id, at };
        const row = await dispatch(native.realmPlan, parameters, () => read.run(client, parameters));
        if (!row) throw new ProblemError('not_found');
        visibility = row?.visibility === 'public' || row?.visibility === 'protected' ? row.visibility : null;
        return visibility === 'public';
      });
    },
  });
  return { resource: { ...resource, eligibility }, visibility: () => visibility };
}

/** Checks participation and the independent Realm read anchor at one T.
 * The participation action uses its exact denial check. A protected Realm also
 * requires realm:read, while the single Realm head read supplies public eligibility.
 * Outside a command, both checks share one read time from the kernel clock.
 */
export function createRealmParticipationCheck(input: {
  pool: Pool;
  access: Access;
  clock: () => Date;
}): RealmParticipationCheck {
  return async (client, { realmId, actor, readDecision }, time) => {
    const route = routeOf(realmId);
    if (route === null) return false;
    const resource: Resource = { route, id: realmId };
    const context = { pool: input.pool, deadline: deadlineFor(1500) };
    const anchor = realmParticipationAnchor(resource);
    const participationCheck = await accessCheck(input.access, actor, 'realm:participate', anchor.resource, context);
    const checkedTime = time ?? commandTime(client) ?? (await mintReadTime(client, input.clock));
    const participates = await participationCheck(client, checkedTime);
    const visibility = anchor.visibility();
    if (visibility === 'public') {
      if (readDecision) readDecision.readable = true;
      return participates;
    }
    if (visibility !== 'protected') {
      if (readDecision) readDecision.readable = false;
      return false;
    }
    // The standalone participation route performs its own ordinary read after
    // a denial. Commands already have T and need the same read decision here
    // to conceal an unreadable protected Realm before choosing 404 or 403.
    if (!participates && !time) return false;

    const readCheck = await accessCheck(
      input.access,
      actor,
      'realm:read',
      { ...resource, eligibility: realmReadEligibility(resource) },
      context,
    );
    const readable = await readCheck(client, checkedTime);
    if (readDecision) readDecision.readable = readable;
    return participates && readable;
  };
}

/** Installs the Realm's member-group role only while the Realm is protected.
 * The command must already be authorized against this exact Realm.
 */
export async function ensureRealmMemberGrant(
  tx: CommandTransaction,
  input: Readonly<{ realmId: string }>,
): Promise<void> {
  const route = routeOf(input.realmId);
  if (route === null) throw new ResourceAccessWriteDeniedError();
  const resource = { route, id: input.realmId };
  const at = requireResourceCommand(tx, resource);
  const realm = await read.run(tx, { route, id: input.realmId, at });
  if (realm?.visibility !== 'protected') return;
  await grantGroupRole(tx, {
    resource,
    principal: { kind: 'realm', id: input.realmId },
    role: 'member',
    resourceRole: 'community.realm.member',
  });
}
