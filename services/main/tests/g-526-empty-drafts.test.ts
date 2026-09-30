import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ContentConflict, type ContentCore } from '../../content/src/core.ts';
import type { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { saveAdmittedContentDraft } from '../src/modules/content-publication/draft.ts';
import { publishAdmittedContent } from '../src/modules/content-publication/publish-admitted.ts';
import { EmptyContentPublicationBody, type PublishPinnedContentInput }
  from '../src/modules/content-publication/publish.ts';
import { InvalidContributionInput, textContributionDigest } from '../src/modules/contribution/draft.ts';
import { textContributionEditDigest } from '../src/modules/contribution/edit.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const resource = `https://rezics.com/id/${randomUUID()}`;
const actor = `https://rezics.com/id/${randomUUID()}`;
const variant = `urn:rezics:variant:${randomUUID()}`;

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

test('G-526: Content draft input retains its type and UTF-8 byte limit before verifying or admitting', async () => {
  const input = { resourceId: resource, variant: { id: variant, resourceId: resource,
    language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const },
    expectedHead: null, actingSubject: actor, idempotencyKey: randomUUID(), body: '' };
  for (const body of [undefined, null, 0, false, {}, [], '字'.repeat(21_846)]) {
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
  const content = { readExactBatch: async (ids: string[]) => {
    reads.push(ids);
    return [{ status: 'available', reference: { resourceId: resource, variantId: variant,
      byteDigest: input.expectedDigest }, body: { body: '' } }];
  }, preparePublication: () => { throw new Error('empty body created a pin'); } } as unknown as ContentCore;
  const env = { lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
    fuseki: { query: async () => ({ boolean: true }) } } as unknown as WorkActivationEnvironment;
  const access = { register: () => { throw new Error('empty body created an admission'); } } as unknown as AccessAdmissionRegistry;
  await expect(publishAdmittedContent(env, content,
    { verify: async () => ({ issuer: 'https://account.test', subject: randomUUID() }) }, access,
    new Request('http://main.local'), { ...input, actingSubject: actor, idempotencyKey: randomUUID() }))
    .rejects.toBeInstanceOf(EmptyContentPublicationBody);
  expect(reads).toEqual([[input.revisionId]]);
});
