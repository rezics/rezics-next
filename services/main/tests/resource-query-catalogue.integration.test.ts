import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { createMainApp } from '../src/app.ts';
import { DiscoveryProjection } from '../src/modules/discovery/store.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../src/modules/recommendation/derived-generation.ts';
import { selectRealmLocal, realmSelectionDigest } from '../src/modules/work/select-realm.ts';
import type { ResourceCard, ResourceListQuery } from '../src/modules/query/resource-contract.ts';
import { LIST_COST } from '../src/api-list.ts';
import { startHomeStack } from '../../../tests/qa/integration/feed-read-support.ts';
import { advanceQueryPopulation } from './g-1053-query-fixture.ts';

type Page = { items: ResourceCard[]; nextCursor: string | null; complete: boolean;
  count: { value: number; kind: 'exact' | 'at-least' } };

test('public resource Query composes semantic and Content owners, Realm scope and unchanged mixed-source continuations', async () => {
  const home = await startHomeStack('resource-query-catalogue', { projectionStart: 'current', profileCredits: true });
  const { stack, author } = home;
  const discovery = new DiscoveryProjection(stack.accessPool);
  const app = createMainApp(stack.fuseki, { ...home.deps, discovery });
  const command = async <T>(path: string, body: object, expected = 200) => home.json<T>(await app.handle(new Request(
    `http://main.local${path}`, { method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Bearer ${author.token}`, 'idempotency-key': randomUUID() }, body: JSON.stringify(body) })), expected);
  const query = async (input: ResourceListQuery, token?: string) => home.json<{ result: Page }>(await app.handle(new Request(
    'http://main.local/v1/query', { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'en',
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input) })));
  try {
    const phrase = `Genericquery${randomUUID().replaceAll('-', '')}`;
    const work = await stack.publicWork(author.actor, ['en'], `${phrase} Work`, ['https://schema.org/Book']);
    await author.grant('semantic:create:root', 'semantic.change');
    const semantic = async (type: string, label: string, parent?: string) => command<{ component: string }>(
      '/v1/semantic/changes', { profile: 'semantic-change-v1', actingSubject: author.actor, expectedHead: null,
        state: { component: 'resource', types: [type], properties: [
          { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: label, language: 'en' } },
          ...(parent ? [{ predicate: 'https://rezics.com/vocab/semanticWork', value: { kind: 'resource', ref: parent } }] : []),
        ] } }, 201);
    const character = await semantic('https://rezics.com/vocab/Character', `${phrase} Character`, work.work);
    const title = await semantic('https://rezics.com/vocab/Title', `${phrase} Title`, work.work);
    const hidden = await semantic('https://rezics.com/vocab/Character', `${phrase} hidden`);
    // A reader can hold a private semantic grant without making a public
    // catalogue query use it as a disclosure or membership grant.
    await author.grant(`semantic:read:${hidden.component}`, 'semantic.read');
    await author.grant('work:create:root', 'work.create');
    const post = await command<{ post: string; variantId: string; revisionId: string }>('/v1/posts', {
      profile: 'authored-post-v1', title: { value: `${phrase} Discussion`, language: 'en' }, language: 'en',
      document: fromPlainText('An independently published discussion.', 'blocks'), actingSubject: author.actor,
    }, 201);
    await author.grant(`content:draft:${post.post}`, 'content.draft');
    const saved = await command<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      '/v1/content-drafts', { profile: 'content-text-v1', resourceId: post.post, variantId: post.variantId,
        expectedHead: post.revisionId, language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
        body: 'An independently published discussion.', actingSubject: author.actor }, 201);
    await author.grant(`content:publish:${post.post}`, 'content.publish');
    const publication = await command<{ decision: string }>('/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: `query-${randomUUID()}`, revisionId: saved.revisionId,
      expectedDigest: saved.byteDigest, expectedContentEpoch: saved.sourcePosition.dataEpoch,
      resourceId: post.post, variantId: post.variantId, expectedPublicationHead: null, actingSubject: author.actor,
    }, 201);
    await author.grant(`content:search-eligibility:${post.post}`, 'content.search-eligibility');
    await command('/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1', resourceId: post.post,
      variantId: post.variantId, publicationDecision: publication.decision, expectedEligibilityHead: null,
      actingSubject: author.actor, rightsBasis: 'original-contribution', disclosure: 'public' }, 201);
    await author.grant('space:create:root', 'space.create');
    const realm = await command<{ realm: string }>('/v1/spaces', { profile: 'space-realm-v1', name: `${phrase} community`,
      capabilities: ['realm'], actingSubject: author.actor, initialSettings: { visibility: 'public', reviewRequired: false,
        reviewMode: 'open', whoMaySubmit: 'members', selfJoin: true, rules: [] } }, 201);
    const adoption = { context: { kind: 'realm-local' as const, id: realm.realm }, work: work.work, mainVersion: work.mainVersion,
      contribution: work.variants[0]!.contribution, publicationDecision: work.variants[0]!.decision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review' as const, actingSubject: author.actor };
    expect((await selectRealmLocal(stack.env, stack.admission(author.actor, `publication:adopt:${realm.realm}`,
      'publication.adopt', realmSelectionDigest(adoption)), adoption)).outcome).toBe('succeeded');
    await author.grant(MANAGE_SCOPE, MANAGE_ACTION);
    for (const basis of [{ scope: 'global', realm: null, context: null }, { scope: 'realm', realm: realm.realm, context: null }]) {
      let generation = await command<{ generation: string; checkpoint: string; complete: boolean }>('/v1/discovery/generation-builds',
        { profile: 'discovery-generation-build-v1', actingSubject: author.actor, basis });
      while (!generation.complete) generation = await advanceQueryPopulation(home, discovery, generation, [work.work]);
      await command('/v1/discovery/generation-activations', { profile: 'discovery-generation-activation-v1',
        actingSubject: author.actor, generation: generation.generation, expectedHeadRevision: null });
    }
    const base: ResourceListQuery = { profile: 'resource-list-v1', context: 'global', scope: { kind: 'all' }, sort: 'newest', limit: 20 };
    for (const token of [undefined, author.token]) {
      expect((await query(base, token)).result.items.length).toBeGreaterThan(0);
      for (const sort of ['newest', 'updated', 'relevance'] as const) {
        const result = (await query({ ...base, q: phrase, sort }, token)).result;
        for (const id of [character.component, title.component, post.post])
          expect(result.items.find(item => item.id === id)).toMatchObject({ kind: 'resource' });
        expect(result.items.some(item => item.id === hidden.component)).toBe(false);
      }
    }
    const scoped = (await query({ ...base, context: { realm: realm.realm }, scope: { kind: 'realm', realm: realm.realm }, q: phrase })).result;
    for (const id of [work.work, realm.realm, character.component, title.component]) expect(scoped.items.map(item => item.id)).toContain(id);
    const seen = new Set<string>();
    let cursor: string | undefined;
    let complete = false;
    for (let pageNumber = 0; pageNumber < 64; pageNumber++) {
      const page = (await query({ ...base, q: phrase, limit: 1, ...(cursor ? { cursor } : {}) })).result;
      for (const item of page.items) { expect(seen.has(item.id)).toBe(false); seen.add(item.id); }
      expect(page.count).toEqual({ value: seen.size, kind: page.complete ? 'exact' : 'at-least' });
      if (page.complete) { expect(page.nextCursor).toBeNull(); complete = true; break; }
      expect(page.nextCursor).not.toBe(cursor ?? null);
      expect(page.nextCursor!.length).toBeLessThanOrEqual(LIST_COST.cursorCharacters);
      cursor = page.nextCursor!;
    }
    expect(complete).toBe(true);
    for (const id of [work.work, realm.realm, character.component, title.component, post.post]) expect(seen.has(id)).toBe(true);
    expect(seen.has(hidden.component)).toBe(false);
  } finally { await home.stop(); }
});
