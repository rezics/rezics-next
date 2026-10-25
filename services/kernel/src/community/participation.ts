import type { Pool } from 'pg';
import { createResourcePublicEligibility } from '../access/index.ts';
import { grantGroupRole } from '../access/resource-group-grant.ts';
import { requireResourceCommand, ResourceAccessWriteDeniedError } from '../access/resource-denials.ts';
import { commandTime, type AuthoritativeTime, type CommandTransaction } from '../command/command.ts';
import { accessCheck, type Access, type AccessClient, type Actor, type Resource } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import read from './realm-read.sql';

export type RealmParticipationCheck = (
  client: AccessClient,
  input: Readonly<{ realmId: string; actor: Actor }>,
  time?: AuthoritativeTime,
) => Promise<boolean>;

function atTimeClient(client: AccessClient, at: string): AccessClient {
  const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
  const bounded = Object.create(client) as AccessClient;
  bounded.query = ((...args: unknown[]) => {
    const first = args[0];
    const statement =
      typeof first === 'string'
        ? first
        : typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string'
          ? first.text
          : '';
    if (statement.replace(/\s+/g, ' ').trim().replace(/;$/, '') === 'SELECT clock_timestamp()::text AS at')
      return Promise.resolve({ rows: [{ at }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] });
    return query(...args);
  }) as AccessClient['query'];
  return bounded;
}

/** Checks participation and the independent Realm read anchor at one T.
 * The participation action uses its exact denial check. A protected Realm also
 * requires realm:read, while the single Realm head read supplies public eligibility.
 */
export function createRealmParticipationCheck(input: { pool: Pool; access: Access }): RealmParticipationCheck {
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
    const commandAttemptTime = time ?? commandTime(client);
    let checkedClient = client;
    let checkedTime = commandAttemptTime;
    if (!checkedTime) {
      const observed = await client.query('SELECT clock_timestamp()::text AS at');
      const at = (observed as { rows?: readonly { at?: unknown }[] }).rows?.[0]?.at;
      if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return false;
      checkedClient = atTimeClient(client, at);
    }
    if (!(await participationCheck(checkedClient, checkedTime))) return false;
    if (visibility === 'public') return true;
    if (visibility !== 'protected') return false;

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
    return readCheck(checkedClient, checkedTime);
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
