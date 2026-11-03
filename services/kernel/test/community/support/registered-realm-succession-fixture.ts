import { expect } from 'bun:test';
import type { Account } from '../../../../../specs/community-driver.ts';
import { PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { accountDeletionRuntime, deletePersona } from '../../support/account-deletion.ts';
import { contentGovernanceCredential } from '../../content/support/system.ts';
import {
  closeCommunityDrivers,
  communityFixtureRuntime,
  createCommunityDriver,
  restartWorker,
  worker,
} from '../community-driver.ts';

export async function createRegisteredSuccessionFixture() {
  const driver = await createCommunityDriver();
  await driver.provision();
  const { system } = communityFixtureRuntime();
  const pool = system.database.pool;
  const deletion = accountDeletionRuntime(system);
  const credential = await contentGovernanceCredential(system);
  const governance = { id: credential.actor.accountId, bearer: credential.bearer };

  async function call<T>(actor: Account, path: string, body: unknown, statuses = [201]) {
    const response = await driver.request({
      actor, method: 'POST', path, key: JSON.stringify(crypto.randomUUID()), body,
    });
    const value: unknown = await response.json();
    expect(statuses, JSON.stringify(value)).toContain(response.status);
    return value as T;
  }
  async function person() {
    const registered = await deletion.person();
    return { registered, account: { id: registered.accountId, bearer: registered.bearer } };
  }
  async function realm() {
    const owner = await person();
    await call(governance, '/v1/grants', {
      resource: PLATFORM_RESOURCE, subject: { kind: 'account', id: owner.account.id },
      actions: ['space:create', 'realm:create'], valid: '(,)',
    });
    const { space } = await call<{ space: { spaceId: string } }>(owner.account, '/v1/spaces', {
      title: 'Registered succession host',
    });
    const { realm } = await call<{ realm: { realmId: string } }>(owner.account, '/v1/realms', {
      spaceId: space.spaceId, contextId: GLOBAL_CONTEXT, title: 'Registered succession', visibility: 'public',
    });
    await driver.settle();
    return { owner, id: realm.realmId, route: routeOf(realm.realmId)! };
  }
  type Realm = Awaited<ReturnType<typeof realm>>;
  async function state(selected: Realm, accountId = selected.owner.account.id) {
    const key = [selected.route, selected.id, accountId];
    const continuity = (await pool.query(
      `SELECT ownership_state,orphaned_at::text,claim_eligible_at::text,
         claim_eligible_at=orphaned_at+interval '720 hours' AS exact_deadline
       FROM community.realm WHERE route=$1 AND realm_id=$2`, key.slice(0, 2),
    )).rows[0];
    const decisions = (await pool.query(
      `SELECT source_at::text,decision_state,decision_operation_id::text,decided_at::text,
         result_orphaned_at::text,result_claim_eligible_at::text
       FROM access.realm_erasure_succession WHERE route=$1 AND resource_id=$2 AND account_id=$3`, key,
    )).rows;
    const owners = (await pool.query(
      `SELECT subject_id::text FROM access.resource_role_grant
       WHERE route=$1 AND resource_id=$2 AND grant_role='community.realm.owner'
         AND subject_kind='identity' AND valid @> clock_timestamp() ORDER BY subject_id`, key.slice(0, 2),
    )).rows;
    const locators = (await pool.query(
      'SELECT realm_id FROM community.member_locator WHERE route=$1 AND account_id=$2 AND realm_id=$3',
      [routeOf(accountId), accountId, selected.id],
    )).rows;
    return { continuity, decisions, owners, locators };
  }
  // Faults affect only this private database and selected Community row. They never assign native state.
  async function fault(selected: Realm, target: 'continuity' | 'unlink') {
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const name = `succession_fault_${suffix}`;
    const table = target === 'continuity' ? 'community.realm' : 'community.member_locator';
    const condition = target === 'continuity'
      ? `NEW.realm_id='${selected.id}'::uuid AND NEW.ownership_state IS DISTINCT FROM OLD.ownership_state`
      : `OLD.realm_id='${selected.id}'::uuid AND OLD.account_id='${selected.owner.account.id}'::uuid`;
    await pool.query(`CREATE FUNCTION community.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${condition} THEN RAISE EXCEPTION 'registered succession fault'; END IF;
      RETURN ${target === 'continuity' ? 'NEW' : 'OLD'}; END $$`);
    await pool.query(`CREATE TRIGGER ${name} BEFORE ${target === 'continuity' ? 'UPDATE' : 'DELETE'}
      ON ${table} FOR EACH ROW EXECUTE FUNCTION community.${name}()`);
    return async () => {
      await pool.query(`DROP TRIGGER ${name} ON ${table}`);
      await pool.query(`DROP FUNCTION community.${name}()`);
    };
  }
  async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const value = await read();
      if (ready(value)) return value;
      if (Date.now() >= deadline) throw new Error(`Registered succession did not reach expected state: ${JSON.stringify(value)}`);
      await Bun.sleep(20);
    }
  }
  return {
    pool, driver, realm, person, state, fault, until, worker, restartWorker,
    async erase(person: Awaited<ReturnType<typeof person>>) {
      return deletePersona({ pool, auth: deletion.auth }, person.registered);
    },
    async member(selected: Realm, account: Account) {
      await call(selected.owner.account, `/v1/realms/${selected.id}/members`, { accountId: account.id }, [202, 204]);
      await driver.settle();
    },
    async moderator(selected: Realm, account: Account) {
      await call(selected.owner.account, '/v1/roleGrants', {
        resource: { route: selected.route, id: selected.id }, subject: { kind: 'account', id: account.id },
        role: 'community.realm.moderator', valid: '(,)',
      });
      await driver.settle();
    },
    async suspend(account: Account, suspended: boolean) {
      await call(governance, `/v1/accounts/${account.id}:${suspended ? 'suspend' : 'reinstate'}`,
        { reason: 'Registered succession pending control' }, [200, 201]);
      await driver.settle();
    },
    close: closeCommunityDrivers,
  };
}
export type RegisteredSuccessionFixture = Awaited<ReturnType<typeof createRegisteredSuccessionFixture>>;
