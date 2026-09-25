import { expect, test } from 'bun:test';
import { translationAuthorizationScope, translationLinkDigest, validateTranslationLink,
  readTranslationLinks, type TranslationLinkInput } from '../src/modules/work/translation-links.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';

const id = (suffix: string) => `https://rezics.com/id/${suffix}`;
const ids = {
  targetWork: id('11111111-1111-4111-8111-111111111111'),
  targetMainVersion: id('22222222-2222-4222-8222-222222222222'),
  targetMainRevision: id('33333333-3333-4333-8333-333333333333'),
  sourceWork: id('44444444-4444-4444-8444-444444444444'),
  sourceMainVersion: id('55555555-5555-4555-8555-555555555555'),
  sourceMainRevision: id('66666666-6666-4666-8666-666666666666'),
  translator: id('77777777-7777-4777-8777-777777777777'),
  publisher: id('88888888-8888-4888-8888-888888888888'),
  actingSubject: id('99999999-9999-4999-8999-999999999999'),
};

const input: TranslationLinkInput = { ...ids, status: 'official', contentLanguage: 'zh',
  evidence: 'https://publisher.example/authorization/A-1' };

test('WORK02: official link requires a version-scoped source authorization', () => {
  expect(() => validateTranslationLink(input)).not.toThrow();
  expect(translationAuthorizationScope(input)).toBe(
    `translation:authorize:${input.sourceWork}:${input.sourceMainRevision}`);
  expect(() => validateTranslationLink({ ...input, sourceMainRevision: null })).toThrow();
  expect(() => validateTranslationLink({ ...input, sourceWork: input.targetWork })).toThrow();
  expect(() => validateTranslationLink({ ...input, evidence: 'javascript:alert(1)' })).toThrow();
  const independent: TranslationLinkInput = { ...input, status: 'third-party',
    sourceMainRevision: null };
  expect(() => validateTranslationLink(independent)).not.toThrow();
  expect(translationLinkDigest(independent)).not.toBe(translationLinkDigest(input));
  expect(translationLinkDigest({ ...input, targetMainRevision: id('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') }))
    .not.toBe(translationLinkDigest(input));
  const { evidence, ...rest } = input;
  const reordered = { idempotencyKey: 'same-request', evidence, ...rest };
  expect(translationLinkDigest(reordered)).toBe(translationLinkDigest({ ...input,
    idempotencyKey: 'same-request' }));
});

test('WORK02: a later retained target revision cannot inherit the prior link', async () => {
  const later = id('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const queries: string[] = [];
  const fuseki = { query: async (query: string) => {
    queries.push(query);
    return query.includes('ASK') ? { boolean: true } : { results: { bindings: [] } };
  } } as unknown as FusekiClient;
  const env = { fuseki } as WorkActivationEnvironment;
  expect(await readTranslationLinks(env, ids.targetMainVersion, later)).toEqual([]);
  expect(queries).toHaveLength(2);
  expect(queries[0]).toContain(`<${later}> a rv:RevisionAnchor`);
  expect(queries[1]).toContain(`rv:targetMainRevision <${later}>`);
  expect(queries[1]).not.toContain(`rv:targetMainRevision <${ids.targetMainRevision}>`);
});
