import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { originalRecipe, fixtureAnswer as answer, short, type RecipeWork }
  from '../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { personaNames, personaSessions, type PersonaSession, type PersonaSessions } from '../support/personas.ts';
import { comparableBody } from '../support/hidden-id-equality.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/store.ts';

setDefaultTimeout(180_000);
let sessions: PersonaSessions, recipe: RecipeWork, hidden: RecipeWork;
type Draft = { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } };
type ContentFixture = { resource: string; variant: string; source: Draft; draft: Draft; privateHead: Draft; comment: string; cursor: string };
let contents: ContentFixture[];
let ownerCursor: string;
let privateMainRevision: string;
const secret = `privaterevision${randomUUID().replaceAll('-', '')}`;
const actor = (person: PersonaSession) => person.actingSubject ? { actingSubject: person.actingSubject } : {};
const query = (person: PersonaSession, extra: Record<string, string> = {}) =>
  `?${new URLSearchParams({ ...actor(person), ...extra })}`;

async function content(resource: string, variant = `urn:rezics:variant:${randomUUID()}`): Promise<ContentFixture> {
  const owner = sessions.owner;
  const fields = { profile: 'content-text-v1', resourceId: resource, variantId: variant,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: owner.actingSubject };
  const draft = await answer<Draft>(owner.main('POST', '/v1/content-drafts', {
    ...fields, expectedHead: null, body: `${secret}\nSecond private paragraph.`,
  }), 201);
  const publication = await answer<{ decision: string }>(owner.main('POST', '/v1/content-publications', {
    profile: 'content-publication-v1', resourceId: resource, variantId: variant, revisionId: draft.revisionId,
    preparationId: randomUUID(), expectedDigest: draft.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch,
    expectedPublicationHead: null, actingSubject: owner.actingSubject,
  }), 201);
  const eligibility = await answer<{ decision: string }>(owner.main('POST', '/v1/content-search-eligibility', {
    profile: 'content-search-eligibility-v1', resourceId: resource, variantId: variant,
    publicationDecision: publication.decision, expectedEligibilityHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: owner.actingSubject,
  }), 201);
  const comments: string[] = [];
  for (let index = 0; index < 2; index++) {
    const saved = await answer<{ comment: string }>(owner.main('POST', '/v1/content-comments', {
      profile: 'content-paragraph-comment-v1', resourceId: resource, revisionId: draft.revisionId, exact: secret,
      body: `Private review ${index}`, actingSubject: owner.actingSubject,
    }), 201);
    comments.push(saved.comment);
  }
  const page = await answer<{ next: string | null }>(owner.main('GET',
    `/v1/content-revisions/${draft.revisionId}/comments${query(owner, { pageSize: '1' })}`));
  expect(page.next).toBeString();
  // A formerly public quote becomes private when the exact selected publication moves.
  const source = await answer<Draft>(owner.main('POST', '/v1/content-drafts', {
    ...fields, expectedHead: draft.revisionId, body: 'Published original instructions.',
  }), 201);
  const replacement = await answer<{ decision: string }>(owner.main('POST', '/v1/content-publications', {
    profile: 'content-publication-v1', resourceId: resource, variantId: variant, revisionId: source.revisionId,
    preparationId: randomUUID(), expectedDigest: source.byteDigest, expectedContentEpoch: source.sourcePosition.dataEpoch,
    expectedPublicationHead: publication.decision, actingSubject: owner.actingSubject,
  }), 201);
  await answer(owner.main('POST', '/v1/content-search-eligibility', {
    profile: 'content-search-eligibility-v1', resourceId: resource, variantId: variant,
    publicationDecision: replacement.decision, expectedEligibilityHead: eligibility.decision,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: owner.actingSubject,
  }), 201);
  const privateHead = await answer<Draft>(owner.main('POST', '/v1/content-drafts', {
    ...fields, expectedHead: source.revisionId, body: `${secret} unpublished successor`,
  }), 201);
  return { resource, variant, source, draft, privateHead, comment: comments[0]!, cursor: page.next! };
}

