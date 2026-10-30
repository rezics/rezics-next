import { afterAll, expect, test } from 'bun:test';
import { createRealmMembership } from '../../src/community/membership.ts';
import { createMembershipInverseCommands } from '../../src/access/membership-inverse.ts';
import { createMembershipWorkPorts } from '../../src/access/membership-work.ts';
import { createRealmMembershipTransitions, type RealmMembershipTransition } from '../../src/access/realm-membership-transition.ts';
import { createRealmMembershipReconciler } from '../../src/access/realm-membership-transition-legacy.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import { createCommunityDriver, communityFixtureRuntime, closeCommunityDrivers, worker, restartWorker } from '../community/community-driver.ts';
import { startConsentServer } from '../community/membership-fixture.ts';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';

afterAll(closeCommunityDrivers);
const key = () => crypto.randomUUID();
async function body<T>(response: Response, status: number): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
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
  const { space } = await body<{ space: { spaceId: string } }>(await driver.request({
    actor: fixture.owner, method: 'POST', path: '/v1/spaces', key: JSON.stringify(key()),
    body: { title: 'Transition host' },
  }), 201);
  const { realm } = await body<{ realm: { realmId: string } }>(await driver.request({
    actor: fixture.owner, method: 'POST', path: '/v1/realms', key: JSON.stringify(key()),
    body: { spaceId: space.spaceId, title: 'Transition Realm', visibility: 'public', contextId: fixture.contextId },
  }), 201);
  const input = { kind: 'membership' as const, principal: { kind: 'realm' as const, id: realm.realmId },
    memberAccountId: persona.accountId, role: 'member' as const, authorization: persona.bearer };
  const membership = createRealmMembership({ pool: system.database.pool, access: system.access, referenceKeys: system.tokenKeys });
  const inverse = createMembershipInverseCommands({ pool: system.database.pool, realmAuthority: membership.authority });
  const transitions = createRealmMembershipTransitions({ pool: system.database.pool, authority: membership.authority });
  const ports = createMembershipWorkPorts({ pool: system.database.pool,
    env: { KERNEL_ROUTE_KEY: Buffer.from(system.routeKey).toString('base64url') } }, { realm: membership });
  const hold = async () => (await system.database.pool.query<{ reservationId: string }>(
    `SELECT reservation_id::text AS "reservationId" FROM access.lifecycle_coordination
     WHERE route=$1 AND account_id=$2 AND related_account_id=$3 AND purpose='membership'`,
    [routeOf(persona.accountId), persona.accountId, realm.realmId])).rows;
  const rows = async () => (await system.database.pool.query(
    'SELECT reservation_id::text FROM community.realm_member WHERE route=$1 AND realm_id=$2 AND account_id=$3',
    [routeOf(realm.realmId), realm.realmId, persona.accountId])).rows;
  const erase = () => deletePersona({ pool: system.database.pool, auth: deletion.auth }, persona);
  const join = async () => body<{ workflowId: string }>(await driver.request({ actor, method: 'POST',
    path: `/v1/realms/${realm.realmId}/membership`, key: JSON.stringify(key()) }), 202);
  const reserve = async () => (await inverse.reserve({ accountId: persona.accountId, principal: input.principal, key: key() })).value as RealmMembershipTransition;
  const publish = async (held: RealmMembershipTransition, commandKey = key()) =>
    membership.publish(await membership.authorize(persona.bearer, input), input, held, commandKey);
  return { driver, fixture, system, deletion, persona, actor, realm, space, input, membership, inverse, transitions, ports,
    hold, rows, erase, join, reserve, publish };
}
type Native = Awaited<ReturnType<typeof setup>>;
async function lock(state: Native, owner: 'realm' | 'account') {
  const client = await state.system.database.admin.connect();
  await client.query('BEGIN');
  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  if (owner === 'realm') await client.query('SELECT 1 FROM community.realm WHERE route=$1 AND realm_id=$2 FOR UPDATE',
    [routeOf(state.realm.realmId), state.realm.realmId]);
  else await client.query('SELECT 1 FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE',
    [routeOf(state.persona.accountId), state.persona.accountId]);
  let done = false;
  return { pid, client, async release() { if (!done) { done = true; await client.query('ROLLBACK'); client.release(); } } };
}
async function blocked(state: Native, pid: number) {
  return until(async () => (await state.system.database.admin.query(
    'SELECT pid,query FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows,
    rows => rows.length > 0, 'a native transaction waiting on the owner row');
}
async function storedTransition(state: Native): Promise<RealmMembershipTransition> {
  const rows = await state.system.database.pool.query<{ reservationId: string; generationId: string; operationId: string }>(
    `SELECT reservation_id::text AS "reservationId",generation_id::text AS "generationId",operation_id AS "operationId"
     FROM access.realm_membership_transition WHERE route=$1 AND account_id=$2 AND realm_id=$3 AND proof_transaction_id IS NULL`,
    [routeOf(state.persona.accountId), state.persona.accountId, state.realm.realmId]);
  expect(rows.rows).toHaveLength(1);
  const row = rows.rows[0]!;
  return { accountId: state.persona.accountId, principal: state.input.principal, reservationId: row.reservationId,
    transition: { generationId: row.generationId, operationId: row.operationId } };
}

test.serial('native publication versus deletion: in-flight hold rejects deletion before T, then exact committed proof permits it', async () => {
  const state = await setup();
  const barrier = await lock(state, 'realm');
  try {
    await state.join();
    await blocked(state, barrier.pid);
    expect(await state.hold()).toHaveLength(1);
    await expect(state.erase()).rejects.toThrow();
    expect(await readErasureStatus(state.system.database.pool, state.persona.accountId)).toBeNull();
    expect(await state.rows()).toEqual([]);
  } finally { await barrier.release(); }
  await state.driver.settle();
  expect(await state.hold()).toEqual([]);
  expect(await state.rows()).toHaveLength(1);
  await state.erase();
  expect(await state.rows()).toHaveLength(1);
}, 120_000);

test.serial('native reserve versus deletion: a deletion holding the account row cannot be followed by positive reservation/publication', async () => {
  const state = await setup();
  const barrier = await lock(state, 'account');
  const erased = state.erase();
  // Attach rejection immediately so a failed assertion cannot leave a rejected promise unhandled.
  const deletion = erased.then(value => ({ value }), error => ({ error }));
  try {
    await blocked(state, barrier.pid);
    await state.join();
  } finally { await barrier.release(); }
  const result = await deletion;
  if ('value' in result) {
    await expect(state.driver.settle()).rejects.toThrow();
    expect(await state.hold()).toEqual([]);
    expect(await state.rows()).toEqual([]);
    expect(await readErasureStatus(state.system.database.pool, state.persona.accountId)).not.toBeNull();
  } else {
    expect(await readErasureStatus(state.system.database.pool, state.persona.accountId)).toBeNull();
    await state.driver.settle();
    await state.erase();
  }
}, 120_000);

test.serial('crash after the actual foreign commit resumes finalization on the normal worker without a lost bearer', async () => {
  const state = await setup();
  const realmBarrier = await lock(state, 'realm');
  let accountBarrier: Awaited<ReturnType<typeof lock>> | undefined;
  let stopped = false;
  try {
    await state.join();
    await blocked(state, realmBarrier.pid);
    accountBarrier = await lock(state, 'account');
    await realmBarrier.release();
    await until(state.rows, rows => rows.length === 1, 'committed Realm publication');
    await blocked(state, accountBarrier.pid);
    const held = await storedTransition(state);
    const proof = await state.transitions.proof(held);
    expect(proof?.outcome).toBe('published');
    await worker.crash(); stopped = true;
    expect(await state.hold()).toHaveLength(1);
    await accountBarrier.release();
    await restartWorker(); stopped = false;
    await state.driver.settle();
    expect(await state.hold()).toEqual([]);
    expect(await state.rows()).toHaveLength(1);
    // Mechanical consumption replays even after the real account deletion.
    await state.erase();
    expect(await state.ports.recover!(held, key())).toBe(true);
    await state.ports.finalize!(held, key());
    expect(await state.rows()).toHaveLength(1);
  } finally {
    await realmBarrier.release(); await accountBarrier?.release();
    if (stopped) await restartWorker();
  }
}, 180_000);

test.serial('exact proof binding, duplicate delivery and an old proof never spend a later transition generation', async () => {
  const state = await setup();
  const first = await state.reserve();
  await state.publish(first);
  const proof = await state.transitions.proof(first);
  expect(proof?.outcome).toBe('published');
  const consumeKey = key();
  await state.transitions.consume({ ...first, key: consumeKey, proofTransactionId: proof!.transactionId });
  const later = await state.reserve();
  expect(later.reservationId).toBe(first.reservationId);
  expect(later.transition.generationId).not.toBe(first.transition.generationId);
  await state.transitions.consume({ ...first, key: consumeKey });
  await state.transitions.consume({ ...first, key: key() });
  expect(await state.hold()).toEqual([{ reservationId: later.transition.generationId }]);
  for (const wrong of [
    { ...later, accountId: newId(routeOf(later.accountId)!) },
    { ...later, principal: { kind: 'realm' as const, id: newId(routeOf(later.principal.id)!) } },
    { ...later, reservationId: newId(routeOf(later.accountId)!) },
    { ...later, transition: { ...later.transition, operationId: key() } },
    { ...later, transition: { ...later.transition, generationId: first.transition.generationId } },
  ]) await expect(state.transitions.consume({ ...wrong, key: key() })).rejects.toThrow();
  await expect(state.transitions.consume({ ...first, key: key(), proofTransactionId: newId(0x3130) })).rejects.toThrow();
  await expect(state.publish(first)).rejects.toThrow();
  await expect(state.erase()).rejects.toThrow();
  expect(await readErasureStatus(state.system.database.pool, state.persona.accountId)).toBeNull();
  await state.publish(later);
  await state.ports.finalize!(later, key());
  expect(await state.hold()).toEqual([]);
  expect(await state.rows()).toHaveLength(1);
  await state.erase();
  await expect(state.reserve()).rejects.toThrow();
  await expect(state.publish(later)).rejects.toThrow();
  expect(await state.rows()).toHaveLength(1);
}, 120_000);

test.serial('uncertain proof reads retain the hold; cancellation wins a queued stale positive publisher and permits exact terminal release', async () => {
  const state = await setup();
  const held = await state.reserve();
  const unavailable = createRealmMembershipTransitions({ pool: state.system.database.pool,
    authority: { async readTransition() { throw new Error('source read unavailable'); } } });
  await expect(unavailable.consume({ ...held, key: key() })).rejects.toThrow('source read unavailable');
  await expect(state.transitions.consume({ ...held, key: key() })).rejects.toThrow();
  expect(await state.hold()).toHaveLength(1);
  const barrier = await lock(state, 'realm');
  // Both native source commands have passed their account preflight. Cancellation
  // queues first on the same real Realm row; the later publisher must observe it.
  const cancelling = state.membership.cancel(held, key());
  const cancelled = cancelling.then(value => ({ value }), error => ({ error }));
  await blocked(state, barrier.pid);
  const publishing = state.publish(held);
  const published = publishing.then(value => ({ value }), error => ({ error }));
  try { await blocked(state, barrier.pid); } finally { await barrier.release(); }
  expect('value' in await cancelled).toBe(true);
  expect('error' in await published).toBe(true);
  expect((await state.transitions.proof(held))?.outcome).toBe('cancelled');
  await state.ports.finalize!(held, key());
  expect(await state.hold()).toEqual([]);
  expect(await state.rows()).toEqual([]);
  expect((await state.system.database.pool.query('SELECT 1 FROM access.membership_inverse WHERE route=$1 AND account_id=$2',
    [routeOf(held.accountId), held.accountId])).rows).toEqual([]);
  await expect(state.publish(held)).rejects.toThrow();
  await state.erase();
}, 120_000);

test.serial('failed publication compensation commits exact cancellation before durable consume, while a committed publication is recovered mechanically', async () => {
  const state = await setup();
  const held = await state.reserve();
  await state.ports.cancel!(held, key());
  expect(await state.hold()).toHaveLength(1);
  await state.ports.finalize!(held, key());
  expect(await state.hold()).toEqual([]);
  const next = await state.reserve();
  expect(next.reservationId).not.toBe(held.reservationId);
  await state.publish(next);
  // A post-commit exception can only observe the committed result, never cancel it.
  await state.ports.cancel!(next, key());
  expect((await state.transitions.proof(next))?.outcome).toBe('published');
  expect(await state.ports.recover!(next, key())).toBe(true);
  expect(await state.rows()).toHaveLength(1);
  await state.ports.finalize!(next, key());
  await state.erase();
}, 120_000);

test.serial('a forged native proof row without its matching committed source receipt stays uncertain and held', async () => {
  const state = await setup();
  const held = await state.reserve();
  await state.system.database.admin.query(
    `INSERT INTO community.realm_membership_proof
     (route,realm_id,account_id,reservation_id,generation_id,operation_id,outcome,transaction_id,principal_id,command_kind,command_key,at)
     VALUES ($1,$2,$3,$4,$5,$6,'published',$7,$3,'community.realm.membership',$8,now())`,
    [routeOf(state.realm.realmId), state.realm.realmId, held.accountId, held.reservationId,
      held.transition.generationId, held.transition.operationId, newId(0x3120), key()]);
  expect(await state.transitions.proof(held)).toBeNull();
  await expect(state.ports.finalize!(held, key())).rejects.toThrow();
  await expect(state.membership.cancel(held, key())).rejects.toThrow();
  await expect(state.publish(held)).rejects.toThrow();
  await expect(state.erase()).rejects.toThrow();
  expect(await state.hold()).toHaveLength(1);
  expect(await state.rows()).toEqual([]);
  expect(await readErasureStatus(state.system.database.pool, held.accountId)).toBeNull();
}, 120_000);

test.serial('ordinary native leave and rejoin rotate the stable reservation; a stale queued join cannot recreate the retired membership', async () => {
  const state = await setup();
  await state.join(); await state.driver.settle();
  const original = (await state.system.database.pool.query<{ reservationId: string; generationId: string; operationId: string }>(
    `SELECT reservation_id::text AS "reservationId",generation_id::text AS "generationId",operation_id AS "operationId"
     FROM access.realm_membership_transition WHERE route=$1 AND account_id=$2 AND realm_id=$3`,
    [routeOf(state.persona.accountId), state.persona.accountId, state.realm.realmId])).rows[0]!;
  const held = { accountId: state.persona.accountId, principal: state.input.principal, reservationId: original.reservationId,
    transition: { generationId: original.generationId, operationId: original.operationId } };
  await body(await state.driver.request({ actor: state.actor, method: 'DELETE',
    path: `/v1/realms/${state.realm.realmId}/membership`, key: JSON.stringify(key()) }), 202);
  await state.driver.settle();
  await state.join(); await state.driver.settle();
  const current = await state.system.database.pool.query<{ reservationId: string }>(
    `SELECT reservation_id::text AS "reservationId" FROM community.realm_member
     WHERE route=$1 AND realm_id=$2 AND account_id=$3 AND upper_inf(valid)`,
    [routeOf(state.realm.realmId), state.realm.realmId, state.persona.accountId]);
  expect(current.rows[0]!.reservationId).not.toBe(original.reservationId);
  await expect(state.publish(held)).rejects.toThrow();
  await state.transitions.consume({ ...held, key: key() });
  expect(await state.hold()).toEqual([]);
  expect(await state.rows()).toHaveLength(2);
  await state.erase();
}, 120_000);

/** Historical fixture only: represent an old writer's stable hold using the
 * actual native inverse provenance and real published intervals. No account,
 * tombstone, grant, obligation or acknowledgement is fabricated. */
async function oldStableHold(state: Native, realmId: string) {
  await state.system.database.admin.query(
    `INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id)
     SELECT route,account_id,reservation_id,group_id,'membership',transaction_id FROM access.membership_inverse
     WHERE route=$1 AND account_id=$2 AND kind='realm' AND group_id=$3`,
    [routeOf(state.persona.accountId), state.persona.accountId, realmId]);
}

test.serial('legacy reconciliation persists mixed outcomes, resumes a non-null opaque keyset cursor and redrives every unresolved hold', async () => {
  const state = await setup();
  const realms = [state.realm.realmId];
  for (let n = 1; n < 34; n++) {
    const { space } = await body<{ space: { spaceId: string } }>(await state.driver.request({
      actor: state.fixture.owner, method: 'POST', path: '/v1/spaces', key: JSON.stringify(key()),
      body: { title: `Legacy host ${n}` },
    }),201);
    const { realm } = await body<{ realm: { realmId: string } }>(await state.driver.request({
      actor: state.fixture.owner, method: 'POST', path: '/v1/realms', key: JSON.stringify(key()),
      body: { spaceId: space.spaceId, title: `Legacy membership ${n}`, visibility: 'public', contextId: state.fixture.contextId },
    }), 201);
    realms.push(realm.realmId);
  }
  for (const realmId of realms) await body(await state.driver.request({ actor: state.actor, method: 'POST',
    path: `/v1/realms/${realmId}/membership`, key: JSON.stringify(key()) }), 202);
  await state.driver.settle();
  for (const realmId of realms) await oldStableHold(state, realmId);
  // A real old source absent from the authority is pending, never cancellation.
  const pendingRealm = newId(routeOf(state.realm.realmId)!);
  const pendingReservation = newId(routeOf(state.persona.accountId)!);
  const pendingTransaction = newId(routeOf(state.persona.accountId)!);
  await state.system.database.admin.query(
    `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
     VALUES ($1,$2,'realm',$3,$4,$5)`,
    [routeOf(state.persona.accountId), state.persona.accountId, pendingRealm, pendingReservation, pendingTransaction]);
  await oldStableHold(state, pendingRealm);
  // Source disagreement is a separate uncertain historical case. Neither source
  // fact alone may certify it; this row has no committed native terminal receipt.
  const ambiguousRealm = realms[0]!;
  const stable = (await state.system.database.pool.query<{ reservation_id: string }>(
    `SELECT reservation_id::text FROM access.membership_inverse
     WHERE route=$1 AND account_id=$2 AND kind='realm' AND group_id=$3`,
    [routeOf(state.persona.accountId), state.persona.accountId, ambiguousRealm])).rows[0]!;
  await state.system.database.admin.query(
    `INSERT INTO community.realm_member_terminal(route,realm_id,account_id,reservation_id,transaction_id,at)
     VALUES($1,$2,$3,$4,$5,now())`,
    [routeOf(ambiguousRealm), ambiguousRealm, state.persona.accountId, stable.reservation_id, newId(0x3170)]);
  await worker.stop();
  try {
    const config = { pool: state.system.database.pool, keys: state.system.tokenKeys, barrierId: 'stopped-native-writers',
      authority: state.membership.authority, certify: state.membership.certifyLegacy };
    let reconciler = createRealmMembershipReconciler(config);
    const firstPage = await reconciler.page({ accountId: state.persona.accountId });
    expect(firstPage.items).toHaveLength(32);
    expect(firstPage.completed).toBe(false);
    expect(firstPage.cursor).toBeString();
    await expect(reconciler.page({ accountId: state.persona.accountId, cursor: firstPage.cursor!.slice(0,-1)+'x' })).rejects.toThrow();
    // Recreate the coordinator. Progress is native storage, not a process Map.
    reconciler = createRealmMembershipReconciler(config);
    const lastPage = await reconciler.page({ accountId: state.persona.accountId, cursor: firstPage.cursor });
    expect(lastPage.completed).toBe(true);
    const items = [...firstPage.items, ...lastPage.items];
    expect(new Set(items.map(item => item.reservationId)).size).toBe(35);
    expect(items.filter(item => item.state === 'published')).toHaveLength(33);
    expect(items.find(item => item.realmId === pendingRealm)?.state).toBe('pending');
    expect(items.find(item => item.realmId === ambiguousRealm)?.state).toBe('uncertain');
    const redriven = await reconciler.page({ accountId: state.persona.accountId, redrive: true });
    expect(redriven.items.map(item => item.state).sort()).toEqual(['pending','uncertain']);
    expect((await state.system.database.pool.query(
      `SELECT reservation_id FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND purpose='membership'`,
      [routeOf(state.persona.accountId), state.persona.accountId])).rows).toHaveLength(2);
    await expect(state.erase()).rejects.toThrow();
    expect(await readErasureStatus(state.system.database.pool, state.persona.accountId)).toBeNull();
  } finally { await restartWorker(); }
}, 240_000);

test.serial('native transition and selected legacy output stay bounded at 64/512/4096 same-home holds, proofs, receipts and generations', async () => {
  const state = await setup();
  const legacy = await state.deletion.person();
  const legacyRoute = routeOf(legacy.accountId)!;
  const reservation = newId(legacyRoute);
  const transaction = newId(legacyRoute);
  await state.system.database.admin.query(
    `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
     VALUES($1,$2,'realm',$3,$4,$5)`,[legacyRoute,legacy.accountId,state.realm.realmId,reservation,transaction]);
  await state.system.database.admin.query(
    `INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id)
     VALUES($1,$2,$3,$4,'membership',$5)`,[legacyRoute,legacy.accountId,reservation,state.realm.realmId,transaction]);
  const consentReader = createCurrentConsentReader({ database: state.system.database.authPool });
  const consent = await startConsentServer(async input => (await consentReader.readCurrentConsent(input))?.scopes ?? null);
  await worker.stop();
  try {
    const claims = JSON.parse(Buffer.from(state.persona.bearer.split('.')[1]!,'base64url').toString()) as { iss: string; aud: string };
    const response = await state.deletion.auth.host.handler(new Request(`${claims.iss}/.well-known/jwks.json`));
    expect(response.status).toBe(200);
    const child = Bun.spawn(['bun','test/access/realm-membership-transition-growth.ts'], {
      cwd: new URL('../..',import.meta.url).pathname,
      env: { ...process.env, ...consent.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    child.stdin.write(JSON.stringify({ databaseUrl: state.system.database.pool.options.connectionString,
      accountId: state.persona.accountId, bearer: state.persona.bearer, realmId: state.realm.realmId,
      legacyAccountId: legacy.accountId, issuer: claims.iss, audience: claims.aud, jwks: await response.json(),
      routeKey: Buffer.from(state.system.routeKey).toString('base64url'),
      keys: [...state.system.tokenKeys.keys].map(([id,value]) => [id,Buffer.from(value).toString('base64url')]) }));
    child.stdin.end();
    const [code,stdout,stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code,stdout+'\n'+stderr).toBe(0);
    const line = stdout.split('\n').find(line => line.startsWith('TRANSITION_GROWTH '));
    expect(line,stdout).toBeDefined();
    const samples = JSON.parse(line!.slice('TRANSITION_GROWTH '.length)) as { scale: number; cost: unknown }[];
    expect(samples.map(sample => sample.scale)).toEqual([64,512,4096]);
    console.log(line);
  } finally { await consent.close(); await restartWorker(); }
},600_000);
