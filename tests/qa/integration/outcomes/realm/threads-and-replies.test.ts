import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import threads from '../../../../../scripts/qa/cases/outcomes/realm/threads-and-replies.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

type Work = { work: string; workRevision: string };
type Draft = { reply: string; variantId: string; revisionId: string; revisionDigest: string };
type Reply = Draft & { author: string; rootTarget: string; rootRevision: string; parentReply: string | null; parentRevision: string | null; contextRevision: null };
type Page = { items: { reply: string }[]; nextCursor: string | null; count: { value: number; kind: string; total: null } };
type Branch = {
  focus: string; rootRevision: string; complete: boolean;
  items: { reply: string; parent: string | null; revisionId: string; body: string; author: { id: string } | null }[];
  ancestors: { reply: string }[];
  continuations: { kind: string; reply: string; cursor?: string }[];
};
setDefaultTimeout(420_000);
let publicRealm: PersonaSessions, privateRealm: PersonaSessions;
let work: Work, privateWork: Work, opener: Reply, privateOpener: Reply;
const roots: Reply[] = [], descendants: Reply[] = [];
let preparation: Promise<void> | undefined;
const id = () => `https://rezics.com/id/${randomUUID()}`;
const short = (value: string) => value.slice(-36);
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
    if (response.status !== 409 || attempt === 24) return response;
    const problem = await response.clone().json() as { code: string };
    if (problem.code !== 'read_basis_changed') return response;
    // Concurrent graph receipts expire the read basis. Restart that public
    // read and retain the command key and exact intended revision.
    await answer(person.main('GET', `/v1/works/${short(target.work)}?${acting(person)}`));
  }
}
async function batch<T>(requests: Promise<T>[]) {
  const results = await Promise.allSettled(requests);
  return results.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}
function draftInput(person: PersonaSession, target: Work, realm: string, body: string) {
  return { profile: 'member-reply-draft-v1', reply: id(), variantId: `urn:rezics:variant:${randomUUID()}`,
    rootTarget: target.work, rootRevision: target.workRevision, originRealm: realm,
    language: 'en', direction: 'ltr', expectedHead: null, body, actingSubject: person.actingSubject };
}
async function publish(person: PersonaSession, target: Work, realm: string, body: string, parent: Reply | null = null) {
  const input = draftInput(person, target, realm, body);
  const draft = await answer<Draft>(seedCommand(person, target, '/v1/member-reply-drafts', input), 201);
  const reply: Reply = { ...draft, author: person.actingSubject!, rootTarget: target.work,
    rootRevision: target.workRevision, parentReply: parent?.reply ?? null,
    parentRevision: parent?.revisionId ?? null, contextRevision: null };
  await answer(seedCommand(person, target, '/v1/realm-replies', { profile: 'realm-reply-identity-v1',
    reply: reply.reply, variantId: reply.variantId, revisionId: reply.revisionId, author: reply.author,
    rootTarget: reply.rootTarget, rootRevision: reply.rootRevision, parentReply: reply.parentReply,
    parentRevision: reply.parentRevision, contextRevision: null }), 201);
  const placement = await answer<{ placement: string }>(seedCommand(person, target, '/v1/realm-reply-placements', { profile: 'realm-reply-placement-v1',
    realm, reply: reply.reply, revisionId: reply.revisionId, revisionDigest: reply.revisionDigest,
    reviewDecisionId: null, expectedHead: null, actingSubject: person.actingSubject }), 201);
  return { reply, input, placement: placement.placement };
}
beforeAll(async () => {
  publicRealm = await personaSessions('public');
  privateRealm = await personaSessions('private');
  work = await answer<Work>(publicRealm.owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Original discussion garden', language: 'en',
    authoring: 'own-work', actingSubject: publicRealm.owner.actingSubject }), 201);
  privateWork = await answer<Work>(privateRealm.owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Private discussion garden', language: 'en',
    authoring: 'own-work', actingSubject: privateRealm.owner.actingSubject }), 201);
}, 180_000);
// The sessions and Realm bootstrap must succeed. Bulk population is part of
// the pending proof: the current HTTP persona client loses its bearer window
// before it can finish this inventory. Share its exact refusal across cells.
async function prepare() {
  for (let start = 0; start < 21; start += 8) {
    const prepared = await batch(Array.from({ length: Math.min(8, 21 - start) }, (_, offset) =>
      publish(publicRealm.owner, work, publicRealm.realm,
        `Garden ${start + offset}\nAn original discussion of growing a garden.`)));
    roots.push(...prepared.map(item => item.reply));
  }
  opener = roots[0]!;
  // Both bounds need real placements beyond them, not store inserts or mocked pages.
  for (let start = 0; start < 193; start += 8) {
    const prepared = await batch(Array.from({ length: Math.min(8, 193 - start) }, (_, offset) =>
      publish(publicRealm.owner, work, publicRealm.realm, `Original sibling ${start + offset}.`, opener)));
    descendants.push(...prepared.map(item => item.reply));
  }
  let parent = opener;
  for (let depth = 0; depth < 34; depth++) {
    parent = (await publish(publicRealm.owner, work, publicRealm.realm, `Original depth ${depth}.`, parent)).reply;
    descendants.push(parent);
  }
  privateOpener = (await publish(privateRealm.owner, privateWork, privateRealm.realm,
    'Private garden\nAn original contribution in a private Realm.')).reply;
}
afterAll(async () => { await publicRealm?.close(); });

