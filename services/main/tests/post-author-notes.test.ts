import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { ContentCore, ContentConflict, type SaveDraftCommand } from '../../content/src/core.ts';
import type { Pool } from 'pg';
import { saveAdmittedContentDraft } from '../src/modules/content-publication/draft.ts';
import { assertContentPublicationBody, ContentPublicationConflict, EmptyContentPublicationBody,
  type PublishPinnedContentInput } from '../src/modules/content-publication/publish.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { projectionRecipeFor, extractProjectionText } from '../src/modules/content-publication/projection-recipes.ts';
import type { ExactContentReference } from '../../content/src/core.ts';

const resource = `https://rezics.com/id/${randomUUID()}`;
const actor = `https://rezics.com/id/${randomUUID()}`;
const variant = `urn:rezics:variant:${randomUUID()}`;
const publication: PublishPinnedContentInput = { resourceId: resource, variantId: variant,
  preparationId: randomUUID(), revisionId: randomUUID(), expectedDigest: 'a'.repeat(64),
  expectedContentEpoch: randomUUID(), expectedPublicationHead: null };

test('Post Content publication refuses notes on another model or target, before pinning', async () => {
  const reference = { revisionId: publication.revisionId, resourceId: resource, variantId: variant,
    byteDigest: publication.expectedDigest, model: 'content-shape-v2' };
  const exact = { reference, body: { body: 'Chapter', notes: { after: { body: 'Note' } } } };
  const content = (value = exact) => ({ readExactBatch: async () => [{ ...value, status: 'available' }] }) as unknown as ContentCore;
  const env = (post: boolean) => ({ fuseki: { query: async (query: string) => {
    expect(query).toContain('a rv:Post');
    return { boolean: post };
  } } }) as unknown as WorkActivationEnvironment;
  await expect(assertContentPublicationBody(content(), publication, env(true))).resolves.toBeUndefined();
  await expect(assertContentPublicationBody(content(), publication, env(false))).rejects.toBeInstanceOf(ContentPublicationConflict);
  await expect(assertContentPublicationBody(content(), publication)).rejects.toBeInstanceOf(ContentPublicationConflict);
  await expect(assertContentPublicationBody(content({ ...exact, reference: { ...reference, model: 'content-shape-v1' } }),
    publication, env(true))).rejects.toBeInstanceOf(ContentPublicationConflict);
  await expect(assertContentPublicationBody(content({ ...exact, body: { ...exact.body, body: ' ' } }), publication, env(true)))
    .rejects.toBeInstanceOf(EmptyContentPublicationBody);
});

test('Note bounds and non-Post draft targets fail without creating an admission or saving bytes', async () => {
  const input = { resourceId: resource, variant: { id: variant, resourceId: resource,
    language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const },
  body: 'Chapter', notes: { before: { body: 'Note' } }, expectedHead: null,
  actingSubject: actor, idempotencyKey: randomUUID() };
  const content = { saveDraft: () => { throw new Error('invalid draft saved'); } } as unknown as ContentCore;
  const access = { register: () => { throw new Error('invalid draft admitted'); } } as unknown as AccessAdmissionRegistry;
  const account = { verify: async () => ({ issuer: 'account', subject: 'author' }) };
  const env = { lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
    fuseki: { query: async (query: string) => {
      expect(query).toContain('a rv:Post');
      expect(query).not.toContain('VALUES ?kind');
      return { boolean: false };
    } } } as unknown as WorkActivationEnvironment;
  await expect(saveAdmittedContentDraft(env, content, account, access, new Request('http://main.local'), input))
    .rejects.toBeInstanceOf(ContentConflict);
  await expect(saveAdmittedContentDraft(env, content, account, access, new Request('http://main.local'),
    { ...input, notes: { after: { document: fromPlainText('😀'.repeat(4097)) } } }))
    .rejects.toBeInstanceOf(ContentConflict);
});

test('Content owner rejects notes on v1, replies and contributions, and validates retained v2 projections', async () => {
  const content = new ContentCore({ connect: () => { throw new Error('invalid notes reached storage'); } } as unknown as Pool);
  const base: SaveDraftCommand = { operationId: randomUUID(), variant: { id: variant, resourceId: resource,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' }, expectedHead: null,
  model: 'content-shape-v2', sourceRevision: null, provenance: {},
  serializedJson: JSON.stringify({ body: 'Chapter', notes: { before: { body: 'Note' } } }) };
  for (const model of ['content-shape-v1', 'member-reply-v1', 'text-contribution-v1', 'catalog-description-v1']) {
    await expect(content.saveDraft({ ...base, model })).rejects.toBeInstanceOf(ContentConflict);
  }
  for (const notes of [{ before: { body: 'a'.repeat(8193) } },
    { after: { body: 'Wrong', document: fromPlainText('Right') } }, { before: null }]) {
    await expect(content.saveDraft({ ...base, serializedJson: JSON.stringify({ body: 'Chapter', notes }) }))
      .rejects.toBeInstanceOf(ContentConflict);
  }
});

test('The v2 search recipe uses precisely the same chapter text projection as v1', () => {
  const body = { body: 'Chapter words', notes: { before: { body: 'Unindexed before' }, after: { body: 'Unindexed after' } } };
  for (const model of ['content-shape-v1', 'content-shape-v2']) {
    const recipe = projectionRecipeFor(model);
    if (recipe.kind !== 'text') throw new Error('Missing Content text recipe');
    expect(extractProjectionText(recipe, body, { model, language: { kind: 'tag', tag: 'en' } } as ExactContentReference))
      .toEqual({ text: 'Chapter words', language: 'en' });
  }
});
