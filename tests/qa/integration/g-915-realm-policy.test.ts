import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { pendingRealmPolicies, recoverRealmPolicies, RealmPolicyRecoveryWorker, settleRealmPolicy }
  from '../../../services/main/src/modules/access/realm-management-recovery.ts';
import { readRealmPolicy, policyHead } from '../../../services/main/src/modules/space/policy.ts';
import { profileValidations } from '../../../services/main/src/infrastructure/profile.ts';

test('G-915: interrupted v2 policy resumes at startup; acknowledgement loss, concurrent retries and later settings remain idempotent', async () => {
  const s = await startMediaStack('g-915');
  try {
    const owner = await s.member('owner');
    const outsider = await s.member('outsider');
    await owner.grant('space:create:root', 'space.create');
    // Replay the historical creation envelope on the disposable stack. A
    // canonical profile cannot be changed on an already-created v3 subject.
    const graphCommand = s.fuseki.commandWithReceipt.bind(s.fuseki);
    s.fuseki.commandWithReceipt = async envelope => graphCommand({ ...envelope,
      update: envelope.update.replaceAll('space-realm-v3', 'space-realm-v2'),
      validations: await profileValidations(s.fuseki, 'space-realm-v2', envelope.validations.map(entry => ({
        shape: entry.shape.replaceAll('space-realm-v3', 'space-realm-v2'), focus: entry.focus, graphs: entry.graphs,
      }))),
    });
    const created = await owner.send('POST', '/v1/spaces', { profile: 'space-realm-v2', name: 'Recovery Realm',
      handle: `recovery-${randomUUID().slice(0, 12)}`, topics: [], capabilities: ['realm'], actingSubject: owner.actor });
    expect(created.status).toBe(201);
    const { realm } = await created.json() as { realm: string };
    s.fuseki.commandWithReceipt = graphCommand;
    const admin = new AccessRealmManagement(s.accessPool);
    await admin.initialize(owner.principal, realm, owner.actor, s.env);
    await owner.grant(`governance:realm:${realm}`, 'realm.owner');
    await owner.grant(`governance:realm:${realm}`, 'governance.rule.publish');
    const initial = await admin.settings(owner.principal, realm, owner.actor, s.env);
    const input = { actingSubject: owner.actor, expectedGeneration: initial.generation,
      expectedRulesRevision: initial.ruleBasis.revision, reason: 'Recover interrupted publication',
      settings: { visibility: 'private' as const, reviewMode: 'open' as const, reviewRequired: false,
        whoMaySubmit: 'granted' as const, rules: [] } };
    let commands = 0;
    s.fuseki.commandWithReceipt = async () => { throw new Error('Interrupted after Access commit'); };
    const key = randomUUID();
    await expect(admin.changeSettings(owner.principal, realm, input, key, s.env)).rejects.toThrow('pending');
    const pending = (await pendingRealmPolicies(s.accessPool)).items.find(item => item.realm === realm)!;
    expect(pending).toMatchObject({ generation: '1', visibility: 'private', review_mode: 'open' });
    expect((await readRealmPolicy(s.env, realm))!.revision).toBeNull();
    s.fuseki.commandWithReceipt = async envelope => { commands++; return graphCommand(envelope); };
    const worker = new RealmPolicyRecoveryWorker(s.accessPool, s.env);
    worker.start();
    await worker.stop();
    expect(commands).toBe(1);
    expect((await pendingRealmPolicies(s.accessPool)).items.some(item => item.realm === realm)).toBe(false);
    expect(await readRealmPolicy(s.env, realm)).toMatchObject({ visibility: 'private', reviewMode: 'open', revision: policyHead(pending.receipt_id) });
    const app = createMainApp(s.fuseki, { environment: s.env, realmAdmin: admin,
      account: { verify: async request => request.headers.get('authorization') === `Bearer ${owner.token}` ? owner.principal : outsider.principal } });
    const settings = async (actor = owner.actor, token = owner.token) => app.handle(new Request(
      `http://main.test/v1/realms/${realm.slice(-36)}/settings?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: `Bearer ${token}` } }));
    expect((await settings()).status).toBe(200);
    expect((await settings(outsider.actor, outsider.token)).status).toBe(403);
    expect((await admin.changeSettings(owner.principal, realm, input, key, s.env)).replayed).toBe(true);
    expect(commands).toBe(1);

    // Interrupt the acknowledgement after Jena commits. This is a process crash
    // at the second boundary: the durable Access record still says pending.
    let interrupt = true;
    const faultPool = new Proxy(s.accessPool, { get(target, prop) {
      if (prop !== 'connect') { const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; }
      return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, field) {
          if (field !== 'query') { const value = Reflect.get(connection, field); return typeof value === 'function' ? value.bind(connection) : value; }
          return async (sql: string, values?: unknown[]) => {
            if (interrupt && sql.includes('SET delivered = true')) { interrupt = false; throw new Error('Interrupted acknowledgement'); }
            return connection.query(sql, values);
          };
        } });
      };
    } }) as Pool;
    const current = await admin.settings(owner.principal, realm, owner.actor, s.env);
    const nextInput = { ...input, expectedGeneration: current.generation, expectedRulesRevision: current.ruleBasis.revision,
      settings: { ...input.settings, visibility: 'public' as const } };
    await expect(new AccessRealmManagement(faultPool).changeSettings(owner.principal, realm, nextInput, randomUUID(), s.env)).rejects.toThrow('pending');
    const published = await readRealmPolicy(s.env, realm);
    expect(published!.visibility).toBe('public');
    expect(commands).toBe(2);
    const concurrent = await Promise.all([settleRealmPolicy(s.accessPool, realm, s.env), settleRealmPolicy(s.accessPool, realm, s.env)]);
    expect(concurrent.sort()).toEqual([false, true]);
    expect(commands).toBe(2);
    expect(await readRealmPolicy(s.env, realm)).toEqual(published);
    expect((await settings()).status).toBe(200);
    expect((await recoverRealmPolicies(s.accessPool, s.env)).items).toEqual([]);
    const final = await admin.settings(owner.principal, realm, owner.actor, s.env);
    await expect(admin.changeSettings(owner.principal, realm, { ...nextInput, expectedGeneration: final.generation,
      expectedRulesRevision: final.ruleBasis.revision, settings: { ...nextInput.settings, visibility: 'restricted' } }, randomUUID(), s.env)).resolves.toMatchObject({ generation: '3' });
    expect(commands).toBe(3);
    expect(await readRealmPolicy(s.env, realm)).toMatchObject({ visibility: 'restricted' });
  } finally { await s.stop(); }
}, 120_000);

test('G-915: a failing publication remains observable and cannot starve the next recovery page', async () => {
  const s = await startMediaStack('g-915-pages');
  try {
    const owner = await s.member('owner');
    await owner.grant('space:create:root', 'space.create');
    const admin = new AccessRealmManagement(s.accessPool);
    const graphCommand = s.fuseki.commandWithReceipt.bind(s.fuseki);
    const realms: string[] = [];
    for (const name of ['Unavailable policy', 'Recoverable policy']) {
      s.fuseki.commandWithReceipt = graphCommand;
      const response = await owner.send('POST', '/v1/spaces', { profile: 'space-realm-v1',
        name, capabilities: ['realm'], actingSubject: owner.actor });
      expect(response.status).toBe(201);
      const { realm } = await response.json() as { realm: string };
      realms.push(realm);
      await admin.initialize(owner.principal, realm, owner.actor, s.env);
      await owner.grant(`governance:realm:${realm}`, 'realm.owner');
      await owner.grant(`governance:realm:${realm}`, 'governance.rule.publish');
      s.fuseki.commandWithReceipt = async () => { throw new Error('Owner temporarily unavailable'); };
      await expect(admin.changeSettings(owner.principal, realm, { actingSubject: owner.actor, expectedGeneration: '0',
        expectedRulesRevision: null, reason: 'Publish policy', settings: { visibility: 'private', reviewMode: 'mandatory',
          reviewRequired: true, whoMaySubmit: 'granted', rules: [] } }, randomUUID(), s.env)).rejects.toThrow('pending');
    }
    const firstRealm = realms.sort()[0]!;
    const secondRealm = realms[1]!;
    s.fuseki.commandWithReceipt = async envelope => {
      if (envelope.update.includes(`<${firstRealm}>`)) throw new Error('Owner temporarily unavailable');
      return graphCommand(envelope);
    };
    const pending = await pendingRealmPolicies(s.accessPool, undefined, 1);
    expect(pending.items).toHaveLength(1);
    expect(pending.nextCursor).toBe(firstRealm);
    const first = await recoverRealmPolicies(s.accessPool, s.env, undefined, 1);
    expect(first.items).toMatchObject([{ realm: firstRealm, status: 'pending', error: 'Realm policy delivery is pending' }]);
    expect(first.nextCursor).toBe(firstRealm);
    const second = await recoverRealmPolicies(s.accessPool, s.env, first.nextCursor!, 1);
    expect(second.items).toMatchObject([{ realm: secondRealm, status: 'completed' }]);
    expect(second.nextCursor).toBeNull();
    expect((await admin.settings(owner.principal, secondRealm, owner.actor, s.env)).settings.visibility).toBe('private');
    expect((await pendingRealmPolicies(s.accessPool)).items.map(item => item.realm)).toEqual([firstRealm]);
    s.fuseki.commandWithReceipt = graphCommand;
    expect((await recoverRealmPolicies(s.accessPool, s.env)).items).toMatchObject([{ realm: firstRealm, status: 'completed' }]);
  } finally { await s.stop(); }
}, 120_000);
