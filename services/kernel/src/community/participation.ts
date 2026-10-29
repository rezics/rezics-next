import type { Pool } from 'pg';
import { createResourcePublicEligibility } from '../access/index.ts';
import { grantGroupRole } from '../access/resource-group-grant.ts';
import { requireResourceCommand, ResourceAccessWriteDeniedError } from '../access/resource-denials.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { commandTime, mintReadTime, type AuthoritativeTime, type CommandTransaction } from '../command/command.ts';
import { accessCheck, type Access, type AccessClient, type Actor, type Resource } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import read from './realm-read.sql';

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
    const client = await pool.connect();
    try {
      const readDecision: RealmParticipationReadDecision = {};
      const allowed = await check(deadlineClient(client, deadline), { realmId, actor, readDecision }, time);
      return { realmId, allowed, readable: readDecision.readable };
    } finally {
      client.release();
    }
  });
}

/** The native participation eligibility shared by checks and parent validation. */
export function realmParticipationAnchor(resource: Resource) {
  let visibility: 'public' | 'protected' | null = null;
  const eligibility = createResourcePublicEligibility({
    resource,
    action: 'realm:participate',
    async prepare() {
      return { route: resource.route, id: resource.id };
    },
    async verify({ client, at }) {
      const row = await read.run(client, { route: resource.route, id: resource.id, at });
      visibility = row?.visibility === 'public' || row?.visibility === 'protected' ? row.visibility : null;
      return visibility === 'public';
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
  clock?: () => Date;
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

    const readEligibility = createResourcePublicEligibility({
      resource,
      action: 'realm:read',
      async prepare() {
        return visibility === 'protected' ? true : undefined;
      },
      async verify() {
        return false;
      },
    });
    const readCheck = await accessCheck(
      input.access,
      actor,
      'realm:read',
      { ...resource, eligibility: readEligibility },
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
