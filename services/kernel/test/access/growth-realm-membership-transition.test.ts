import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import type { TransitionGrowthConfig } from './realm-membership-transition-growth.ts';
import { createOperatorCommands } from '../../src/access/operator.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createRealmMembership } from '../../src/community/membership.ts';
import { createMembershipInverseCommands } from '../../src/access/membership-inverse.ts';
import { createMembershipWorkPorts } from '../../src/access/membership-work.ts';
import {
  createRealmMembershipTransitions,
  type RealmMembershipTransition,
} from '../../src/access/realm-membership-transition.ts';
import { createRealmMembershipReconciler } from '../../src/access/realm-membership-transition-legacy.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import {
  createCommunityDriver,
  communityFixtureRuntime,
  closeCommunityDrivers,
  worker,
  restartWorker,
  waitCommunityWorkflow,
  reconcileCommunityMembership,
} from '../community/community-driver.ts';
import { startConsentServer } from '../community/membership-fixture.ts';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';

let controls: Pool | undefined;
const pending = new Set<string>();
afterAll(async () => {
  await controls?.end();
  await closeCommunityDrivers();
});
async function settleNative() {
  for (const id of pending) {
    try {
      await waitCommunityWorkflow(id);
    } finally {
      pending.delete(id);
    }
  }
}
function control(state: Native) {
  return (controls ??= new Pool({ connectionString: state.system.database.pool.options.connectionString, max: 4 }));
}
const key = () => crypto.randomUUID();
async function body<T>(response: Response, status: number): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  const value = await response.json();
  if (value && typeof value.workflowId === 'string') pending.add(value.workflowId);
  return value as T;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= end) throw new Error(`Native transition barrier timed out: ${label}`);
    await Bun.sleep(10);
  }
}
async function setup() {
  const driver = await createCommunityDriver();
  const fixture = await driver.provision();
  const { system } = communityFixtureRuntime();
  const deletion = accountDeletionRuntime(system);
  const persona = await deletion.person();
  const actor = { id: persona.accountId, bearer: persona.bearer };
  const { space } = await body<{ space: { spaceId: string } }>(
    await driver.request({
      actor: fixture.owner,
      method: 'POST',
      path: '/v1/spaces',
      key: JSON.stringify(key()),
      body: { title: 'Transition host' },
    }),
    201,
  );
  const { realm } = await body<{ realm: { realmId: string } }>(
    await driver.request({
      actor: fixture.owner,
      method: 'POST',
      path: '/v1/realms',
      key: JSON.stringify(key()),
      body: { spaceId: space.spaceId, title: 'Transition Realm', visibility: 'public', contextId: fixture.contextId },
    }),
    201,
  );
  const input = {
    kind: 'membership' as const,
    principal: { kind: 'realm' as const, id: realm.realmId },
    memberAccountId: persona.accountId,
    role: 'member' as const,
    authorization: persona.bearer,
  };
  const membership = createRealmMembership({
    clock: () => new Date(),
        deadlineNow: () => Date.now(),
        pool: publisherPool,
        access: state.system.access,
        referenceKeys: state.system.tokenKeys,
      });
      const publishing = publisher
        .authorize(state.persona.bearer, state.input)
        .then((request) => publisher.publish(request, state.input, held, key()))
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      await until(
        async () =>
          (
            await control(state).query('SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type=$2', [
              publisherPid,
              'Lock',
            ])
          ).rows,
        (rows) => rows.length === 1,
        'actual positive command queued before cancellation commits',
      );
      await original.release();
      expect('value' in (await cancelling)).toBe(true);
      expect('value' in (await parkedLock)).toBe(true);
      expect((await blocked(state, parkPid)).some((row) => row.pid === publisherPid)).toBe(true);
      await state.ports.finalize!(held, key());
      expect(
        (
          await state.system.database.pool.query(
            'SELECT 1 FROM access.membership_inverse WHERE route=$1 AND account_id=$2 AND reservation_id=$3',
            [routeOf(held.accountId), held.accountId, held.reservationId],
          )
        ).rows,
      ).toHaveLength(1);
      await state.erase();
      expect(await readErasureStatus(state.system.database.pool, held.accountId)).not.toBeNull();
      await parked.query('ROLLBACK');
      expect('error' in (await publishing)).toBe(true);
      expect(await state.rows()).toEqual([]);
      expect(await state.hold()).toEqual([]);
    } finally {
      await original.release();
      await parked.query('ROLLBACK');
      parked.release();
      await publisherPool.end();
    }
  },
  120_000,
);

