import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { closureOriginal } from '../../../tests/qa/integration/outcomes/realm/closure-fixture.ts';
import type { PersonaSession } from '../../../tests/qa/support/personas.ts';
import { unrecordedReasons } from '../src/modules/governance/notices.ts';
import type { DecisionInput } from '../src/modules/governance/store.ts';

type Member = Awaited<ReturnType<MediaStack['member']>>;
type Realm = { realm: string; space: string };
type Reply = { reply: string; revisionId: string; revisionDigest: string };
const short = (value: string) => value.slice(-36);
const native = () => `https://rezics.com/id/${randomUUID()}`;
const session = (member: Member): PersonaSession => ({ actingSubject: member.actor,
  accountId: member.principalId, main: (method, path, body, key) => member.send(method, path, body,
    key ?? (['GET', 'HEAD'].includes(method) ? undefined : randomUUID())),
  snapshot: () => ({ expiresAt: null, main: (method, path, body, key) => member.send(method, path, body,
    key ?? (['GET', 'HEAD'].includes(method) ? undefined : randomUUID())) }),
  account: async () => { throw new Error('This owner fixture serves Main'); } });

test('completed closure conceals discussion reads and consented roster while credited originals stay public', async () => {
  const stack = await startMediaStack('realm-closure-readers', { profileCredits: true });
  const account = stack.composition.dependencies.account;
  const verify = account.verify.bind(account);
  account.verify = (request, scopes) => {
    if (!request.headers.has('authorization')) throw new AccountAssertionDenied('Authentication is required');
    return verify(request, scopes);
  };
  const evidence: unknown[] = [];
  let phase = 'preparation';
  async function call(member: Member | undefined, method: string, path: string, body?: unknown, expected?: number) {
    if (member && method === 'GET') {
      const url = new URL(path, 'http://main.local');
      if (!url.pathname.endsWith('/roster')) url.searchParams.set('actingSubject', member.actor);
      path = url.pathname + url.search;
    }
    const key = ['GET', 'HEAD'].includes(method) ? undefined : randomUUID();
    const response = member ? await member.send(method, path, body, key) : await stack.call(method, path, { body, key });
    const raw = await response.text();
    const answer: unknown = JSON.parse(raw);
    evidence.push({ phase, caller: member?.actor ?? null, method, path, body,
      answer: { status: response.status, body: raw, date: response.headers.get('date') } });
    if (expected !== undefined) expect(response.status, `${method} ${path}: ${raw}`).toBe(expected);
    return { status: response.status, body: answer };
  }
  async function command<T>(member: Member, method: string, path: string, body?: unknown, expected = 200) {
    return (await call(member, method, path, body, expected)).body as T;
  }
  try {
    const person = async (name: string) => {
      const member = await stack.member(name, { verified: true });
      const provisioned = await command<{ agent: string }>(member, 'POST', '/v1/agents', {
        profile: 'agent-provision-v1', kind: 'person', displayName: name,
      }, 201);
      member.actor = provisioned.agent;
      member.grant = async (scope, action) => (await grantFixtureAuthority(stack.accessPool, {
        scope, requireDispatch: true,
        representations: [{ principalId: member.principalId, actor: member.actor, action,
          lifetime: action === 'agent.control' ? 'infinity' : '8 hours' }],
        grant: { actor: member.actor, action, lifetime: action === 'agent.control' ? 'infinity' : '8 hours' },
      })).grantId;
      return member;
    };
    const owner = await person('closure-owner');
    const member = await person('closure-member');
    const moderator = await person('closure-moderator');
    const stranger = await person('closure-stranger');
    const operator = await person('closure-operator');
    for (const person of [owner, member, moderator, stranger, operator])
      await person.grant('work:create:root', 'agent.control');
    for (const person of [member, moderator])
      await person.grant('work:create:root', 'access.membership.consent');
    await owner.grant('space:create:root', 'space.create');
    await owner.grant('work:create:root', 'work.create');
    await operator.grant('governance:platform', 'governance.moderate');
    await operator.grant('governance:platform', 'governance.rule.publish');
    const createRealm = async (name: string) => {
      const realm = await command<Realm>(owner, 'POST', '/v1/spaces', {
        profile: 'space-realm-v1', name, capabilities: ['realm'], actingSubject: owner.actor,
        initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open',
          whoMaySubmit: 'members', selfJoin: true, rules: [] },
      }, 201);
      const root = `/v1/realms/${short(realm.realm)}`;
      await command(owner, 'POST', `${root}/management`, { actingSubject: owner.actor });
      for (const person of [member, moderator]) {
        const joining = await command<{ policyRevision: string }>(person, 'GET', `${root}/joining?actingSubject=${encodeURIComponent(person.actor)}`);
        await command(person, 'POST', `${root}/join`, { actingSubject: person.actor,
          expectedMembershipGeneration: '0', expectedPolicyRevision: joining.policyRevision,
          termsRevision: 'realm-membership-v1', listed: true });
      }
      await command(owner, 'PUT', `${root}/roster/featured`, { actingSubject: owner.actor,
        member: member.actor, expectedMembershipGeneration: '1', featured: true });
      await moderator.grant(`review:decide:${realm.realm}`, 'review.decide');
      await moderator.grant(`reply:place:${realm.realm}`, 'reply.place');
      await moderator.grant(`publication:adopt:${realm.realm}`, 'publication.adopt');
      return realm;
    };
    const closed = await createRealm('Closed reader control');
    const live = await createRealm('Independent live reader control');
    const empty = await createRealm('Empty closed reader control');
    expect((await command<{ items: unknown[] }>(owner, 'GET', `/v1/realms/${short(empty.realm)}/threads?sort=new`)).items).toEqual([]);
    const original = await closureOriginal(session(owner), `Credited original ${randomUUID()}`);
    const place = async (realm: Realm, body: string, parent?: Reply): Promise<Reply> => {
      const reply = native(), variantId = `urn:rezics:variant:${randomUUID()}`;
      const draft = await command<{ revisionId: string; revisionDigest: string }>(member, 'POST', '/v1/member-reply-drafts', {
        profile: 'member-reply-draft-v1', reply, variantId, rootTarget: original.work,
        rootRevision: original.workRevision, originRealm: realm.realm, language: 'en', direction: 'ltr',
        expectedHead: null, body, actingSubject: member.actor,
      }, 201);
      await command(member, 'POST', '/v1/realm-replies', { profile: 'realm-reply-identity-v1',
        reply, variantId, revisionId: draft.revisionId, author: member.actor,
        rootTarget: original.work, rootRevision: original.workRevision,
        parentReply: parent?.reply ?? null, parentRevision: parent?.revisionId ?? null, contextRevision: null,
      }, 201);
      const review = await command<{ decisionId: string }>(moderator, 'POST', '/v1/realm-reply-reviews', {
        profile: 'realm-reply-review-v1', realm: realm.realm, reply,
        revisionId: draft.revisionId, revisionDigest: draft.revisionDigest, expectedGeneration: '0',
        supersedes: null, outcome: 'approved', method: 'human', methodRevision: 'realm-manager-v1',
        dependencyDigest: createHash('sha256').update(original.work).digest('hex'),
        reasonReference: null, actingSubject: moderator.actor,
      }, 201);
      await command(moderator, 'POST', '/v1/realm-reply-placements', { profile: 'realm-reply-placement-v1',
        realm: realm.realm, reply, revisionId: draft.revisionId, revisionDigest: draft.revisionDigest,
        reviewDecisionId: review.decisionId, expectedHead: null, actingSubject: moderator.actor,
      }, 201);
      return { reply, ...draft };
    };
    const opener = await place(closed, 'Closed opener\nAn original member discussion.');
    const child = await place(closed, 'Closed descendant', opener);
    await place(closed, 'Second closed opener\nRetained pagination control.');
    const liveOpener = await place(live, 'Live opener\nThe independent Realm stays public.');
    const root = `/v1/realms/${short(closed.realm)}`;
    const liveRoot = `/v1/realms/${short(live.realm)}`;
    const absent = native(), absentRoot = `/v1/realms/${short(absent)}`;
    const roster = await command<{ nextCursor: string }>(owner, 'GET', `${root}/roster?limit=1`);
    const threads = await command<{ nextCursor: string; items: { reply: string }[] }>(owner, 'GET', `${root}/threads?sort=new&limit=1`);
    expect(roster.nextCursor).not.toBeNull();
    expect(threads.nextCursor).not.toBeNull();
    expect(threads.items).toHaveLength(1);
    const governance = stack.composition.dependencies.governance!;
    const rule = await governance.rules!.publish(operator.principal, {
      ref: `urn:rezics:rule:${randomUUID()}`, scopeId: 'governance:platform', actingSubject: operator.actor,
      expectedRevision: null, document: { purpose: 'Close only the reviewed Realm record' }, idempotencyKey: randomUUID(),
    });
    const close = async (realm: Realm) => {
    const header = await command<{ revision: string }>(owner, 'GET', `/v1/realms/${short(realm.realm)}`);
    const report = await command<{ reportId: string; caseId: string }>(owner, 'POST', '/v1/public-reports', {
      profile: 'public-report-v1', target: realm.realm, actingSubject: owner.actor,
      category: 'spam_or_manipulation', statement: 'Review this Realm record.', contentLanguage: 'en',
    }, 201);
    const basis = (await stack.accessPool.query<{ generation: string; evidence_digest: string }>(
      `SELECT c.generation::text,r.evidence_digest FROM access.governance_case c
       JOIN access.governance_report r ON r.case_id=c.id WHERE r.id=$1`, [report.reportId])).rows[0]!;
    await governance.store.safety.claim(operator.principal, operator.actor, report.caseId);
    const input: DecisionInput = { caseId: report.caseId, expectedGeneration: basis.generation,
      actingSubject: operator.actor, outcome: 'restrict', targets: [{ owner: 'graph', resource: realm.realm,
        component: 'record', locator: null, revision: null, scopeKind: 'component', expectedHead: header.revision, effect: 'disclosure' }],
      rule, evidenceDigest: basis.evidence_digest, reversesDecisionId: null, answersStepId: null,
      rationale: null, disclosure: 'parties', idempotencyKey: randomUUID(), reasons: {
        ...unrecordedReasons, facts: 'The exact record was reviewed.', scope: 'This Realm record only.',
        duration: 'Until a later decision.', automation: false,
      } };
    const decision = await governance.store.decide(operator.principal, input);
    evidence.push({ phase: 'closure', input, decision });
    expect(decision.operation.status).toBe('completed');
    };
    await close(closed);
    await close(empty);
    expect((await call(undefined, 'GET', root))).toEqual(await call(undefined, 'GET', absentRoot));
    phase = 'delivery';
    const failures: unknown[] = [];
    for (const person of [undefined, stranger, member, owner, moderator, operator]) {
      const suffixes = ['/threads?sort=best&window=all', '/threads?sort=top&window=all', '/threads?sort=new',
        `/threads?sort=new&limit=1&cursor=${encodeURIComponent(threads.nextCursor)}`,
        `/threads/${short(opener.reply)}`, `/threads/${short(child.reply)}`,
        `/about-thread?about=${encodeURIComponent(original.work)}`, '/roster', '/roster?featured=true',
        `/roster?limit=1&after=${encodeURIComponent(roster.nextCursor)}`];
      for (const suffix of suffixes) {
        const current = await call(person, 'GET', root + suffix);
        const missing = await call(person, 'GET', absentRoot + suffix);
        expect(current.status).toBe(suffix.startsWith('/roster') ? 403 : 404);
        if (JSON.stringify(current) !== JSON.stringify(missing)) failures.push({ caller: person?.actor ?? null, suffix, current, missing });
      }
      for (const suffix of suffixes.slice(0, 3)) {
        const current = await call(person, 'GET', `/v1/realms/${short(empty.realm)}` + suffix);
        const missing = await call(person, 'GET', absentRoot + suffix);
        expect(current.status).toBe(404);
        if (JSON.stringify(current) !== JSON.stringify(missing)) failures.push({ empty: true, caller: person?.actor ?? null, suffix, current, missing });
      }
      const actor = encodeURIComponent(person?.actor ?? absent);
      for (const suffix of [`replies/${encodeURIComponent(child.reply)}`, `reply-roots/${encodeURIComponent(original.work)}/count`]) {
        const current = await call(person, 'GET', `/v1/realms/${encodeURIComponent(closed.realm)}/${suffix}?actingSubject=${actor}`);
        const missing = await call(person, 'GET', `/v1/realms/${encodeURIComponent(absent)}/${suffix}?actingSubject=${actor}`);
        expect(current.status).toBe(person ? suffix.startsWith('replies/') ? 404 : 403 : 401);
        if (JSON.stringify(current) !== JSON.stringify(missing)) failures.push({ caller: person?.actor ?? null, suffix, current, missing });
      }
      const listed = (await call(person, 'GET', `${liveRoot}/roster`, undefined, 200)).body as { items: { agent: string; displayName: string; featured: boolean }[] };
      expect(listed.items).toContainEqual({ agent: member.actor, displayName: 'closure-member', featured: true });
      const liveThreads = (await call(person, 'GET', `${liveRoot}/threads?sort=new`, undefined, 200)).body as { items: { reply: string }[] };
      expect(liveThreads.items).toContainEqual(expect.objectContaining({ reply: liveOpener.reply }));
      if (person) {
        await call(person, 'GET', `/v1/realms/${encodeURIComponent(live.realm)}/replies/${encodeURIComponent(liveOpener.reply)}`, undefined, 200);
        const count = (await call(person, 'GET', `/v1/realms/${encodeURIComponent(live.realm)}/reply-roots/${encodeURIComponent(original.work)}/count`, undefined, 200)).body as { count: number };
        expect(count.count).toBe(1);
      }
      expect((await call(person, 'GET', `${liveRoot}/about-thread?about=${encodeURIComponent(original.work)}`, undefined, 200)).body)
        .toEqual({ realm: live.realm, about: original.work, thread: null });
      await call(person, 'GET', `/v1/works/${short(original.work)}`, undefined, 200);
      const publication = (await call(person, 'GET', `/v1/main-versions/${short(original.mainVersion)}/selection`, undefined, 200)).body as { body: string };
      expect(publication.body).toContain('Original fixture by its credited author Person:');
      const credits = (await call(person, 'GET', `/v1/works/${short(original.work)}/agent-credits`, undefined, 200)).body as { items: { agent: string; role: string }[] };
      expect(credits.items).toHaveLength(1);
      expect(credits.items[0]).toMatchObject({ agent: owner.actor, role: 'author' });
    }
    // Let the real graph read finish, close the Realm through governance, then
    // release hydration. No owner result is mocked or replaced.
    phase = 'closure-during-read';
    const reached = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const graphQuery = stack.fuseki.query.bind(stack.fuseki);
    let armed = true;
    stack.fuseki.query = async (query, maximum) => {
      const result = await graphQuery(query, maximum);
      if (armed && query.includes('SELECT DISTINCT ?id ?reply ?work ?author ?revision ?review ?preparation')) {
        armed = false;
        reached.resolve();
        await resume.promise;
      }
      return result;
    };
    const reading = call(undefined, 'GET', `${liveRoot}/threads?sort=new`);
    try { await reached.promise; await close(live); }
    finally { resume.resolve(); stack.fuseki.query = graphQuery; }
    const raced = await reading, missing = await call(undefined, 'GET', `${absentRoot}/threads?sort=new`);
    if (JSON.stringify(raced) !== JSON.stringify(missing)) failures.push({ phase, raced, missing });
    expect(failures, JSON.stringify(failures)).toEqual([]);
  } finally {
    writeFileSync(`.temp/goal/owner-closure-${Bun.env.REZICS_QA_RUN_ID}.json`, JSON.stringify({ phase, evidence }, null, 2));
    await stack.stop();
  }
}, 180_000);
