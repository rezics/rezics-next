import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import ranking from '../../../../../scripts/qa/cases/outcomes/realm/ranking.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

type Work = { work: string; workRevision: string };
type Draft = { revisionId: string; revisionDigest: string };
type Page = {
  items: { reply: string; author: { id: string } | null; work: { id: string }; vote: { score: number } }[];
  nextCursor: string | null; count: { value: number; kind: string; total: null };
};
type Members = { generation: string; items: { member: string; membershipGeneration: string }[] };
setDefaultTimeout(420_000);
let publicRealm: PersonaSessions, privateRealm: PersonaSessions;
const publicThreads: string[] = [], oldThreads: string[] = [], currentThreads: string[] = [];
let preparation: Promise<void> | undefined;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => new URLSearchParams(person.actingSubject ? { actingSubject: person.actingSubject } : {});

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
async function seedCommand(person: PersonaSession, target: Work, path: string, input: unknown) {
  const key = randomUUID();
  for (let attempt = 0; ; attempt++) {
    const response = await person.main('POST', path, input, key);
    if (response.status !== 409 || attempt === 24) {
      if (!response.ok) console.info('Pending ranking population command', {
        method: 'POST', path, status: response.status, request: input,
        answer: await response.clone().json(),
      });
      return response;
    }
    const problem = await response.clone().json() as { code: string };
    if (problem.code !== 'read_basis_changed') return response;
    // Restart the public read basis; a receipt race does not change this
    // command's key, credited author or exact intended root revision.
    await answer(person.main('GET', `/v1/works/${short(target.work)}?${acting(person)}`));
  }
}
async function seed(sessions: PersonaSessions, size: number, label: string) {
  const person = sessions.owner, author = person.actingSubject!;
  const target = await answer<Work>(person.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: `Original ${label} ranking garden`, language: 'en',
    authoring: 'own-work', actingSubject: author }), 201);
  const replies: string[] = [];
  const create = async (index: number) => {
    const reply = `https://rezics.com/id/${randomUUID()}`, variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = await answer<Draft>(seedCommand(person, target, '/v1/member-reply-drafts', {
      profile: 'member-reply-draft-v1', reply, variantId, rootTarget: target.work,
      rootRevision: target.workRevision, originRealm: sessions.realm, language: 'en', direction: 'ltr',
      expectedHead: null, body: `Original ${label} thread ${index}\nA synthetic discussion authored for this ranking proof.`,
      actingSubject: author }), 201);
    await answer(seedCommand(person, target, '/v1/realm-replies', {
      profile: 'realm-reply-identity-v1', reply, variantId, revisionId: draft.revisionId,
      author, rootTarget: target.work, rootRevision: target.workRevision,
      parentReply: null, parentRevision: null, contextRevision: null }), 201);
    await answer(seedCommand(person, target, '/v1/realm-reply-placements', {
      profile: 'realm-reply-placement-v1', realm: sessions.realm, reply,
      revisionId: draft.revisionId, revisionDigest: draft.revisionDigest,
      reviewDecisionId: null, expectedHead: null, actingSubject: author }), 201);
    return reply;
  };
  for (let start = 0; start < size; start += 8) {
    const results = await Promise.allSettled(Array.from({ length: Math.min(8, size - start) },
      (_, offset) => create(start + offset)));
    replies.push(...results.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    }));
  }
  return replies;
}
beforeAll(async () => {
  publicRealm = await personaSessions('public');
  privateRealm = await personaSessions('private');
}, 180_000);
// Session bootstrap failures remain ordinary failures. The large inventory
// is the pending public-HTTP proof and currently cannot finish in the client's
// bearer window; every cell retains that same observed command refusal.
async function prepare() {
  publicThreads.push(...await seed(publicRealm, 261, 'public'));
  oldThreads.push(...await seed(privateRealm, 21, 'retained'));
  const owner = privateRealm.owner, root = `/v1/realms/${short(privateRealm.realm)}`;
  const settings = await answer<{ generation: string; settings: object }>(owner.main('GET',
    `/v1/spaces/${short(privateRealm.space)}/settings?${acting(owner)}`));
  await answer(owner.main('PUT', `/v1/spaces/${short(privateRealm.space)}/settings`, {
    actingSubject: owner.actingSubject, expectedGeneration: settings.generation,
    reason: 'Retain discussion history while fencing the next admission',
    settings: { visibility: 'private', listing: 'listed', history: 'from-admission', admission: 'invitation' } }), 201);
  const members = await answer<Members>(owner.main('GET', `${root}/members?${acting(owner)}`));
  await answer(owner.main('POST', `${root}/members`, {
    actingSubject: owner.actingSubject, member: privateRealm.member.actingSubject,
    expectedGeneration: members.generation,
    expectedMembershipGeneration: members.items.find(item => item.member === privateRealm.member.actingSubject)!.membershipGeneration,
    reason: 'End the previous participation episode', action: 'remove', consent: null, durationSeconds: null }), 201);
  const invitation = await answer<{ invitation: { id: string } }>(owner.main('POST', `${root}/invitations`, {
    actingSubject: owner.actingSubject, member: privateRealm.member.actingSubject, expiresInSeconds: 3600 }));
  await answer(privateRealm.member.main('POST', `${root}/invitations/${invitation.invitation.id}/response`, {
    actingSubject: privateRealm.member.actingSubject, action: 'accept', listed: false }));
  currentThreads.push(...await seed(privateRealm, 21, 'current'));
}
afterAll(async () => { await publicRealm?.close(); });