test.serial(
  'cancelling a later confirmation closes only that generation while the live membership and inverse survive',
  async () => {
    const state = await setup();
    await state.join();
    await settleNative();
    const held = await state.reserve();
    await state.ports.cancel!(held, key());
    expect((await state.transitions.proof(held))?.outcome).toBe('cancelled');
    expect(await state.hold()).toHaveLength(1);
    await state.ports.finalize!(held, key());
    expect(await state.hold()).toEqual([]);
    expect(await state.rows()).toHaveLength(1);
    expect(await state.membership.authority.readTerminal(state.system.database.pool, held)).toBeNull();
    await expect(state.ports.terminalize(held, key())).rejects.toThrow();
    expect(
      (
        await state.system.database.pool.query(
          'SELECT 1 FROM access.membership_inverse WHERE route=$1 AND account_id=$2 AND reservation_id=$3',
          [routeOf(held.accountId), held.accountId, held.reservationId],
        )
      ).rows,
    ).toHaveLength(1);
    await state.erase();
    expect(await state.rows()).toHaveLength(1);
  },
  120_000,
);

test.serial(
  'closing a Realm transition never releases an unrelated native operator responsibility',
  async () => {
    const state = await setup();
    await state.join();
    await settleNative();
    const subject = await state.deletion.person();
    const operators = createOperatorCommands({
      pool: state.system.database.pool,
      access: state.system.access,
      actions: LIFECYCLE_ACTIONS,
      managementAction: 'account:manage',
    });
    const input = { operatorAccountId: state.persona.accountId, subjectAccountId: subject.accountId, key: key() };
    const held = await operators.reserveResponsibility(input);
    expect(await operators.reserveResponsibility(input)).toMatchObject({ replayed: true });
    await expect(state.erase()).rejects.toThrow();
    expect(await readErasureStatus(state.system.database.pool, state.persona.accountId)).toBeNull();
    const responsibility = { ...held.value, key: key() };
    await expect(operators.releaseResponsibility(responsibility)).rejects.toThrow();
    await operators.retireResponsibility({ ...responsibility, key: key() });
    await operators.releaseResponsibility({ ...responsibility, key: key() });
    await state.erase();
    expect(await state.rows()).toHaveLength(1);
  },
  120_000,
);

/** Historical fixture only: represent an old writer's stable hold using the
 * actual native inverse provenance and real published intervals. No account,
 * tombstone, grant, obligation or acknowledgement is fabricated. */
async function oldStableHold(state: Native, realmId: string, accountId = state.persona.accountId) {
  await state.system.database.pool.query(
    `INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id)
     SELECT route,account_id,reservation_id,group_id,'membership',transaction_id FROM access.membership_inverse
     WHERE route=$1 AND account_id=$2 AND kind='realm' AND group_id=$3`,
    [routeOf(accountId), accountId, realmId],
  );
}

