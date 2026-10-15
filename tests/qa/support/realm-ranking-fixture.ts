import { randomUUID } from 'node:crypto';
import type { PersonaSession, PersonaSessions } from './personas.ts';
import type { ClosureOriginal } from '../integration/outcomes/realm/closure-original-credit-setup.ts';

type Work = { work: string; workRevision: string; mainVersion: string };
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => new URLSearchParams(person.actingSubject ? { actingSubject: person.actingSubject } : {});
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, raw = await response.text();
  if (response.status !== status) throw new Error(`Ranking fixture expected ${status}, got ${response.status}: ${raw}`);
  return JSON.parse(raw) as T;
}
async function command(person: PersonaSession, target: Work, path: string, input: unknown) {
  const key = randomUUID();
  for (let attempt = 0; ; attempt++) {
    const response = await person.main('POST', path, input, key);
    if (response.status !== 409 || attempt === 24) return response;
    const problem = await response.clone().json() as { code: string };
    if (problem.code !== 'read_basis_changed') return response;
    await answer(person.main('GET', `/v1/works/${short(target.work)}?${acting(person)}`));
  }
}
export async function seedRealmRanking(sessions: PersonaSessions, size: number, label: string) {
  const person = sessions.owner, author = person.actingSubject!;
  const target = await answer<Work>(person.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: `Original ${label} ranking garden`, language: 'en',
    authoring: 'own-work', actingSubject: author }), 201);
  const contribution = await answer<{ contribution: string; draftRevision: string }>(person.main('POST', '/v1/contributions', {
    profile: 'text-contribution-v1', work: target.work, language: 'en',
    body: 'An original essay about the ranking discussion garden.', actingSubject: author }), 201);
  const publication = await answer<{ publicationDecision: string }>(person.main('POST', '/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: contribution.contribution,
    expectedDraftHead: contribution.draftRevision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: author }), 201);
  await answer(person.main('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', work: target.work, contribution: contribution.contribution,
    publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
    context: { kind: 'main-version-default', id: target.mainVersion }, selectionBasis: 'main-maintainer',
    actingSubject: author }), 201);
  const replies: string[] = [];
  const create = async (index: number) => {
    const reply = `https://rezics.com/id/${randomUUID()}`, variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = await answer<{ revisionId: string; revisionDigest: string }>(command(person, target, '/v1/member-reply-drafts', {
      profile: 'member-reply-draft-v1', reply, variantId, rootTarget: target.work,
      rootRevision: target.workRevision, originRealm: sessions.realm, language: 'en', direction: 'ltr',
      expectedHead: null, body: `Original ${label} thread ${index}\nA synthetic discussion authored for this ranking proof.`,
      actingSubject: author }), 201);
    await answer(command(person, target, '/v1/realm-replies', {
      profile: 'realm-reply-identity-v1', reply, variantId, revisionId: draft.revisionId,
      author, rootTarget: target.work, rootRevision: target.workRevision,
      parentReply: null, parentRevision: null, contextRevision: null }), 201);
    await answer(command(person, target, '/v1/realm-reply-placements', {
      profile: 'realm-reply-placement-v1', realm: sessions.realm, reply,
      revisionId: draft.revisionId, revisionDigest: draft.revisionDigest,
      reviewDecisionId: null, expectedHead: null, actingSubject: author }), 201);
    return reply;
  };
  // Identity root reads and placement commands share the native graph writer.
  // These small cursor inventories must not queue concurrent graph commands.
  for (let index = 0; index < size; index++) replies.push(await create(index));
  return replies;
}

export async function prepareRealmRankingStates(sessions: PersonaSessions) {
  // The QA planner imports the source's cost contract outside Bun's test
  // runner; load helpers with test hooks only when actually building data.
  const { publishClosureOriginals } = await import('../integration/outcomes/realm/closure-original-credit-setup.ts');
  const founder = sessions.stranger;
  const realms: string[] = [];
  for (const state of ['empty', 'moved']) {
    const created = await answer<{ realm: string }>(founder.main('POST', '/v1/spaces', {
      profile: 'space-realm-v2', name: `Original ${state} ranking garden`, language: 'en',
      handle: `ranking-${randomUUID().slice(0, 12)}`, capabilities: ['realm'], actingSubject: founder.actingSubject,
      initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open',
        whoMaySubmit: 'members', selfJoin: false, rules: [] },
    }), 201);
    realms.push(created.realm);
  }
  await seedRealmRanking({ ...sessions, owner: founder, realm: realms[1]! }, 21, 'moving');
  const originals: ClosureOriginal[] = [];
  await publishClosureOriginals(sessions, originals, `Rankinggarden${randomUUID().replaceAll('-', '')}`, 12);
  for (const original of originals) await answer(sessions.owner.main('PUT',
    `/v1/works/${short(original.work)}/progress`, {
      actingSubject: sessions.owner.actingSubject, expectedVersion: 0, standing: 'started',
    }));
  return { emptyRealm: realms[0]!, movedRealm: realms[1]! };
}
