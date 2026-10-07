import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  checkNodeLocalCandidate,
  iri,
  namespaces,
  profileRegistry,
  shapeSchemas,
  type WorkMetadataV1WorkShape,
  type RealmDailyRatingContextV1ContextShape,
  type TextContributionV1ContributionShape,
} from '../src/index.ts';
import * as modelExports from '../src/index.ts';

const root = resolve(import.meta.dir, '../../..');
const workShape = profileRegistry['work-metadata-v1'].shapes[0];
const rv = 'https://rezics.com/vocab/';
const definition = 'https://rezics.com/definition/';

test('P0.3: authored vocabulary and contexts resolve the shape predicates', () => {
  expect(namespaces.rv).toBe('https://rezics.com/vocab/');
  expect(iri['rv:mainVersion']).toBe(`${namespaces.rv}mainVersion`);
  expect(profileRegistry['work-metadata-v1'].focusRoles).toEqual(['work', 'main-version']);
  for (const profile of Object.values(profileRegistry)) {
    const id = profile.file.slice('shapes/'.length, -'.ttl'.length);
    const context = JSON.parse(
      readFileSync(resolve(root, `generated/model/contexts/${id}.jsonld`), 'utf8'),
    ) as {
      '@context': Record<string, { '@id': string; '@type'?: string }>;
    };
    expect(context['@context'].rv?.['@id']).toBe(namespaces.rv);
    for (const shape of profile.shapes) {
      expect(shapeSchemas[shape as keyof typeof shapeSchemas]).toBeDefined();
    }
    expect(profile.shapes.map(String)).toEqual(
      profile.focusRoles.map((role) => `${definition}${id}/${role}-shape`),
    );
  }
  const workContext = JSON.parse(
    readFileSync(resolve(root, 'generated/model/contexts/work-metadata-v1.jsonld'), 'utf8'),
  ) as {
    '@context': Record<string, { '@id': string; '@type'?: string }>;
  };
  expect(workContext['@context']['rv:mainVersion']).toEqual({
    '@id': iri['rv:mainVersion'],
    '@type': '@id',
  });
});

test('P0.3: manifest authenticates every generated artifact without changing reviewed shape digests', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'generated/model/manifest.json'), 'utf8'),
  ) as {
    profiles: { id: string; sha256: string; file: string }[];
    artifacts: Record<string, string>;
  };
  // Profiles are discovered from model/definitions; one manifest entry and shape file per definition.
  const ids = manifest.profiles.map((profile) => profile.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeGreaterThanOrEqual(29);
  expect(manifest.profiles.map((profile) => profile.id)).toContain('work-author-credit-v1');
  expect(manifest.profiles.map((profile) => profile.id)).toContain('realm-daily-rating-context-v1');
  expect(manifest.profiles.map((profile) => profile.id)).toContain(
    'realm-daily-rating-observation-v1',
  );
  expect(manifest.profiles.map((profile) => profile.id)).toContain('translation-link-v1');
  expect(manifest.profiles.map((profile) => profile.id)).toContain('work-derivation-v1');
  for (const [path, sha256] of Object.entries(manifest.artifacts)) {
    const full = path.startsWith('packages/') ? path : `generated/model/${path}`;
    const actual = createHash('sha256')
      .update(readFileSync(resolve(root, full)))
      .digest('hex');
    expect(actual).toBe(sha256);
  }
  for (const entry of manifest.profiles) {
    expect(manifest.artifacts[entry.file]).toBe(entry.sha256);
    const registered = profileRegistry[entry.id as keyof typeof profileRegistry];
    expect(String(registered.sha256)).toBe(entry.sha256);
    expect(String(registered.file)).toBe(entry.file);
  }
});

test('the model package exposes schemas without the removed generated arbitrary artifact', () => {
  expect('shapeArbitraries' in modelExports).toBe(false);
  expect('WorkMetadataV1WorkShapeArbitrary' in modelExports).toBe(false);
  expect(existsSync(resolve(root, 'packages/model/src/generated/arbitraries.ts'))).toBe(false);
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'generated/model/manifest.json'), 'utf8'),
  ) as {
    artifacts: Record<string, string>;
  };
  expect(manifest.artifacts['packages/model/src/generated/arbitraries.ts']).toBeUndefined();
});