test.serial(
  'legacy reconciliation persists mixed outcomes, resumes a non-null opaque keyset cursor and redrives every unresolved hold',
  async () => {
    const state = await setup();
    const realms = [state.realm.realmId];
    for (let n = 1; n < 34; n++) {
      const { space } = await body<{ space: { spaceId: string } }>(
        await state.driver.request({
          actor: state.fixture.owner,
          method: 'POST',
          path: '/v1/spaces',
          key: JSON.stringify(key()),
          body: { title: `Legacy host ${n}` },
        }),
        201,
      );
      const { realm } = await body<{ realm: { realmId: string } }>(
        await state.driver.request({
          actor: state.fixture.owner,
          method: 'POST',
          path: '/v1/realms',
          key: JSON.stringify(key()),
          body: {
            spaceId: space.spaceId,
            title: `Legacy membership ${n}`,
            visibility: 'public',
            contextId: state.fixture.contextId,
          },
        }),
        201,
      );
      realms.push(realm.realmId);
    }
    for (const realmId of realms)
      await body(
        await state.driver.request({
          actor: state.actor,
          method: 'POST',
          path: `/v1/realms/${realmId}/membership`,
          key: JSON.stringify(key()),
        }),
        202,
      );
    await settleNative();
    for (const realmId of realms) await oldStableHold(state, realmId);
    const other = await state.deletion.person();
    await body(
      await state.driver.request({
        actor: { id: other.accountId, bearer: other.bearer },
        method: 'POST',
        path: `/v1/realms/${realms[0]!}/membership`,
        key: JSON.stringify(key()),
      }),
      202,
    );
    await settleNative();
    await oldStableHold(state, realms[0]!, other.accountId);
    // A real old source absent from the authority is pending, never cancellation.
    const pendingRealm = newId(routeOf(state.realm.realmId)!);
    const pendingReservation = newId(routeOf(state.persona.accountId)!);
    const pendingTransaction = newId(routeOf(state.persona.accountId)!);
    await state.system.database.pool.query(
      `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
     VALUES ($1,$2,'realm',$3,$4,$5)`,
      [routeOf(state.persona.accountId), state.persona.accountId, pendingRealm, pendingReservation, pendingTransaction],
    );
    await oldStableHold(state, pendingRealm);
    // Source disagreement is a separate uncertain historical case. Neither source
    // fact alone may certify it; this row has no committed native terminal receipt.
    const ambiguousRealm = realms[0]!;
    const stable = (
      await state.system.database.pool.query<{ reservation_id: string }>(
        `SELECT reservation_id::text FROM access.membership_inverse
     WHERE route=$1 AND account_id=$2 AND kind='realm' AND group_id=$3`,
        [routeOf(state.persona.accountId), state.persona.accountId, ambiguousRealm],
      )
    ).rows[0]!;
    await state.system.database.pool.query(
      `INSERT INTO community.realm_member_terminal(route,realm_id,account_id,reservation_id,transaction_id,at)
     VALUES($1,$2,$3,$4,$5,now())`,
      [routeOf(ambiguousRealm), ambiguousRealm, state.persona.accountId, stable.reservation_id, newId(0x3170)],
    );
    await worker.stop();
    const previousBarrier = process.env.KERNEL_REALM_MEMBERSHIP_BARRIER;
    process.env.KERNEL_REALM_MEMBERSHIP_BARRIER = 'stopped-native-writers';
    try {
      await restartWorker();
      const config = {
        pool: state.system.database.pool,
        keys: state.system.tokenKeys,
        barrierId: 'stopped-native-writers',
        authority: state.membership.authority,
        certify: state.membership.certifyLegacy,
      };
      let reconciler = createRealmMembershipReconciler(config);
      const firstPage = await reconcileCommunityMembership({ accountId: state.persona.accountId });
      expect(firstPage.items).toHaveLength(32);
      expect(firstPage.completed).toBe(false);
      expect(firstPage.cursor).toBeString();
      const cursor = firstPage.cursor!;
      const changed = Math.floor(cursor.length / 2);
      const forged = cursor.slice(0, changed) + (cursor[changed] === 'a' ? 'b' : 'a') + cursor.slice(changed + 1);
      await expect(reconciler.page({ accountId: state.persona.accountId, cursor: forged })).rejects.toThrow();
      await expect(reconciler.page({ accountId: other.accountId, cursor })).rejects.toThrow();
      const otherPage = await reconcileCommunityMembership({ accountId: other.accountId });
      expect(otherPage.completed).toBe(true);
      expect(otherPage.items).toHaveLength(1);
      expect(otherPage.items[0]!.state).toBe('published');
      // Recreate the coordinator. Progress is native storage, not a process Map.
      reconciler = createRealmMembershipReconciler(config);
      const lastPage = await reconciler.page({ accountId: state.persona.accountId, cursor: firstPage.cursor });
      expect(lastPage.completed).toBe(true);
      const items = [...firstPage.items, ...lastPage.items];
      expect(new Set(items.map((item) => item.reservationId)).size).toBe(35);
      expect(items.filter((item) => item.state === 'published')).toHaveLength(33);
      expect(items.find((item) => item.realmId === pendingRealm)?.state).toBe('pending');
      expect(items.find((item) => item.realmId === ambiguousRealm)?.state).toBe('uncertain');
      const redriven = await reconciler.page({ accountId: state.persona.accountId, redrive: true });
      expect(redriven.items.map((item) => item.state).sort()).toEqual(['pending', 'uncertain']);
      expect(
        (
          await state.system.database.pool.query(
            `SELECT reservation_id FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND purpose='membership'`,
            [routeOf(state.persona.accountId), state.persona.accountId],
          )
        ).rows,
      ).toHaveLength(2);
      await expect(state.erase()).rejects.toThrow();
      expect(await readErasureStatus(state.system.database.pool, state.persona.accountId)).toBeNull();
      await deletePersona({ pool: state.system.database.pool, auth: state.deletion.auth }, other);
      expect(await readErasureStatus(state.system.database.pool, other.accountId)).not.toBeNull();

      // Historical over-cap data must refuse even when no hold joins the selected
      // page. No truncated admission may become a completed progress receipt.
      const overflow = await state.deletion.person();
      const overflowRoute = routeOf(overflow.accountId)!;
      const historical = Array.from({ length: 1001 }, () => newId(overflowRoute));
      await state.system.database.pool.query(
        `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
         SELECT $1,$2,'realm',id,id,id FROM unnest($3::uuid[]) id`,
        [overflowRoute, overflow.accountId, historical],
      );
      await expect(reconciler.page({ accountId: overflow.accountId })).rejects.toThrow();
      expect(
        (
          await state.system.database.pool.query(
            'SELECT 1 FROM access.realm_membership_reconciliation WHERE route=$1 AND account_id=$2',
            [overflowRoute, overflow.accountId],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await worker.stop();
      if (previousBarrier === undefined) delete process.env.KERNEL_REALM_MEMBERSHIP_BARRIER;
      else process.env.KERNEL_REALM_MEMBERSHIP_BARRIER = previousBarrier;
      await restartWorker();
    }
  },
  240_000,
);

test.serial(
  'native transition and selected legacy output stay bounded at 64/512/4096 same-home holds, proofs, receipts and generations',
  async () => {
    const state = await setup();
    const legacy = await state.deletion.person();
    const legacyRoute = routeOf(legacy.accountId)!;
    const reservation = newId(legacyRoute);
    const transaction = newId(legacyRoute);
    await state.system.database.pool.query(
      `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
     VALUES($1,$2,'realm',$3,$4,$5)`,
      [legacyRoute, legacy.accountId, state.realm.realmId, reservation, transaction],
    );
    await state.system.database.pool.query(
      `INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id)
     VALUES($1,$2,$3,$4,'membership',$5)`,
      [legacyRoute, legacy.accountId, reservation, state.realm.realmId, transaction],
    );
    const consentReader = createCurrentConsentReader({ database: state.system.database.authPool });
    const consent = await startConsentServer(
      async (input) => (await consentReader.readCurrentConsent(input))?.scopes ?? null,
    );
    await worker.stop();
    try {
      const claims = JSON.parse(Buffer.from(state.persona.bearer.split('.')[1]!, 'base64url').toString()) as {
        iss: string;
        aud: string;
      };
      const response = await state.deletion.auth.host.handler(new Request(`${claims.iss}/.well-known/jwks.json`));
      expect(response.status).toBe(200);
      const child = Bun.spawn(['bun', 'test/access/realm-membership-transition-growth.ts'], {
        cwd: new URL('../..', import.meta.url).pathname,
        env: { ...process.env, ...consent.env },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      child.stdin.write(
        JSON.stringify({
          databaseUrl: state.system.database.pool.options.connectionString!,
          accountId: state.persona.accountId,
          bearer: state.persona.bearer,
          realmId: state.realm.realmId,
          legacyAccountId: legacy.accountId,
          issuer: claims.iss,
          audience: claims.aud,
          jwks: (await response.json()) as TransitionGrowthConfig['jwks'],
          routeKey: Buffer.from(state.system.routeKey).toString('base64url'),
          keys: [...state.system.tokenKeys.keys].map(([id, value]): [number, string] => [
            id,
            Buffer.from(value).toString('base64url'),
          ]),
        } satisfies TransitionGrowthConfig),
      );
      child.stdin.end();
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stdout + '\n' + stderr).toBe(0);
      const line = stdout.split('\n').find((line) => line.startsWith('TRANSITION_GROWTH '));
      expect(line, stdout).toBeDefined();
      const samples = JSON.parse(line!.slice('TRANSITION_GROWTH '.length)) as { scale: number; cost: unknown }[];
      expect(samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
      console.log(line);
    } finally {
      await consent.close();
      await restartWorker();
    }
  },
  600_000,
);