async function traverse(name: PersonaName) {
  const person = publicRealm[name], params = acting(person);
  await answer(person.main('GET', `/v1/realms/${short(publicRealm.realm)}?${params}`));
  await (preparation ??= prepare());
  params.set('sort', 'new'); params.set('limit', '10');
  const seen: string[] = [];
  let page: Page;
  do {
    page = await answer<Page>(person.main('GET', `/v1/realms/${short(publicRealm.realm)}/threads?${params}`));
    expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
    seen.push(...page.items.map(item => item.reply));
    if (page.nextCursor) params.set('cursor', page.nextCursor);
  } while (page.nextCursor);
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen).toEqual(expect.arrayContaining(roots.map(reply => reply.reply)));
  const read = (reply: string, cursor?: string) => {
    const query = acting(person); query.set('sort', 'new');
    if (cursor) query.set('cursor', cursor);
    return answer<Branch>(person.main('GET', `/v1/realms/${short(publicRealm.realm)}/threads/${short(reply)}?${query}`));
  };
  const first = await read(opener.reply);
  expect(first.complete).toBe(false);
  const pending = first.continuations.filter(item => item.kind !== 'ancestors'), delivered = new Set(first.items.map(item => item.reply));
  const visited = new Set<string>();
  while (pending.length) {
    const next = pending.shift()!, key = JSON.stringify(next);
    expect(visited.has(key), 'A continuation must advance').toBe(false); visited.add(key);
    const branch = await read(next.reply, next.cursor);
    expect(branch.rootRevision).toBe(work.workRevision);
    for (const item of branch.items) {
      delivered.add(item.reply);
      if (item.author) expect(item.author.id).toBe(publicRealm.owner.actingSubject!);
    }
    pending.push(...branch.continuations.filter(item => item.kind !== 'ancestors'));
    expect(visited.size).toBeLessThan(20);
  }
  expect([...delivered].sort()).toEqual([opener, ...descendants].map(reply => reply.reply).sort());
  const last = descendants.at(-1)!;
  const ancestors = new Set<string>();
  let ancestorPage = await read(last.reply);
  expect(ancestorPage.ancestors.length).toBeGreaterThan(0);
  for (;;) {
    ancestorPage.ancestors.forEach(item => ancestors.add(item.reply));
    const next = ancestorPage.continuations.find(item => item.kind === 'ancestors');
    if (!next) break;
    ancestors.add(next.reply);
    ancestorPage = await read(next.reply);
  }
  expect([...ancestors].sort()).toEqual([opener, ...descendants.slice(193, -1)].map(reply => reply.reply).sort());
  const privatePerson = privateRealm[name], query = acting(privatePerson);
  for (const suffix of ['', '/threads', `/threads/${short(privateOpener.reply)}`]) {
    await answer(privatePerson.main('GET', `/v1/realms/${short(privateRealm.realm)}${suffix}?${query}`),
      ['member', 'owner', 'moderator'].includes(name) ? 200 : 404);
  }
  return person;
}
async function denyReview(person: PersonaSession) {
  const before = await answer<Branch>(publicRealm.owner.main('GET',
    `/v1/realms/${short(publicRealm.realm)}/threads/${short(opener.reply)}?${acting(publicRealm.owner)}`));
  await answer(person.main('POST', '/v1/realm-reply-reviews', {
    profile: 'realm-reply-review-v1', realm: publicRealm.realm, reply: opener.reply,
    revisionId: opener.revisionId, revisionDigest: opener.revisionDigest, expectedGeneration: '0',
    supersedes: null, outcome: 'revoked', method: 'human', methodRevision: 'fixture-review-v1',
    dependencyDigest: 'a'.repeat(64), reasonReference: null, actingSubject: person.actingSubject }), 403);
  const after = await answer<Branch>(publicRealm.owner.main('GET',
    `/v1/realms/${short(publicRealm.realm)}/threads/${short(opener.reply)}?${acting(publicRealm.owner)}`));
  expect(after.items).toEqual(before.items);
}
async function ownReply(name: Exclude<PersonaName, 'visitor'>, privateDiscussion = false) {
  const realm = privateDiscussion ? privateRealm : publicRealm, person = realm[name];
  const target = privateDiscussion ? privateWork : work;
  const parent = privateDiscussion ? privateOpener : (await publish(person, target, realm.realm,
    `An original discussion opened by ${name}.`)).reply;
  const { reply, input, placement } = await publish(person, target, realm.realm, `An original reply by ${name}.`, parent);
  const credit = await answer<Reply>(person.main('GET', `/v1/member-replies/${short(reply.reply)}?${acting(person)}`));
  expect(credit).toMatchObject({ author: person.actingSubject, rootTarget: target.work,
    rootRevision: target.workRevision });
  const branch = await answer<Branch>(person.main('GET',
    `/v1/realms/${short(realm.realm)}/threads/${short(reply.reply)}?${acting(person)}`));
  expect(branch.items.find(item => item.reply === reply.reply)?.parent).toBe(parent.reply);
  const key = randomUUID(), edit = { ...input, expectedHead: reply.revisionId, body: `An original revised reply by ${name}.` };
  const saved = await answer<Draft>(person.main('POST', '/v1/member-reply-drafts', edit, key), 201);
  expect(await answer(person.main('POST', '/v1/member-reply-drafts', edit, key))).toMatchObject({ revisionId: saved.revisionId, replayed: true });
  await answer(person.main('POST', '/v1/realm-reply-placements', { profile: 'realm-reply-placement-v1',
    realm: realm.realm, reply: reply.reply, revisionId: saved.revisionId, revisionDigest: saved.revisionDigest,
    reviewDecisionId: null, expectedHead: placement, actingSubject: person.actingSubject }), 201);
  await answer(person.main('POST', '/v1/member-reply-drafts', { ...edit, body: 'Changed intent.' }, key), 409);
  await answer(person.main('POST', '/v1/member-reply-drafts', { ...edit, body: 'A stale edit.' }), 409);
  expect(await answer(person.main('GET', `/v1/member-replies/${short(reply.reply)}?${acting(person)}`))).toMatchObject({ author: person.actingSubject, revisionId: saved.revisionId,
    body: edit.body, rootTarget: target.work, rootRevision: target.workRevision });
}
async function denyOtherAuthor(person: PersonaSession, status = 403) {
  const input = draftInput(publicRealm.owner, work, publicRealm.realm, 'An unauthorized original draft.');
  await answer(person.main('POST', '/v1/member-reply-drafts', input), status);
  await answer(publicRealm.owner.main('GET', `/v1/member-replies/${short(input.reply)}?${acting(publicRealm.owner)}`), 404);
}

outcomeTest(threads, 'visitor', async () => { const person = await traverse('visitor'); await denyOtherAuthor(person, 401); });
outcomeTest(threads, 'stranger', async () => {
  const person = await traverse('stranger'); await ownReply('stranger'); await denyReview(person);
  const input = draftInput(privateRealm.stranger, privateWork, privateRealm.realm, 'Private publication refused.');
  await answer(privateRealm.stranger.main('POST', '/v1/member-reply-drafts', input), 403);
  await answer(privateRealm.owner.main('GET', `/v1/member-replies/${short(input.reply)}?${acting(privateRealm.owner)}`), 404);
});
outcomeTest(threads, 'member', async () => { await traverse('member'); await ownReply('member', true); await denyReview(publicRealm.member); });
outcomeTest(threads, 'owner', async () => { await traverse('owner'); await ownReply('owner', true); });
outcomeTest(threads, 'moderator', async () => { const person = await traverse('moderator'); await ownReply('moderator', true); await denyReview(person); await denyOtherAuthor(person); });
outcomeTest(threads, 'operator', async () => { const person = await traverse('operator'); await ownReply('operator'); await denyReview(person); await denyOtherAuthor(person); });
