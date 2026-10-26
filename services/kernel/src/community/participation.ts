import type { Pool } from 'pg';
import { createResourcePublicEligibility } from '../access/index.ts';
import { grantGroupRole } from '../access/resource-group-grant.ts';
import { requireResourceCommand, ResourceAccessWriteDeniedError } from '../access/resource-denials.ts';
import { commandTime, mintReadTime, type AuthoritativeTime, type CommandTransaction } from '../command/command.ts';
import { accessCheck, type Access, type AccessClient, type Actor, type Resource } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import read from './realm-read.sql';

export type RealmParticipationCheck = (
  client: AccessClient,
  input: Readonly<{ realmId: string; actor: Actor }>,
  time?: AuthoritativeTime,
) => Promise<boolean>;

const readabilityByTime = new WeakMap<AuthoritativeTime, Map<string, boolean>>();

function rememberReadability(time: AuthoritativeTime | undefined, realmId: string, readable: boolean): void {
  if (!time) return;
  let realms = readabilityByTime.get(time);
  if (!realms) {
    realms = new Map();
    readabilityByTime.set(time, realms);
  }
  realms.set(realmId, readable);
}

/** Returns the protected Realm read decision observed by a command at its T. */
export function realmParticipationReadableAt(time: AuthoritativeTime, realmId: string): boolean | undefined {
  return readabilityByTime.get(time)?.get(realmId);
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
  return async (client, { realmId, actor }, time) => {
    const route = routeOf(realmId);
    if (route === null) return false;
    const resource: Resource = { route, id: realmId };
    const context = { pool: input.pool, deadline: Date.now() + 1500 };
    let visibility: 'public' | 'protected' | null = null;
    const eligibility = createResourcePublicEligibility({
      resource,
      action: 'realm:participate',
      async prepare() {
        return { route, id: realmId };
      },
      async verify({ client: checked, at }) {
        const row = await read.run(checked, { route, id: realmId, at });
        visibility = row?.visibility === 'public' || row?.visibility === 'protected' ? row.visibility : null;
        return visibility === 'public';
      },
    });
    const participationCheck = await accessCheck(
      input.access,
      actor,
      'realm:participate',
      { ...resource, eligibility },
      context,
    );
    const checkedTime = time ?? commandTime(client) ?? (await mintReadTime(client, input.clock));
    const participates = await participationCheck(client, checkedTime);
    if (visibility === 'public') {
      rememberReadability(time, realmId, true);
      return participates;
    }
    if (visibility !== 'protected') {
      rememberReadability(time, realmId, false);
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
    rememberReadability(time, realmId, readable);
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
