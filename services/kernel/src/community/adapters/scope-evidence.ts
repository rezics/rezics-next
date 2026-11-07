import type { Pool } from 'pg';
import type { Access, Actor, AccessClient, AccessCheck } from '../../request/access.ts';
import { accessCheck } from '../../request/access.ts';
import type { AccessWorkAccounting } from '../../access/work.ts';
import { routeOf } from '../../route/route.ts';
import type { ScopeEvidenceHost, ScopeEvidenceObservation } from '../contract/index.ts';
type Dependencies = Readonly<{ pool: Pool; access: Access }>;
type Context = Readonly<{ actor: Actor; deadline: number; work: AccessWorkAccounting }>;
import { realmReadEligibility } from '../realm.ts';
import { spaceReadEligibility } from '../space.ts';
import { realmReadBanAccounts } from '../eligibility-access-work.ts';
import bindingRead from '../container-lifecycle-binding.sql';
import bansRead from '../read-ban-current.sql';
type Binding = NonNullable<(typeof bindingRead)['~reylo']['element']>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function route(id: string): number {
  const value = typeof id === 'string' && uuid.test(id) ? routeOf(id) : null;
  if (value === null) throw new TypeError('Invalid Realm Subject candidate identity');
  return value;
}

async function prepareAccess(
  dependencies: Dependencies,
  context: Context,
  id: string,
  action: 'realm:read' | 'space:read',
): Promise<AccessCheck> {
  const identity = { id, route: route(id) };
  const eligibility = action === 'realm:read' ? realmReadEligibility(identity) : spaceReadEligibility(identity);
  if (!dependencies.access.prepare) context.work.unavailable('Content Realm Subject native Access preparation');
  const check = await accessCheck(
    dependencies.access,
    context.actor,
    action,
    { ...identity, eligibility },
    {
      pool: dependencies.pool,
      deadline: context.deadline,
      work: context.work,
    },
  );
  if (!check.work) context.work.unavailable(`Content Realm Subject ${action} native work producer`);
  return check;
}

/** Original read plans; the caller lends its existing accounting snapshot. */
export function createRealmScopeEvidence<A>(host: ScopeEvidenceHost<Dependencies, Context, AccessClient, A>) {
  return { observe: observeParent };
  async function observeParent(
    dependencies: Dependencies,
    realmId: string,
    context: Context,
  ): Promise<ScopeEvidenceObservation<A> | null> {
    const realm = await prepareAccess(dependencies, context, realmId, 'realm:read');
    const parameters = { route: route(realmId), id: realmId, at: 'infinity', subject: null };
    const initial = await host.snapshot(dependencies, realmId, context, (client) =>
      host.point(client, 'parent.binding', bindingRead, parameters, 3),
    );
    if (!initial.value) return null;
    const parent: Binding = initial.value;
    const space = await prepareAccess(dependencies, context, parent.space_id, 'space:read');
    const accounts = context.actor.kind === 'account' ? realmReadBanAccounts(context.actor) : [];
    const checked = await host.snapshot(dependencies, realmId, context, async (client) => {
      const current = await host.point(client, 'parent.binding', bindingRead, parameters, 3);
      if (!current || host.hash(current) !== host.hash(parent) || !(await realm(client))) return false;
      if (accounts.length) {
        // The clock observation belongs to this native snapshot; no caller time can
        // move a ban interval. Access independently mints its ordinary live T.
        const at = await host.time(client);
        if (
          await host.point(
            client,
            'parent.ban',
            bansRead,
            {
              route: route(realmId),
              realm_id: realmId,
              account_ids: accounts,
              at,
            },
            accounts.length,
          )
        )
          return false;
      }
      return true;
    });
    if (!checked.value) return null;
    // Release the Realm home before the Space read, even when co-located.
    const spaceChecked = await host.snapshot(dependencies, parent.space_id, context, (client) => space(client));
    if (!spaceChecked.value) return null;
    return { signature: host.hash(parent), anchors: [initial.anchor, checked.anchor, spaceChecked.anchor] };
  }
}
