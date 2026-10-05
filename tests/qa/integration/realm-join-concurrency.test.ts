import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { RealmDirectoryWorker } from '../../../services/main/src/modules/realm-directory/worker.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { RealmAdminStale } from '../../../services/main/src/modules/realm-admin/contract.ts';
import { WorkReadMoved } from '../../../services/main/src/modules/work/read-session.ts';
import { RealmJoinRequests } from '../../../services/main/src/modules/realm-admin/join-requests.ts';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation waited on the held transaction or graph call')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

test('Realm joins and directory reads: delayed graph preparation holds no shared row locks; held joins do not block GET', async () => {
  const stack = await startMediaStack('realm-join-concurrency');
  const originalQuery = stack.fuseki.query.bind(stack.fuseki);
  const releases: (() => void)[] = [];
  const pending: Promise<unknown>[] = [];
  try {
    const owner = await stack.member('owner');
    await owner.grant('space:create:root', 'space.create');
    await owner.grant('work:create:root', 'agent.control');
    const admin = new AccessRealmManagement(stack.accessPool);
    const create = async (name: string) => {
      const response = await owner.send('POST', '/v1/spaces', { profile: 'space-realm-v1', name,
        capabilities: ['realm'], actingSubject: owner.actor });
      expect(response.status, await response.clone().text()).toBe(201);
      const result = await response.json() as { realm: string; space: string };
      await admin.initialize(owner.principal, result.realm, owner.actor, stack.env);
      return result;
    };
    const first = await create('First concurrency Realm');
    const second = await create('Second concurrency Realm');
    await stack.accessPool.query(`INSERT INTO access.realm_admin_settings (realm,who_may_submit,history)
      VALUES ($1,'granted','from-admission') ON CONFLICT (realm) DO UPDATE SET history = EXCLUDED.history`, [second.realm]);
    const worker = new RealmDirectoryWorker({ environment: stack.env, access: stack.access, account: {} as never });
    for (let step = 0; !await worker.tick(); step++) expect(step).toBeLessThan(30);
    const before = await stack.call('GET', '/v1/realms');
    expect(before.status).toBe(200);
    const saved = await before.json() as { sourcePosition: { dataEpoch: string; sequence: string }; items: { id: string }[] };

    const prepareJoin = async (realm: string) => {
      const member = await stack.member('joining');
      await member.grant('work:create:root', 'agent.control');
      await member.grant('work:create:root', 'access.membership.consent');
      const policy = (await stack.accessPool.query<{ revision: string; terms_revision: string }>(`
        SELECT revision::text,terms_revision FROM access.membership_policy WHERE kind = 'realm' AND owner_subject = $1`, [realm])).rows[0]!;
      const consent = await new AccessMembershipConsents(stack.accessPool).issue({ principal: member.principal,
        kind: 'realm', ownerSubject: realm, memberSubject: member.actor, expectedGeneration: '0',
        expectedPolicyRevision: policy.revision, termsRevision: policy.terms_revision,
        idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
      const generation = (await stack.accessPool.query<{ generation: string }>(
        'SELECT generation::text FROM access.realm_admin_revision WHERE realm = $1', [realm])).rows[0]!.generation;
      return () => admin.changeMember(owner.principal, realm, { actingSubject: owner.actor, member: member.actor,
        action: 'add', expectedGeneration: generation, expectedMembershipGeneration: '0', reason: 'Join Realm',
        consent: consent.consentReference, durationSeconds: null }, randomUUID(), stack.env);
    };
    const joinSecond = await prepareJoin(second.realm);
    await stack.publicWork(owner.actor, ['en'], 'Move the directory source');
    expect(await worker.tick()).toBe(false); // clear inactive generation
    expect(await worker.tick()).toBe(false); // copy published generation
    const entered = barrier(), delayed = barrier();
    let delayNext = true;
    releases.push(delayed.release);
    stack.fuseki.query = async (...args) => {
      if (delayNext && args[0].includes('SELECT DISTINCT ?realm WHERE')) {
        delayNext = false; entered.release(); await delayed.promise;
      }
      return originalQuery(...args);
    };
    const building = worker.tick();
    pending.push(building);
    await within(entered.promise);
    const page = await within(stack.call('GET', '/v1/realms'));
    expect(page.status, await page.clone().text()).toBe(200);
    expect((await page.json() as typeof saved).sourcePosition).toEqual(saved.sourcePosition);
    const joined = await within(joinSecond());
    expect(joined.membershipGeneration).toBe('1');
    const cut = (await stack.accessPool.query<{ sequence: string; data_epoch: string }>(`
      SELECT sequence::text,data_epoch FROM access.realm_history_admission WHERE membership_id =
        (SELECT id FROM access.membership WHERE owner_subject = $1 AND generation = 1)`, [second.realm])).rows[0]!;
    expect(cut.data_epoch).toBe(stack.env.lineage.dataEpoch);
    expect(BigInt(cut.sequence)).toBeGreaterThan(BigInt(saved.sourcePosition.sequence));
    // Another Main wins the same durable step while the first HTTP read is
    // held. The first preparation must fail stale instead of overwriting it.
    expect(await within(worker.tick())).toBe(true);
    delayed.release();
    await expect(building).rejects.toBeInstanceOf(WorkReadMoved);
    stack.fuseki.query = originalQuery;

    const held = await stack.accessPool.connect();
    try {
      await held.query('BEGIN');
      await held.query("SELECT 1 FROM access.scope_gate WHERE id = 'work:create:root' FOR UPDATE");
      await held.query('SELECT 1 FROM access.realm_count_position WHERE singleton FOR UPDATE');
      await held.query('SELECT 1 FROM access.realm_directory_position WHERE singleton FOR UPDATE');
      const unblocked = await within(stack.call('GET', '/v1/realms?sort=members'));
      expect(unblocked.status, await unblocked.clone().text()).toBe(200);
    } finally { await held.query('ROLLBACK'); held.release(); }

    const settings = await admin.spaceSettings(owner.principal, first.space, owner.actor, stack.env);
    await admin.changeSpaceSettings(owner.principal, first.space, { actingSubject: owner.actor,
      expectedGeneration: settings.generation, reason: 'Accept membership requests',
      settings: { visibility: 'public', listing: 'listed', history: 'everything', admission: 'request' } }, randomUUID(), stack.env);
    const requester = await stack.member('requesting');
    await requester.grant('work:create:root', 'agent.control');
    const requests = new RealmJoinRequests(stack.accessPool, stack.env);
    const requestBasis = await requests.basis(requester.principal, first.realm, requester.actor);
    let requestGraphCalls = 0;
    // Every graph read on the request path must leave the global gate free,
    // including the admission-open read before its Realm policy query.
    stack.fuseki.query = async (...args) => {
      requestGraphCalls++;
      const probe = await stack.accessPool.connect();
      try {
        await probe.query('BEGIN');
        await probe.query("SELECT 1 FROM access.scope_gate WHERE id = 'work:create:root' FOR UPDATE NOWAIT");
      } finally { await probe.query('ROLLBACK'); probe.release(); }
      return originalQuery(...args);
    };
    expect(await requests.request(requester.principal, first.realm, { actingSubject: requester.actor,
      expectedMembershipGeneration: requestBasis.membershipGeneration,
      expectedPolicyRevision: requestBasis.policyRevision, termsRevision: requestBasis.termsRevision,
      reason: 'Request membership' }, randomUUID())).toMatchObject({ state: 'pending' });
    expect(requestGraphCalls).toBe(2);
    stack.fuseki.query = originalQuery;

    const delayedJoin = await prepareJoin(second.realm);
    const independentJoin = await prepareJoin(first.realm);
    const historyEntered = barrier(), historyDelay = barrier();
    releases.push(historyDelay.release);
    stack.fuseki.query = async (...args) => {
      if (args[0].includes('SELECT ?sequence WHERE')) { historyEntered.release(); await historyDelay.promise; }
      return originalQuery(...args);
    };
    const admitting = delayedJoin();
    pending.push(admitting);
    await within(historyEntered.promise);
    expect((await within(independentJoin())).membershipGeneration).toBe('1');
    const recovery = await within(engageAccessRecoveryFence(stack.accessPool));
    await releaseAccessRecoveryFence(stack.accessPool, recovery);
    historyDelay.release();
    await expect(admitting).rejects.toBeInstanceOf(RealmAdminStale);
    expect((await stack.accessPool.query(`SELECT count(*)::int AS n FROM access.membership
      WHERE owner_subject = $1 AND state = 'joined'`, [second.realm])).rows[0].n).toBe(1);
  } finally {
    releases.forEach(release => release());
    await Promise.allSettled(pending);
    stack.fuseki.query = originalQuery;
    await stack.stop();
  }
}, 120_000);