beforeAll(async () => {
  sessions = await personaSessions('public');
  recipe = await originalRecipe(sessions.owner, 'Published disclosure recipe', { laterDraft: true });
  hidden = await originalRecipe(sessions.owner, secret, { published: false });
  privateMainRevision = (await answer<{ mainVersionRevision: string }>(sessions.owner.main('GET',
    `/v1/works/${short(hidden.work)}${query(sessions.owner)}`))).mainVersionRevision;
  const owner = sessions.owner;
  const book = await answer<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Public Content custody', language: 'en', authoring: 'own-work',
    semanticTypes: ['https://schema.org/Book'], actingSubject: owner.actingSubject,
  }), 201);
  const composition = await answer<{ structure: string; revision: string }>(owner.main('POST', '/v1/compositions', {
    profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: owner.actingSubject,
  }), 201);
  const post = await answer<{ post: string; variantId: string }>(owner.main('POST', `/v1/works/${short(book.work)}/chapters`, {
    profile: 'book-chapter-create-v1', title: 'Public post with private successor', language: 'en', direction: 'ltr',
    parent: composition.structure, position: 'last', expectedCompositionHead: composition.revision, actingSubject: owner.actingSubject,
  }));
  contents = [await content(recipe.work), await content(post.post, post.variantId)];
  const page = await answer<{ next: string | null }>(owner.main('GET',
    `/v1/compositions/${short(recipe.structure)}/revisions/${short(recipe.draftRevision!)}${query(owner, { limit: '1' })}`));
  expect(page.next).toBeString(); ownerCursor = page.next!;
}, 240_000);
afterAll(async () => { await sessions?.close(); });

