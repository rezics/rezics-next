import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { checkedMetadataState, metadataComponent, metadataDigest, InvalidWorkMetadata,
  WORK_METADATA_COST, type MetadataEditionState, type MetadataHeaderState } from '../src/modules/work/metadata-schema.ts';
import { selectedMetadata } from '../src/modules/work/metadata-read.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const header: MetadataHeaderState = { kind: 'header', originalTitle: null, localized: [
  { language: 'ja', title: '原題', description: null, mainVersionLabel: null },
  { language: 'en', title: 'English title', description: 'Recorded description', mainVersionLabel: 'Main text' },
] };
const edition: MetadataEditionState = { kind: 'edition', id: id(), status: 'active',
  title: { language: 'en', value: 'Second edition' }, contentLanguage: null, editionStatement: null,
  publisher: null, publicationYear: null, isbn13: '9780306406157' };

test('Work metadata validation preserves explicit absence and rejects malformed, duplicate and oversized facts', () => {
  expect(checkedMetadataState(header)).toMatchObject({ originalTitle: null });
  expect(checkedMetadataState(edition)).toEqual(edition);
  for (const invalid of [
    { kind: 'header', localized: [] }, { ...header, originalTitle: '' },
    { ...header, originalTitle: { value: 'Original without language' } },
    { ...header, localized: [header.localized[0], header.localized[0]] },
    { ...header, localized: [{ ...header.localized[0], language: 'en-US' }, { ...header.localized[0], language: 'en-us' }] },
    { ...header, localized: [{ language: 'en', title: null, description: null, mainVersionLabel: null }] },
    { ...header, localized: [{ ...header.localized[0], language: 'en-a' }] },
    { ...header, originalTitle: { value: 'Title\ncontrol', language: 'en' } },
    { ...edition, publicationYear: 2026.5 }, { ...edition, isbn13: '9780306406158' },
    { ...edition, nativeRelease: id() }, { ...edition, title: { language: 'en', value: '' } },
    { kind: 'relevance', sense: id(), decision: id(), context: { kind: 'mine' }, level: 'central' },
    { kind: 'relevance', sense: id(), decision: id(), context: { kind: 'global' }, level: 1 },
  ]) expect(() => checkedMetadataState(invalid)).toThrow(InvalidWorkMetadata);
  const large = { ...header, localized: Array.from({ length: WORK_METADATA_COST.locales }, (_, index) =>
    ({ language: `en-x-${index}`, title: 'Title', description: '漢'.repeat(4000), mainVersionLabel: null })) };
  expect(() => checkedMetadataState(large)).toThrow(InvalidWorkMetadata);
});

test('Work metadata digests canonicalize locale sets and JSON property order but bind explicit facts and heads', () => {
  const input = { work: id(), expectedHead: null, state: header };
  const digest = metadataDigest(input);
  expect(metadataDigest({ state: { localized: [...header.localized].reverse(), originalTitle: null, kind: 'header' },
    expectedHead: null, work: input.work })).toBe(digest);
  expect(metadataDigest({ ...input, expectedHead: id() })).not.toBe(digest);
  expect(metadataDigest({ ...input, state: { ...header, originalTitle: { language: 'ja', value: '原題' } } })).not.toBe(digest);
  const relevance = { kind: 'relevance' as const, sense: id(), decision: id(), level: 'central' as const,
    context: { kind: 'global' as const } };
  expect(metadataComponent(input.work, relevance)).toBe(metadataComponent(input.work, { ...relevance, decision: id() }));
  expect(metadataComponent(input.work, relevance)).not.toBe(metadataComponent(input.work,
    { ...relevance, context: { kind: 'realm-classification', id: id() } }));
});

test('Work metadata selection marks fallbacks and never promotes a display translation to original title', () => {
  const stored = { revision: id(), ...header };
  expect(selectedMetadata(stored, 'ja')).toMatchObject({ title: { value: '原題', basis: 'requested', language: 'ja' }, description: null });
  expect(selectedMetadata(stored, 'fr')).toMatchObject({ title: { value: 'English title', basis: 'fallback', language: 'en' } });
  expect(stored.originalTitle).toBeNull();
  expect(selectedMetadata({ revision: null, originalTitle: null, localized: [] }, 'ja')).toEqual({ title: null,
    description: null, tagline: null, mainVersionLabel: null });
});

test('Work metadata routes and concrete facts type-check in the web-style Eden consumer', () => {
  const client = treaty<MainApp>('http://main.invalid');
  const typedConsumer = async () => {
    const work = client.v1.works({ id: randomUUID() });
    const saved = await work.metadata.put({ profile: 'work-metadata-details-v1', expectedHead: null,
      state: header, actingSubject: id() }, { headers: { 'idempotency-key': 'typed-metadata' } });
    const revision: string | undefined = saved.data && 'revision' in saved.data ? saved.data.revision : undefined;
    const read = await work.metadata.get();
    const title: string | undefined = read.data?.originalTitle?.value;
    const editions = await work.editions.get({ query: { limit: 1, contentLanguage: 'en' } });
    const year: number | null | undefined = editions.data?.items[0]?.publicationYear;
    const exactEdition = await work.editions({ edition: randomUUID() }).get();
    const tombstone: 'active' | 'withdrawn' | undefined = exactEdition.data?.status;
    const classification = await work.classifications.get({ query: { scope: 'global' } });
    const relevance: 'incidental' | 'substantial' | 'central' | undefined = classification.data?.items[0]?.relevance?.level;
    const relevanceRevision: string | null | undefined = classification.data?.items[0]?.relevanceRevision;
    return { title, year, revision, relevance, tombstone, relevanceRevision };
  };
  expect(typedConsumer).toBeFunction();
  const fuseki = new FusekiClient('http://127.0.0.1:1/rezics');
  const app = createMainApp(fuseki, { environment: { fuseki, lineage: { dataEpoch: 'one', routingEpoch: 'one' },
    objectDirectory: '.temp/work-metadata-unit' }, account: {} as never, access: {} as never });
  expect(app.routes.map(route => `${route.method} ${route.path}`)).toContain('PUT /v1/works/:id/metadata');
  expect(app.routes.map(route => `${route.method} ${route.path}`)).toContain('GET /v1/works/:id/editions');
});