async function traverse(sessions: PersonaSessions, name: PersonaName, expected: string[]) {
  const person = sessions[name], root = `/v1/realms/${short(sessions.realm)}`;
  const header = await answer<Record<string, unknown>>(person.main('GET', `${root}?${acting(person)}`));
  for (const [sort, window] of [['best', 'all'], ['top', 'week'], ['top', 'month'], ['top', 'all']]) {
    const params = acting(person); params.set('sort', sort!); params.set('window', window!); params.set('limit', '20');
    const seen: string[] = [], scores: number[] = [], cursors = new Set<string>();
    let page: Page;
    do {
      page = await answer<Page>(person.main('GET', `${root}/threads?${params}`));
      expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
      expect(page.items.length).toBeLessThanOrEqual(20);
      for (const item of page.items) {
        seen.push(item.reply); scores.push(item.vote.score);
        if (item.author) expect(item.author.id).toBe(sessions.owner.actingSubject!);
      }
      if (page.nextCursor) {
        expect(cursors.has(page.nextCursor)).toBe(false); cursors.add(page.nextCursor);
        params.set('cursor', page.nextCursor);
      }
      expect(cursors.size).toBeLessThan(30);
    } while (page.nextCursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...expected].sort());
    if (sort === 'top') expect(scores).toEqual([...scores].sort((left, right) => right - left));
  }
  const after = await answer<Record<string, unknown>>(person.main('GET', `${root}?${acting(person)}`));
  expect(after).toEqual(header);
}
async function prove(name: PersonaName) {
  const person = publicRealm[name];
  await answer(person.main('GET', `/v1/realms/${short(publicRealm.realm)}?${acting(person)}`));
  await (preparation ??= prepare());
  await traverse(publicRealm, name, publicThreads);
  if (['member', 'owner', 'moderator'].includes(name)) {
    const expected = name === 'member' ? currentThreads : [...oldThreads, ...currentThreads];
    await traverse(privateRealm, name, expected);
    const person = privateRealm[name];
    await answer(person.main('GET', `/v1/realms/${short(privateRealm.realm)}/threads/${short(oldThreads[0]!)}?${acting(person)}`),
      name === 'member' ? 404 : 200);
  } else {
    const person = privateRealm[name];
    for (const [sort, window] of [['best', 'all'], ['top', 'week'], ['top', 'month'], ['top', 'all']]) {
      const params = acting(person); params.set('sort', sort!); params.set('window', window!);
      await answer(person.main('GET', `/v1/realms/${short(privateRealm.realm)}/threads?${params}`), 404);
    }
  }
  // A continuation is bound to the represented reader, not just its ranking coordinates.
  if (name !== 'visitor') {
    const person = publicRealm[name], params = acting(person); params.set('sort', 'best');
    const page = await answer<Page>(person.main('GET', `/v1/realms/${short(publicRealm.realm)}/threads?${params}`));
    expect(page.nextCursor).not.toBeNull();
    const stranger = name === 'stranger' ? publicRealm.member : publicRealm.stranger;
    const stolen = acting(stranger); stolen.set('sort', 'best'); stolen.set('cursor', page.nextCursor!);
    await answer(stranger.main('GET', `/v1/realms/${short(publicRealm.realm)}/threads?${stolen}`), 400);
  }
}

outcomeTest(ranking, 'visitor', () => prove('visitor'));
outcomeTest(ranking, 'stranger', () => prove('stranger'));
outcomeTest(ranking, 'member', () => prove('member'));
outcomeTest(ranking, 'owner', () => prove('owner'));
outcomeTest(ranking, 'moderator', () => prove('moderator'));
outcomeTest(ranking, 'operator', () => prove('operator'));