for (const name of personaNames) {
  test(`${name}: private Work, Recipe revisions, occurrences, counts, exports and transferred continuations`, async () => {
    const person = sessions[name], permitted = name === 'owner';
    for (const path of [
      `/v1/works/${short(hidden.work)}`,
      `/v1/compositions/${short(hidden.structure)}`,
      `/v1/compositions/${short(recipe.structure)}/revisions/${short(recipe.draftRevision!)}`,
      `/v1/compositions/${short(recipe.structure)}/occurrences/${short(recipe.occurrenceIds[0]!)}?revision=${encodeURIComponent(recipe.draftRevision!)}`,
      `/v1/recipes/works/${short(recipe.work)}?revision=${encodeURIComponent(recipe.draftRevision!)}`,
    ]) {
      const url = new URL(path, 'http://main.local');
      if (person.actingSubject) url.searchParams.set('actingSubject', person.actingSubject);
      const response = await person.main('GET', url.pathname + url.search);
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(permitted ? 200 : 404);
      if (!permitted) expect(await response.text()).not.toContain(secret);
    }
    const continued = await person.main('GET',
      `/v1/compositions/${short(recipe.structure)}/revisions/${short(recipe.draftRevision!)}${query(person, { limit: '1', after: ownerCursor })}`);
    expect(continued.status).toBe(permitted ? 200 : 404);
    for (const format of ['native', 'schema-org']) {
      const path = `/v1/recipes/${short(recipe.structure)}/export`;
      const response = await person.main('GET', path + query(person, { revision: recipe.draftRevision!, format }));
      expect(response.status).toBe(permitted ? 200 : name === 'visitor' ? 401 : 404);
      if (!permitted) {
        const missing = await person.main('GET', path + query(person, { revision: `https://rezics.com/id/${randomUUID()}`, format }));
        expect(missing.status).toBe(response.status);
        expect(comparableBody(await response.text())).toBe(comparableBody(await missing.text()));
      }
    }
    const publicPage = await answer<{ revision: string; occurrences: unknown[] }>(person.main('GET',
      `/v1/recipes/works/${short(recipe.work)}${query(person)}`));
    expect(publicPage.revision).toBe(recipe.revision);
    expect(JSON.stringify(publicPage)).not.toContain('PRIVATE DRAFT parsley');
    expect(Object.hasOwn(publicPage, 'placementCount')).toBe(false);
  });

  for (const [index, grain] of ['Work', 'Post'].entries()) {
    for (const probe of ['retired revision', 'draft head', 'derivations', 'validator', 'reference',
      'comment', 'comment page', 'comment continuation'] as const) {
      test(`${name}: ${grain} private Content ${probe} requires exact authority`, async () => {
      const person = sessions[name], permitted = name === 'owner', fixture = contents[index]!;
      const exactPath = `/v1/content-revisions/${fixture.draft.revisionId}`;
      if (probe === 'reference') {
        const reference = { target: fixture.resource, selector: { grain: 'content', variantId: fixture.variant,
          revision: fixture.draft.revisionId } };
        const resolved = await answer<{ items: { status: string }[] }>(person.main('POST', '/v1/resource-reference-resolutions', {
          references: [reference], ...actor(person),
        }));
        expect(resolved.items[0]!.status).toBe(permitted ? 'available' : 'unavailable');
        if (!permitted) expect(JSON.stringify(resolved)).not.toContain(secret);
        return;
      }
      const comment = probe.startsWith('comment');
      const suffix = probe === 'derivations' ? '/derivations' : comment ? '/comments' : '';
      const path = probe === 'comment' ? `/v1/content-comments/${short(fixture.comment)}`
        : probe === 'draft head' ? `/v1/content-revisions/${fixture.privateHead.revisionId}` : exactPath + suffix;
      const url = new URL(path, 'http://main.local');
      if (person.actingSubject || comment) {
        // Required identity syntax must not turn a signed-out probe into validation-only coverage.
        url.searchParams.set('actingSubject', person.actingSubject ?? sessions.owner.actingSubject!);
      }
      if (probe === 'comment continuation') {
        url.searchParams.set('cursor', fixture.cursor); url.searchParams.set('pageSize', '1');
      }
      const response = await person.main('GET', url.pathname + url.search, undefined, undefined,
        probe === 'validator' ? { headers: { 'if-none-match': `"${fixture.draft.byteDigest}"` } } : undefined);
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(permitted ? 200 : name === 'visitor' && comment ? 401 : 404);
      if (probe === 'validator') expect(response.headers.get('etag')).toBeNull();
      if (!permitted) {
        expect(await response.clone().text()).not.toContain(secret);
        const missingPath = probe === 'comment' ? `/v1/content-comments/${randomUUID()}`
          : `/v1/content-revisions/${randomUUID()}${suffix}`;
        const missing = await person.main('GET', missingPath + url.search);
        expect(missing.status).toBe(response.status);
        expect(comparableBody(await response.text())).toBe(comparableBody(await missing.text()));
      }
      });
    }
  }

  test(`${name}: the selected public Work and Post Content stays readable after drafts`, async () => {
    const person = sessions[name];
    for (const fixture of contents) {
      const published = await answer<{ reference: { revisionId: string } }>(person.main('GET',
        `/v1/content-revisions/${fixture.source.revisionId}${query(person)}`));
      expect(published.reference.revisionId).toBe(fixture.source.revisionId);
    }
  });

  test(`${name}: public search counts and notification payloads omit unpublished text`, async () => {
    const person = sessions[name];
    const search = await answer<{ total: number; results: unknown[] }>(person.main('POST', '/v1/queries', {
      profile: 'public-disclosed-fields-phrase-v1', phrase: secret, resources: [hidden.work, ...contents.map(item => item.resource)],
      contexts: [], statements: [], mediaContext: DEFAULT_MEDIA_CONTEXT, language: 'en',
    }));
    expect(search.total).toBe(0); expect(search.results).toEqual([]);
    expect(JSON.stringify(search)).not.toContain(secret);
    for (const profile of ['public-content-phrase-v1', 'public-main-phrase-v1']) {
      const matches = await answer<{ total: number; results: unknown[] }>(person.main('POST', '/v1/queries', {
        profile, phrase: secret, language: 'en',
      }));
      expect(matches.total).toBe(0); expect(matches.results).toEqual([]);
      expect(JSON.stringify(matches)).not.toContain(secret);
    }
    const suggestions = await answer<{ items: unknown[]; hasMore: boolean }>(person.main('GET',
      `/v1/search/typeahead?${new URLSearchParams({ prefix: secret, language: 'en' })}`));
    expect(suggestions.items).toEqual([]); expect(suggestions.hasMore).toBe(false);
    const inbox = await person.main('GET', '/v1/me/notifications');
    expect(inbox.status).toBe(name === 'visitor' ? 401 : 200);
    const body = await inbox.text();
    expect(body).not.toContain(secret);
    for (const fixture of contents) expect(body).not.toContain(fixture.draft.revisionId);
  });

  test(`${name}: public Main Version provenance does not confirm a private revision even when its inventory is empty`, async () => {
    const person = sessions[name];
    for (const suffix of ['translation-links', 'work-derivations']) {
      const path = `/v1/main-versions/${short(hidden.mainVersion)}/revisions/${short(privateMainRevision)}/${suffix}`;
      // These public-only operations accept no acting identity, including for the owner.
      const response = await person.main('GET', path);
      const missing = await person.main('GET', `/v1/main-versions/${randomUUID()}/revisions/${randomUUID()}/${suffix}`);
      expect(response.status, await response.clone().text()).toBe(404);
      expect(missing.status).toBe(404);
      expect(comparableBody(await response.text())).toBe(comparableBody(await missing.text()));
    }
  });
}
