import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaSessions, type PersonaSession } from '../support/personas.ts';
import { grantPersonaFixtureAuthority } from '../support/persona-fixture-authority.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const short = (value: string) => value.slice(-36);
type Vocabulary = { scheme: string; schemeHead: string; concept: string; conceptHead: string };
type Reply = { reply: string; variantId: string; revisionId: string; revisionDigest: string };

async function answer<T>(request: Promise<Response>, status = 201): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}

test('Realm board placement preserves two Concepts, manager moves, clearing and retirement through the public API', async () => {
  const sessions = await personaSessions('public');
  try {
    const { owner, member, moderator, visitor, operator } = sessions;
    await grantPersonaFixtureAuthority(owner, [
      { scope: 'classification:define:global', action: 'classification.proposition.define' },
    ]);
    const labels = (value: string) => ({ labels: [{ language: 'en', value }], alternativeLabels: [], broader: [], narrower: [] });
    const news = await answer<Vocabulary>(owner.main('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: null, ...labels(`News ${randomUUID()}`),
      actingSubject: owner.actingSubject,
    }));
    const other = await answer<Vocabulary>(owner.main('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: { id: news.scheme, expectedHead: news.schemeHead },
      ...labels(`Other board ${randomUUID()}`), actingSubject: owner.actingSubject,
    }));
    const work = await answer<{ work: string; workRevision: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: 'Board placement discussion', language: 'en', authoring: 'own-work',
      actingSubject: owner.actingSubject,
    }));
    const draft = await answer<{ contribution: string; draftRevision: string }>(owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en', body: 'An original story about a garden.',
      actingSubject: owner.actingSubject,
    }));
    const publication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: owner.actingSubject,
    }));
    await answer(owner.main('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1', work: work.work, contribution: draft.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
      context: { kind: 'main-version-default', id: work.mainVersion }, selectionBasis: 'main-maintainer',
      actingSubject: owner.actingSubject,
    }));
    const refresh = () => answer(member.main('GET', `/v1/works/${short(work.work)}?${new URLSearchParams({
      actingSubject: member.actingSubject!,
    })}`), 200);
    async function publish(path: string, input: unknown) {
      for (let attempt = 0; ; attempt++) {
        const response = await member.main('POST', path, input, randomUUID());
        if (response.status !== 409 || attempt === 5
          || (await response.clone().json() as { code: string }).code !== 'read_basis_changed') return response;
        await refresh();
      }
    }
    await refresh();
    const reply = await answer<Reply>(publish('/v1/member-reply-drafts', {
      profile: 'member-reply-draft-v1', reply: id(), variantId: `urn:rezics:variant:${randomUUID()}`,
      rootTarget: work.work, rootRevision: work.workRevision, originRealm: sessions.realm,
      language: 'en', direction: 'ltr', expectedHead: null, body: 'A discussion\nOriginal words about the garden.',
      actingSubject: member.actingSubject,
    }));
    await answer(publish('/v1/realm-replies', {
      profile: 'realm-reply-identity-v1', reply: reply.reply, variantId: reply.variantId, revisionId: reply.revisionId,
      author: member.actingSubject, rootTarget: work.work, rootRevision: work.workRevision,
      parentReply: null, parentRevision: null, contextRevision: null,
    }));
    const placement = { profile: 'realm-reply-placement-v1', realm: sessions.realm, reply: reply.reply,
      revisionId: reply.revisionId, revisionDigest: reply.revisionDigest, reviewDecisionId: null };
    let head = (await answer<{ placement: string }>(publish('/v1/realm-reply-placements', {
      ...placement, expectedHead: null, actingSubject: member.actingSubject,
    }))).placement;
    const input = (person: PersonaSession, concepts: string[], primaryConcept: string | null) => ({
      ...placement, expectedHead: head, actingSubject: person.actingSubject ?? member.actingSubject, concepts, primaryConcept,
    });
    async function place(person: PersonaSession, concepts: string[], primaryConcept: string | null) {
      const saved = await answer<{ placement: string; concepts: string[]; primaryConcept: string | null }>(
        person.main('POST', '/v1/realm-reply-placements', input(person, concepts, primaryConcept)));
      expect(saved.concepts).toEqual([...concepts].sort());
      expect(saved.primaryConcept).toBe(primaryConcept);
      head = saved.placement;
    }
    async function board(concept: string, replies: string[]) {
      const page = await answer<{ items: { reply: string }[]; count: { value: number }; nextCursor: string | null }>(
        visitor.main('GET', `/v1/realms/${short(sessions.realm)}/threads?${new URLSearchParams({ concept, sort: 'new', limit: '1' })}`), 200);
      expect(page.items.map(item => item.reply)).toEqual(replies);
      expect(page.count.value).toBe(replies.length);
      expect(page.nextCursor).toBeNull();
    }
    await place(member, [news.concept, other.concept], news.concept);
    await board(news.concept, [reply.reply]);
    await board(other.concept, [reply.reply]);
    await answer(visitor.main('POST', '/v1/realm-reply-placements', input(visitor, [], null)), 401);
    await answer(operator.main('POST', '/v1/realm-reply-placements', input(operator, [], null)), 403);
    await place(owner, [other.concept], other.concept);
    await board(news.concept, []);
    await board(other.concept, [reply.reply]);
    await place(moderator, [], null);
    await board(other.concept, []);
    await answer(owner.main('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', concept: { id: news.concept, expectedHead: news.conceptHead },
      state: 'retired', actingSubject: owner.actingSubject,
    }));
    await answer(visitor.main('GET', `/v1/realms/${short(sessions.realm)}/threads?${new URLSearchParams({
      concept: news.concept, sort: 'new', limit: '1',
    })}`), 404);
  } finally { await sessions.close(); }
}, 180_000);
