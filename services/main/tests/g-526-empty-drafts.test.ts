import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ContentConflict, type ContentCore } from '../../content/src/core.ts';
import type { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { saveAdmittedContentDraft } from '../src/modules/content-publication/draft.ts';
import { publishAdmittedContent } from '../src/modules/content-publication/publish-admitted.ts';
import { assertContentPublicationBody, ContentPublicationConflict, EmptyContentPublicationBody, type PublishPinnedContentInput }
  from '../src/modules/content-publication/publish.ts';
import { InvalidContributionInput, textContributionDigest } from '../src/modules/contribution/draft.ts';
import { textContributionEditDigest } from '../src/modules/contribution/edit.ts';
import { publishAdmittedTextContribution } from '../src/modules/contribution/publish-admitted.ts';
import { RevisionNotFound } from '../src/modules/work/history.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const resource = `https://rezics.com/id/${randomUUID()}`;
const actor = `https://rezics.com/id/${randomUUID()}`;
const variant = `urn:rezics:variant:${randomUUID()}`;
const currentWorkType = { results: { bindings: [{ type: { type: 'uri', value: 'https://schema.org/CreativeWork' } }] } };

test('G-526: both Contribution digest contracts distinguish empty text from absent or non-string bodies', () => {
  const create = { work: resource, language: 'en', actingSubject: actor, body: '' };
  const edit = { contribution: resource, expectedHead: actor, actingSubject: actor, body: '' };
  expect(textContributionDigest(create)).toMatch(/^[0-9a-f]{64}$/);
  expect(textContributionEditDigest(edit)).toMatch(/^[0-9a-f]{64}$/);
  expect(textContributionDigest(create)).not.toBe(textContributionDigest({ ...create, body: ' ' }));
  for (const body of [undefined, null, 0, false, {}, [], '\0', '字'.repeat(21_846)]) {
    expect(() => textContributionDigest({ ...create, body: body as string })).toThrow(InvalidContributionInput);
    expect(() => textContributionEditDigest({ ...edit, body: body as string })).toThrow(InvalidContributionInput);
  }
});

test('G-526: Content draft input retains its type and character limit before verifying or admitting', async () => {
  const input = { resourceId: resource, variant: { id: variant, resourceId: resource,
    language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const },
    expectedHead: null, actingSubject: actor, idempotencyKey: randomUUID(), body: '' };
  for (const body of [undefined, null, 0, false, {}, [], '字'.repeat(65_537)]) {
    await expect(saveAdmittedContentDraft({} as WorkActivationEnvironment, {} as ContentCore,
      { verify: async () => { throw new Error('invalid input reached Account'); } },
      {} as AccessAdmissionRegistry, new Request('http://main.local'), { ...input, body: body as string }))
      .rejects.toBeInstanceOf(ContentConflict);
  }
});

test('G-526: empty publication reads one exact revision and creates no admission or Content preparation', async () => {
  const input: PublishPinnedContentInput = { preparationId: randomUUID(), revisionId: randomUUID(),
    expectedDigest: 'b'.repeat(64), expectedContentEpoch: randomUUID(), resourceId: resource,
    variantId: variant, expectedPublicationHead: null };
  const reads: string[][] = [];
  const content = { owningResourceForRevision: async () => resource, readExactBatch: async (ids: string[]) => {
    reads.push(ids);
    return [{ status: 'available', reference: { revisionId: input.revisionId, resourceId: resource, variantId: variant,
      byteDigest: input.expectedDigest }, body: { body: '' } }];
  }, preparePublication: () => { throw new Error('empty body created a pin'); } } as unknown as ContentCore;
  const env = { lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
    fuseki: { query: async (query: string) => query.includes('SELECT DISTINCT ?type')
      ? currentWorkType : { boolean: true } } } as unknown as WorkActivationEnvironment;
  const access = { canReadWork: async () => true, register: () => { throw new Error('empty body created an admission'); } } as unknown as AccessAdmissionRegistry;
  await expect(publishAdmittedContent(env, content,
    { verify: async () => ({ issuer: 'https://account.test', subject: randomUUID() }) }, access,
    new Request('http://main.local'), { ...input, actingSubject: actor, idempotencyKey: randomUUID() }))
    .rejects.toBeInstanceOf(EmptyContentPublicationBody);
  expect(reads).toEqual([[input.revisionId]]);
});


test('G-526: non-readers cannot load private bodies or create a publication admission', async () => {
  const env = { lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
    fuseki: { query: async (query: string) => {
      if (query.includes('SELECT DISTINCT ?type')) return currentWorkType;
      if (query.includes('SELECT')) throw new Error('non-reader looked up a Contribution revision');
      return { boolean: true };
    } } } as unknown as WorkActivationEnvironment;
  const access = { canReadWork: async () => false, canReadContributionDraft: async () => false,
    register: () => { throw new Error('non-reader created an admission'); } } as unknown as AccessAdmissionRegistry;
  const content = { owningResourceForRevision: () => { throw new Error('non-reader looked up a Content revision'); },
    readExactBatch: () => { throw new Error('non-reader loaded Content bytes'); } } as unknown as ContentCore;
  const account = { verify: async () => ({ issuer: 'https://account.test', subject: randomUUID() }) };
  await expect(publishAdmittedContent(env, content, account, access, new Request('http://main.local'), {
    preparationId: randomUUID(), revisionId: randomUUID(), expectedDigest: 'b'.repeat(64),
    expectedContentEpoch: randomUUID(), resourceId: resource, variantId: variant, expectedPublicationHead: null,
    actingSubject: actor, idempotencyKey: randomUUID(),
  })).rejects.toBeInstanceOf(RevisionNotFound);
  await expect(publishAdmittedTextContribution(env, account, access, new Request('http://main.local'), {
    contribution: resource, expectedDraftHead: actor, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor, idempotencyKey: randomUUID(),
  })).rejects.toBeInstanceOf(RevisionNotFound);
});

test('G-526: an empty Content revision must match the exact publication intent', async () => {
  const input: PublishPinnedContentInput = { preparationId: randomUUID(), revisionId: randomUUID(),
    expectedDigest: 'b'.repeat(64), expectedContentEpoch: randomUUID(), resourceId: resource,
    variantId: variant, expectedPublicationHead: null };
  for (const mismatch of [{ revisionId: randomUUID() }, { resourceId: actor },
    { variantId: `urn:rezics:variant:${randomUUID()}` }, { byteDigest: 'c'.repeat(64) }]) {
    const content = { readExactBatch: async () => [{ status: 'available', reference: {
      revisionId: input.revisionId, resourceId: resource, variantId: variant,
      byteDigest: input.expectedDigest, ...mismatch }, body: { body: '' } }] } as unknown as ContentCore;
    await expect(assertContentPublicationBody(content, input)).rejects.toBeInstanceOf(ContentPublicationConflict);
  }
});


test('G-526: readable Work authority does not disclose a foreign Content revision', async () => {
  const env = { lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
    fuseki: { query: async (query: string) => query.includes('SELECT DISTINCT ?type')
      ? currentWorkType : { boolean: true } } } as unknown as WorkActivationEnvironment;
  const access = { canReadWork: async () => true,
    register: () => { throw new Error('foreign revision created an admission'); } } as unknown as AccessAdmissionRegistry;
  const content = { owningResourceForRevision: async () => actor,
    readExactBatch: () => { throw new Error('foreign private bytes were read'); } } as unknown as ContentCore;
  await expect(publishAdmittedContent(env, content,
    { verify: async () => ({ issuer: 'https://account.test', subject: randomUUID() }) }, access,
    new Request('http://main.local'), { preparationId: randomUUID(), revisionId: randomUUID(),
      expectedDigest: 'b'.repeat(64), expectedContentEpoch: randomUUID(), resourceId: resource,
      variantId: variant, expectedPublicationHead: null, actingSubject: actor, idempotencyKey: randomUUID(),
    })).rejects.toBeInstanceOf(RevisionNotFound);
});
