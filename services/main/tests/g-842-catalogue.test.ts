import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { checkedCandidates, grainOwner, CatalogueInvalid } from '../src/modules/catalogue-intake/schema.ts';
import { metadataWorkRequestDigest } from '../src/modules/work/activate.ts';
import { workRoutes } from '../src/routes/works.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { semanticPredicateOutcome, semanticTypeOutcome } from '../src/modules/semantic/schema.ts';

const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000842';
const candidateReceipt = '00000000-0000-4000-8000-000000000843';
test('G842: candidate titles retain spelling and canonical language; grain names select the owner', () => {
  const input = { profile: 'catalogue-candidates-v1', originalTitle: { value: '  Café  ', language: 'fr' },
    aliases: [], romanizations: [{ value: 'Sōdo Āto Onrain', language: 'ja-latn' }], creators: [], dates: [], identifiers: [] };
  expect(checkedCandidates(input)).toMatchObject({ originalTitle: { value: 'Café', language: 'fr' },
    romanizations: [{ value: 'Sōdo Āto Onrain', language: 'ja-Latn' }] });
  expect(() => checkedCandidates({ ...input, originalTitle: { value: 'Book', language: 'invalid_language' } })).toThrow(CatalogueInvalid);
  expect(() => checkedCandidates({ ...input, creators: ['   '] })).toThrow(CatalogueInvalid);
  expect(() => checkedCandidates({ ...input, identifiers: [{ isbn13: '9780316371248' }] })).toThrow(CatalogueInvalid);
  expect(() => checkedCandidates({ ...input, identifiers: [{ provider: 'unqualified', identifier: 'id' }] })).toThrow(CatalogueInvalid);
  expect(grainOwner('translation-or-version')).toEqual({ method: 'PUT', path: '/v1/works/{work}/realizations/{realization}' });
  expect(grainOwner('publication')?.path).toBe('/v1/works/{work}/releases/{release}');
  expect(grainOwner('collection')?.path).toBe('/v1/collections');
  expect(grainOwner('new-creative-scope')).toBeNull();
});

test('G842: generic semantic editing cannot impersonate catalogue visibility, verification or provenance', () => {
  for (const field of ['catalogueVisible', 'provisional', 'declaredGrain', 'candidateSearch',
    'fieldProvenance', 'declaredParentComposition', 'catalogueVerification', 'catalogueTitleKey', 'catalogueMetadataTitleKey']) {
    expect(semanticPredicateOutcome(`https://rezics.com/vocab/${field}`)).toBe('reserved-owner');
  }
  expect(semanticTypeOutcome('https://rezics.com/vocab/CatalogueVerification')).toBe('reserved-owner');
});

test('G842: creation receipt, grain, parent and aliases belong to the immutable request digest', () => {
  const catalogue = { candidateReceipt, grain: 'new-creative-scope' as const };
  const digest = metadataWorkRequestDigest('Title', [], 'en', { catalogue });
  expect(digest).not.toBe(metadataWorkRequestDigest('Title', [], 'en'));
  expect(digest).not.toBe(metadataWorkRequestDigest('Title', [], 'en', { catalogue: { ...catalogue, parentComposition: actor } }));
  expect(digest).not.toBe(metadataWorkRequestDigest('Title', [], 'en', { catalogue: { ...catalogue,
    romanizations: [{ value: 'Taitoru', language: 'ja-Latn' }] } }));
});

test('G842: catalogue creation declares grain and search evidence; referrals never register an admission', async () => {
  let registered = 0;
  const deps = { account: { verify: async () => ({ issuer: 'https://qa.test', subject: 'editor' }) },
    access: { register: async () => { registered++; throw new Error('Unexpected write'); } } } as unknown as MainWorkDependencies;
  const app = new Elysia().use(workRoutes({} as FusekiClient, deps));
  const send = (body: unknown) => app.handle(new Request('http://main.local/v1/works', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'g842-grain' }, body: JSON.stringify(body) }));
  const base = { profile: 'metadata-only-v1', title: 'A translation', language: 'en', actingSubject: actor };
  for (const body of [base, { ...base, grain: 'new-creative-scope' }, { ...base, candidateReceipt }]) {
    expect((await send(body)).status).toBe(422);
  }
  for (const grain of ['translation', 'version', 'translation-or-version', 'publication', 'collection'] as const) {
    const response = await send({ ...base, grain, candidateReceipt });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'use-owner-api', grain, ownerApi: grainOwner(grain) });
  }
  expect(registered).toBe(0);
});
