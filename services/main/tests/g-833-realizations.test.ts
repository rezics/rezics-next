import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { assertRealizationCorrection, checkedRealization, InvalidRealization, parseStoredRealization, realizationDigest }
  from '../src/modules/realization/schema.ts';
import { translationRealization } from '../src/modules/realization/legacy.ts';
import { checkedReleaseV2, resolvedReleaseV2, assertReleaseCorrection, InvalidRelease, parseStoredRelease, releaseDigest }
  from '../src/modules/release/schema.ts';
import { resolveReleaseCoverage } from '../src/modules/realization/coverage.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const work = id();
const realization = (language = 'en') => checkedRealization({ profile: 'realization-v1', id: id(),
  actingSubject: id(), expectedHead: null, language, kind: 'translation', translators: [id()], publishers: [id()],
  source: { kind: 'unresolved', work }, status: 'unofficial', verification: 'unverified', evidence: null }, work);
const release = (realizationId = id(), revision = id()) => checkedReleaseV2({ profile: 'release-v2', id: id(),
  actingSubject: id(), expectedHead: null, kind: 'formal', status: 'unofficial',
  title: { value: 'A title never supplies coverage', language: 'en' }, titleLanguage: 'en', tracklistLanguage: null,
  editionStatement: null, publisher: null, publicationYear: null, isbn13: '9780316371247', originalUrl: null,
  fixedRelease: null, evidence: null, identifiers: [{ provider: 'https://store.example', value: 'digital-1' }],
  platform: 'ebook', territory: 'TW', coverage: [{ realization: realizationId, revision, completeness: 'complete' }] }, work);

test('G833: scripts and same-language alternatives are independent realization identities', () => {
  const traditional = realization('zh-hant');
  const simplified = realization('zh-Hans');
  const otherTraditional = realization('zh-Hant');
  expect(traditional.language).toBe('zh-Hant');
  expect(simplified.language).toBe('zh-Hans');
  expect(otherTraditional.id).not.toBe(traditional.id);
  expect(parseStoredRealization(JSON.stringify(traditional))).toEqual(traditional);
  expect(() => assertRealizationCorrection(traditional, { ...traditional, language: 'en', evidence: id() }))
    .toThrow(/new realization/);
  const { work: ignoredWork, ...body } = traditional;
  expect(() => checkedRealization({ ...body, status: 'official' }, work)).toThrow(InvalidRealization);
});

test('G833: new Versioned retry digests ignore member order and derived coverage hydration', () => {
  const before = realization();
  const reordered = { ...Object.fromEntries(Object.entries(before).reverse()),
    source: { work, kind: 'unresolved' } } as typeof before;
  expect(realizationDigest(before)).toBe(realizationDigest(reordered));
  const input = release();
  const record = resolvedReleaseV2(input, input.coverage.map(entry => ({ ...entry, work, language: 'en',
    kind: 'translation', status: 'unofficial' })));
  expect(releaseDigest(input)).toBe(releaseDigest(record));
  expect(releaseDigest(record)).toBe(releaseDigest(Object.fromEntries(Object.entries(record).reverse()) as typeof record));
});

test('G833: 64 exact realization revisions hydrate through one bounded graph join', async () => {
  const records = Array.from({ length: 64 }, () => realization());
  const entries = records.map(record => ({ realization: record.id, revision: id(), completeness: 'partial' as const }));
  let calls = 0;
  const fuseki = { query: async (sparql: string, maxBytes?: number) => {
    calls++;
    expect(sparql).toContain('LIMIT 65');
    expect(sparql).not.toContain('CONTAINS');
    expect(maxBytes).toBe(640 * 1024);
    return { results: { bindings: records.map((record, index) => ({ realization: { type: 'uri', value: record.id },
      revision: { type: 'uri', value: entries[index]!.revision }, work: { type: 'uri', value: work },
      state: { type: 'literal', value: JSON.stringify(record) } })) } };
  } };
  const resolved = await resolveReleaseCoverage({ fuseki } as unknown as WorkActivationEnvironment, entries);
  expect(resolved).toHaveLength(64);
  expect(calls).toBe(1);
});

test('G833: release-v2 needs exact realization coverage and never infers it from language, Work or title', () => {
  const input = release();
  const { work: ignoredWork, ...body } = input;
  for (const coverage of [[], [{ work, completeness: 'complete' }], [{ realization: id(), completeness: 'complete' }],
    [{ title: 'Volume 1', language: 'en', completeness: 'complete' }],
    Array.from({ length: 65 }, () => ({ realization: id(), revision: id(), completeness: 'complete' }))]) {
    expect(() => checkedReleaseV2({ ...body, coverage }, work)).toThrow(InvalidRelease);
  }
  expect(() => checkedReleaseV2({ ...body, contentLanguages: ['en'] }, work)).toThrow(InvalidRelease);
  expect(() => checkedReleaseV2({ ...body, isbn13: '9780316371248' }, work)).toThrow(/checksum/);
  const record = resolvedReleaseV2(input, input.coverage.map(entry => ({ ...entry, work, language: 'zh-Hant',
    kind: 'translation', status: 'unofficial' })));
  expect(record.contentLanguages).toEqual(['zh-Hant']);
  expect(record.isTranslation).toBe(true);
  expect(parseStoredRelease(JSON.stringify(record))).toEqual(record);
  expect(() => resolvedReleaseV2({ ...input, status: 'official' }, record.resolvedCoverage)).toThrow(/unofficial/);
  expect(() => resolvedReleaseV2(input, [{ ...record.resolvedCoverage[0]!, work: id() }])).toThrow(/editing Work/);
});

test('G833: closed coverage cannot gain a later realization, even in the same language', () => {
  const input = release();
  const before = resolvedReleaseV2(input, input.coverage.map(entry => ({ ...entry, work, language: 'en',
    kind: 'translation', status: 'unofficial' })));
  const later = { realization: id(), revision: id(), completeness: 'complete' as const };
  const after = resolvedReleaseV2({ ...input, coverage: [...input.coverage, later], evidence: id(), expectedHead: id() },
    [...before.resolvedCoverage, { ...later, work, language: 'en', kind: 'translation', status: 'unofficial' }]);
  expect(() => assertReleaseCorrection(before, after)).toThrow(/later realization/);
  expect(() => assertReleaseCorrection(before, { ...before, title: { value: 'Corrected', language: 'en' }, expectedHead: id() }))
    .toThrow(/evidence/);
});

test('G833: installed translation adapter preserves unresolved source, unofficial status and authority fields', () => {
  const targetWork = id(), sourceWork = id();
  const link = { link: id(), targetWork, targetMainVersion: id(), targetMainRevision: id(), sourceWork,
    sourceMainVersion: id(), sourceMainRevision: null, sourceVersionStatus: 'unresolved' as const,
    status: 'third-party' as const, contentLanguage: 'zh-Hant', translator: id(), publisher: id(),
    evidence: 'https://example.com/evidence', authorizingParty: null, authorizationScope: null, authorizationEpoch: null };
  const view = translationRealization(link);
  expect(view.work).toBe(sourceWork);
  expect(view.source).toEqual({ kind: 'unresolved', work: sourceWork });
  expect(view.status).toBe('unofficial');
  expect(view.verification).toBe('unverified');
  expect(view.legacy).toEqual(link);
  const official = translationRealization({ ...link, status: 'official', sourceVersionStatus: 'exact',
    sourceMainRevision: id(), authorizingParty: id(), authorizationScope: 'exact-version', authorizationEpoch: '3' });
  expect(official.legacy.authorizationEpoch).toBe('3');
  expect(official.verification).toBe('verified');
});
