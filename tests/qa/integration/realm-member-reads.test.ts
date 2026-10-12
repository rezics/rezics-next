import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { workAsyncStorage, type WorkStore } from 'next/dist/server/app-render/work-async-storage.external.js';
import { workUnitAsyncStorage, type RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external.js';
import { readRealmDecision, readRealmDecisions, readRealmWorks } from '../../../apps/web/features/realm/read.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import { startMediaStack } from './media-support.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}

async function pageRequest<T>(token: string | undefined, sessionKey: string, run: () => Promise<T>): Promise<T> {
  const work = spyOn(workAsyncStorage, 'getStore').mockReturnValue({ route: '/en/r/private/decisions' } as WorkStore);
  const request = spyOn(workUnitAsyncStorage, 'getStore').mockReturnValue({
    type: 'request', phase: 'render',
    headers: new Headers({ 'x-rezics-page-url': 'https://web.test/en/r/private/decisions' }),
    cookies: { get: (name: string) => name === 'rezics_access' && token ? { value: token }
      : name === 'rezics_session_key' ? { value: sessionKey } : undefined },
  } as RequestStore);
  try { return await run(); }
  finally { work.mockRestore(); request.mockRestore(); }
}

test('a private Realm non-owner member reads Decisions, their exact permalink and subject Works; inadmissible readers stay concealed', async () => {
  const stack = await startMediaStack('realm-member-reads', { profileCredits: true });
  const origin = process.env.MAIN_ORIGIN;
  const nativeFetch = globalThis.fetch;
  const originalSummaries = WorkReadSession.prototype.summaries;
  let restoreSummaries = () => {};
  try {
    const owner = await stack.member('founder');
    const member = await stack.member('reader');
    const outsider = await stack.member('outsider');
    for (const person of [owner, member, outsider]) {
      await person.grant(`agent:control:${person.actor}`, 'agent.control');
    }
    await owner.grant('space:create:root', 'space.create');
    const realm = await json<{ realm: string; space: string }>(await owner.send('POST', '/v1/spaces', {
      profile: 'space-realm-v2', name: 'Private member reading', handle: `private-reader-${randomUUID().slice(0, 8)}`,
      capabilities: ['realm'], actingSubject: owner.actor,
      initialSettings: { visibility: 'private', reviewRequired: false, reviewMode: 'open',
        whoMaySubmit: 'granted', selfJoin: false, rules: [] },
    }), 201);
    const work = await stack.publicWork(owner.actor, ['en'], 'Private Realm decision subject');
    await owner.grant(`publication:adopt:${realm.realm}`, 'publication.adopt');
    await json(await owner.send('POST', '/v1/publication-selections', {
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: realm.realm },
      work: work.work, mainVersion: work.mainVersion, contribution: work.variants[0]!.contribution,
      publicationDecision: work.variants[0]!.decision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review', actingSubject: owner.actor,
    }), 201);

    await member.grant('work:create:root', 'access.membership.consent');
    const policy = (await stack.accessPool.query<{ revision: string; terms_revision: string }>(
      "SELECT revision::text, terms_revision FROM access.membership_policy WHERE kind='realm' AND owner_subject=$1",
      [realm.realm])).rows[0]!;
    const consent = await new AccessMembershipConsents(stack.accessPool).issue({ principal: member.principal,
      kind: 'realm', ownerSubject: realm.realm, memberSubject: member.actor, expectedGeneration: '0',
      expectedPolicyRevision: policy.revision, termsRevision: policy.terms_revision,
      idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
    const admin = new AccessRealmManagement(stack.accessPool);
    const generation = (await stack.accessPool.query<{ generation: string }>(
      'SELECT generation::text FROM access.realm_admin_revision WHERE realm=$1', [realm.realm])).rows[0]!.generation;
    const joined = await admin.changeMember(owner.principal, realm.realm, {
      actingSubject: owner.actor, member: member.actor, action: 'add', expectedGeneration: generation,
      expectedMembershipGeneration: '0', consent: consent.consentReference, durationSeconds: null,
      reason: 'Admit a reader',
    }, randomUUID(), stack.env);
    expect(member.actor).not.toBe(owner.actor);

    const sessionKey = randomUUID();
    for (const person of [member, outsider]) {
      await json(await stack.main.handle(new Request('http://main.local/v1/me/session-agent', {
        method: 'PUT', headers: { authorization: `Bearer ${person.token}`, 'x-session-key': sessionKey,
          'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ actingSubject: person.actor, expectedRevision: null }),
      })));
    }
    const root = `/v1/realms/${short(realm.realm)}`;
    await json(await member.read(root));
    const decisions = await json<{ items: { id: string; work: string }[] }>(await member.read(`${root}/decisions`));
    expect(decisions.items).toHaveLength(1);
    const decision = decisions.items[0]!;
    expect(decision.work).toBe(work.work);

    // The actual web adapters call the composed Main owners with their request
    // cookies and live session selection; only the network transport is local.
    process.env.MAIN_ORIGIN = 'http://realm-reader.test';
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.origin === process.env.MAIN_ORIGIN
        ? stack.main.handle(new Request(input, init)) : nativeFetch(input, init);
    }) as typeof fetch;
    const reads = async () => [await readRealmDecisions(short(realm.realm)),
      await readRealmDecision(short(realm.realm), short(decision.id)), await readRealmWorks(short(realm.realm), 'en')];
    const admitted = await pageRequest(member.token, sessionKey, reads);
    expect(admitted[0]).toMatchObject({ ok: true, data: { items: [{ id: decision.id, work: work.work }] } });
    expect(admitted[1]).toMatchObject({ ok: true, data: { id: decision.id, work: work.work } });
    expect(admitted[2]).toMatchObject({ ok: true, data: { items: [{ id: work.work }] } });
    const concealed = Array.from({ length: 3 }, () => ({ ok: false, failure: 'missing' }));
    for (const token of [undefined, outsider.token, 'expired-bearer']) {
      expect(await pageRequest(token, sessionKey, reads)).toEqual(concealed);
    }
    // The joined Account has an eligible Agent suggestion but no saved Agent
    // in this other web session. That suggestion grants no private read.
    expect(await pageRequest(member.token, randomUUID(), reads)).toEqual(concealed);

    let removed = false;
    const revoke = async () => {
      if (removed) return;
      removed = true;
      await admin.changeMember(owner.principal, realm.realm, {
        actingSubject: owner.actor, member: member.actor, action: 'remove',
        expectedGeneration: joined.generation, expectedMembershipGeneration: joined.membershipGeneration,
        consent: null, durationSeconds: null, reason: 'Revoke the reader',
      }, randomUUID(), stack.env);
    };
    const summaries = spyOn(WorkReadSession.prototype, 'summaries').mockImplementation(async function (this: WorkReadSession, ...args) {
      const result = await originalSummaries.apply(this, args);
      await revoke();
      return result;
    });
    restoreSummaries = () => summaries.mockRestore();
    expect(await pageRequest(member.token, sessionKey, () => readRealmWorks(short(realm.realm), 'en')))
      .toEqual({ ok: false, failure: 'missing' });
    expect(removed).toBe(true);
    expect(await pageRequest(member.token, sessionKey, reads)).toEqual(concealed);
  } finally {
    restoreSummaries();
    globalThis.fetch = nativeFetch;
    if (origin === undefined) delete process.env.MAIN_ORIGIN;
    else process.env.MAIN_ORIGIN = origin;
    await stack.stop();
  }
}, 180_000);