test('RATE03: generated daily types require both the base class and daily specialization', () => {
  const shape = 'https://rezics.com/definition/realm-daily-rating-context-v1/context-shape';
  const candidate = {
    '@id': 'urn:rating:daily-context',
    'rdf:type': [`${rv}RatingContext`, `${rv}DailyRatingContext`],
    'rv:ratingTimeZone': ['Asia/Shanghai'],
    'rv:ratingCalendar': [`${definition}rating-iso-calendar-v1`],
    'rv:contextState': [`${rv}Active`],
    'rv:realm': ['urn:rating:realm'],
    'rv:question': [{ '@value': 'How was your reading today?', '@language': 'en' }],
    'rv:targetGrain': [`${rv}MainVersion`],
    'rv:ratingScaleMin': [1],
    'rv:ratingScaleMax': [10],
    'rv:ratingCadence': [`${definition}rating-daily-v1`],
    'rv:ratingPopulationPolicy': [`${definition}rating-account-principal-population-v1`],
    'rv:ratingAggregationPolicy': [`${definition}rating-latest-per-rater-mean-v1`],
  } satisfies RealmDailyRatingContextV1ContextShape;
  expect(checkNodeLocalCandidate(shape, candidate)).toBe(true);
  for (const type of ['RatingContext', 'DailyRatingContext']) {
    expect(checkNodeLocalCandidate(shape, { ...candidate, 'rdf:type': [`${rv}${type}`] })).toBe(
      false,
    );
  }
  expect(
    checkNodeLocalCandidate(shape, {
      ...candidate,
      'rdf:type': [`${rv}RatingContext`, `${rv}RatingContext`],
    }),
  ).toBe(false);
});

test('P0.3: metadata Work candidates require one MainVersion and fixed native type without coercion', () => {
  const work = {
    '@id': 'urn:work:one',
    'rdf:type': ['https://schema.org/CreativeWork'],
    'rv:mainVersion': ['urn:work:main'],
    'rv:continuityProfile': [`${definition}continuity/native-work-v1`],
  } satisfies WorkMetadataV1WorkShape;
  expect(checkNodeLocalCandidate(workShape, work)).toBe(true);
  const { 'rv:mainVersion': omitted, ...withoutMain } = work;
  expect(omitted).toEqual(['urn:work:main']);
  expect(checkNodeLocalCandidate(workShape, withoutMain)).toBe(false);
  expect(checkNodeLocalCandidate(workShape, { ...work, 'rv:mainVersion': [] })).toBe(false);
  expect(
    checkNodeLocalCandidate(workShape, {
      ...work,
      'rv:mainVersion': ['urn:work:main', 'urn:extra'],
    }),
  ).toBe(false);
  expect(
    checkNodeLocalCandidate(workShape, {
      ...work,
      'rv:mainVersion': ['urn:work:main', 'urn:work:main'],
    }),
  ).toBe(false);
  expect(checkNodeLocalCandidate(workShape, { ...work, 'rv:mainVersion': 'urn:work:main' })).toBe(
    false,
  );
  expect(checkNodeLocalCandidate(workShape, { ...work, 'rv:mainVersion': [null] })).toBe(false);
  expect(
    checkNodeLocalCandidate(workShape, { ...work, 'rdf:type': ['https://schema.org/Thing'] }),
  ).toBe(false);
  expect(
    checkNodeLocalCandidate(workShape, {
      ...work,
      'rdf:type': ['https://schema.org/CreativeWork', 'https://schema.org/Book'],
    }),
  ).toBe(true);
  expect(checkNodeLocalCandidate('urn:unknown:shape', work)).toBe(false);
  const mainShape = profileRegistry['work-metadata-v1'].shapes[1];
  const main = {
    '@id': 'urn:work:main',
    'rdf:type': [`${rv}MainVersion`],
    'rv:work': ['urn:work:one'],
    'rv:hostingPolicy': [`${rv}MetadataOnly`],
  };
  expect(checkNodeLocalCandidate(mainShape, main)).toBe(true);
  expect(
    checkNodeLocalCandidate(mainShape, { ...main, 'rv:hostingPolicy': ['MetadataOnly'] }),
  ).toBe(false);
  expect(checkNodeLocalCandidate(mainShape, { ...main, 'rv:hostingPolicy': [`${rv}Hosted`] })).toBe(
    false,
  );
});

test('standing rating revisions require Available integer 1-10 and Withdrawn value omission', () => {
  const shape = `${definition}realm-standing-rating-observation-v1/revision-shape`;
  const revision = {
    '@id': 'urn:rating:revision',
    'rdf:type': [`${rv}RatingObservationRevision`],
    'rv:observation': ['urn:rating:observation'],
    'rv:ratingAvailability': [`${rv}Available`],
    'rv:ratingValue': [5],
    'rv:evaluatedAt': ['2026-10-07T00:00:00Z'],
    'rv:submittedAt': ['2026-10-07T00:01:00Z'],
    'rv:originalSubmissionAt': ['2026-10-07T00:01:00Z'],
    'rv:revisedAt': ['2026-10-07T00:01:00Z'],
  };
  expect(checkNodeLocalCandidate(shape, revision)).toBe(true);
  for (const value of [1, 10])
    expect(checkNodeLocalCandidate(shape, { ...revision, 'rv:ratingValue': [value] })).toBe(true);
  const { 'rv:ratingValue': omitted, ...withoutValue } = revision;
  expect(omitted).toEqual([5]);
  expect(checkNodeLocalCandidate(shape, withoutValue)).toBe(false);
  for (const value of [[], [0], [11], [1.5], ['5'], [null], [1, 2], null, 5])
    expect(checkNodeLocalCandidate(shape, { ...revision, 'rv:ratingValue': value })).toBe(false);
  const withdrawn = { ...withoutValue, 'rv:ratingAvailability': [`${rv}Withdrawn`] };
  expect(checkNodeLocalCandidate(shape, withdrawn)).toBe(true);
  expect(checkNodeLocalCandidate(shape, { ...withdrawn, 'rv:ratingValue': [] })).toBe(true);
  for (const value of [[5], [null], null])
    expect(checkNodeLocalCandidate(shape, { ...withdrawn, 'rv:ratingValue': value })).toBe(false);
  for (const value of [[], ['Available'], [`${rv}Available`, `${rv}Withdrawn`], null])
    expect(checkNodeLocalCandidate(shape, { ...revision, 'rv:ratingAvailability': value })).toBe(
      false,
    );
});

test('standing rating Context keeps the fixed 1-10 integer scale', () => {
  const shape = `${definition}realm-standing-rating-observation-v1/context-shape`;
  const context = {
    '@id': 'urn:rating:context',
    'rdf:type': [`${rv}RatingContext`],
    'rv:contextState': [`${rv}Active`],
    'rv:realm': ['urn:rating:realm'],
    'rv:targetGrain': [`${rv}MainVersion`],
    'rv:ratingScaleMin': [1],
    'rv:ratingScaleMax': [10],
    'rv:ratingCadence': [`${definition}rating-standing-v1`],
    'rv:ratingPopulationPolicy': [`${definition}rating-account-principal-population-v1`],
    'rv:ratingAggregationPolicy': [`${definition}rating-latest-per-rater-mean-v1`],
  };
  expect(checkNodeLocalCandidate(shape, context)).toBe(true);
  for (const value of [[2], ['1'], [], null, 1])
    expect(checkNodeLocalCandidate(shape, { ...context, 'rv:ratingScaleMin': value })).toBe(false);
  for (const value of [[5], ['10'], [10, 10], [null], null])
    expect(checkNodeLocalCandidate(shape, { ...context, 'rv:ratingScaleMax': value })).toBe(false);
});

test('text contribution candidates preserve language tags and required single-value envelopes', () => {
  const shape = profileRegistry['text-contribution-v1'].shapes[0];
  const contribution = {
    '@id': 'urn:contribution:one',
    'rdf:type': [`${rv}TextContribution`],
    'rv:work': ['urn:work:one'],
    'rv:author': ['urn:contribution:author'],
    'rv:language': ['en'],
    'rv:draftHead': ['urn:contribution:draft'],
  } satisfies TextContributionV1ContributionShape;
  expect(checkNodeLocalCandidate(shape, contribution)).toBe(true);
  for (const language of ['en', 'ar', 'zh-Hant', 'en-US'])
    expect(checkNodeLocalCandidate(shape, { ...contribution, 'rv:language': [language] })).toBe(
      true,
    );
  for (const value of [
    ['not a language tag'],
    ['EN'],
    ['en_US'],
    [''],
    ['en', 'zh'],
    [null],
    [],
    null,
    'en',
  ])
    expect(checkNodeLocalCandidate(shape, { ...contribution, 'rv:language': value })).toBe(false);
  const { 'rv:language': omitted, ...withoutLanguage } = contribution;
  expect(omitted).toEqual(['en']);
  expect(checkNodeLocalCandidate(shape, withoutLanguage)).toBe(false);
  expect(checkNodeLocalCandidate(shape, { ...contribution, 'rv:author': [] })).toBe(false);
});
