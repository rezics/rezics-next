import { expect, test } from 'bun:test';
import * as fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  checkNodeLocalCandidate, iri, namespaces, profileRegistry,
  shapeArbitraries, shapeSchemas, type WorkMetadataV1WorkShape,
} from '../src/index.ts';

const root = resolve(import.meta.dir, '../../..');
const workShape = profileRegistry['work-metadata-v1'].shapes[0];

test('P0.3: authored vocabulary and contexts resolve the shape predicates', () => {
  expect(namespaces.rv).toBe('https://rezics.com/vocab/');
  expect(iri['rv:mainVersion']).toBe(`${namespaces.rv}mainVersion`);
  expect(profileRegistry['work-metadata-v1'].focusRoles).toEqual(['work', 'main-version']);
  for (const profile of Object.values(profileRegistry)) {
    const id = profile.file.slice('shapes/'.length, -'.ttl'.length);
    const context = JSON.parse(readFileSync(resolve(root, `generated/model/contexts/${id}.jsonld`), 'utf8')) as {
      '@context': Record<string, { '@id': string; '@type'?: string }>;
    };
    expect(context['@context'].rv?.['@id']).toBe(namespaces.rv);
    for (const shape of profile.shapes) {
      expect(shapeSchemas[shape as keyof typeof shapeSchemas]).toBeDefined();
      expect(shapeArbitraries[shape as keyof typeof shapeArbitraries]).toBeDefined();
    }
  }
  const workContext = JSON.parse(readFileSync(resolve(root, 'generated/model/contexts/work-metadata-v1.jsonld'), 'utf8')) as {
    '@context': Record<string, { '@id': string; '@type'?: string }>;
  };
  expect(workContext['@context']['rv:mainVersion']).toEqual({ '@id': iri['rv:mainVersion'], '@type': '@id' });
});

test('P0.3: manifest authenticates every generated artifact without changing reviewed shape digests', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'generated/model/manifest.json'), 'utf8')) as {
    profiles: { id: string; sha256: string; file: string }[];
    artifacts: Record<string, string>;
  };
  expect(manifest.profiles).toHaveLength(27);
  expect(manifest.profiles.map(profile => profile.id)).toContain('work-author-credit-v1');
  expect(manifest.profiles.map(profile => profile.id)).toContain('realm-daily-rating-context-v1');
  expect(manifest.profiles.map(profile => profile.id)).toContain('realm-daily-rating-observation-v1');
  expect(manifest.profiles.map(profile => profile.id)).toContain('translation-link-v1');
  expect(manifest.profiles.map(profile => profile.id)).toContain('work-derivation-v1');
  for (const [path, sha256] of Object.entries(manifest.artifacts)) {
    const full = path.startsWith('packages/') ? path : `generated/model/${path}`;
    const actual = createHash('sha256').update(readFileSync(resolve(root, full))).digest('hex');
    expect(actual).toBe(sha256);
  }
  for (const entry of manifest.profiles) {
    expect(manifest.artifacts[entry.file]).toBe(entry.sha256);
  }
});

test('RATE03: generated daily types require both the base class and daily specialization', () => {
  const shape = 'https://rezics.com/definition/realm-daily-rating-context-v1/context-shape';
  const [candidate] = fc.sample(shapeArbitraries[shape], 1);
  expect(checkNodeLocalCandidate(shape, candidate)).toBe(true);
  for (const type of ['RatingContext', 'DailyRatingContext']) {
    expect(checkNodeLocalCandidate(shape, { ...candidate,
      'rdf:type': [`https://rezics.com/vocab/${type}`] })).toBe(false);
  }
});

test('MODEL15: seeded generated candidates satisfy their required node-local predicates', () => {
  const seed = Number(process.env.REZICS_QA_SEED ?? '20260925');
  if (!Number.isInteger(seed) || seed < -2147483648 || seed > 2147483647) {
    throw new Error('REZICS_QA_SEED must be a signed 32-bit integer');
  }
  for (const [shape, arbitrary] of Object.entries(shapeArbitraries)) {
    fc.assert(fc.property(arbitrary as fc.Arbitrary<unknown>, candidate =>
      checkNodeLocalCandidate(shape, candidate)), { seed, numRuns: 12 });
  }
});

test('P0.3: local checker rejects missing, fixed-value, cardinality and disjunction violations', () => {
  const work = fc.sample(shapeArbitraries[workShape], { seed: 27, numRuns: 1 })[0] as WorkMetadataV1WorkShape;
  expect(checkNodeLocalCandidate(workShape, work)).toBe(true);
  expect(checkNodeLocalCandidate(workShape, { ...work, 'rv:mainVersion': [] })).toBe(false);
  expect(checkNodeLocalCandidate(workShape, { ...work, 'rv:mainVersion': [work['rv:mainVersion'][0], 'urn:extra'] })).toBe(false);
  expect(checkNodeLocalCandidate(workShape, { ...work, 'rdf:type': ['https://schema.org/Thing'] })).toBe(false);
  expect(checkNodeLocalCandidate('urn:unknown:shape', work)).toBe(false);
  const revisionShape = profileRegistry['realm-standing-rating-observation-v1'].shapes[5];
  const revision = fc.sample(shapeArbitraries[revisionShape], { seed: 4, numRuns: 1 })[0] as Record<string, unknown>;
  expect(checkNodeLocalCandidate(revisionShape, revision)).toBe(true);
  expect(checkNodeLocalCandidate(revisionShape, { ...revision, 'rv:ratingAvailability': ['https://rezics.com/vocab/Available'], 'rv:ratingValue': [] })).toBe(false);
  expect(checkNodeLocalCandidate(revisionShape, { ...revision, 'rv:ratingAvailability': ['https://rezics.com/vocab/Withdrawn'], 'rv:ratingValue': [5] })).toBe(false);
  const contextShape = profileRegistry['realm-standing-rating-observation-v1'].shapes[1];
  const context = fc.sample(shapeArbitraries[contextShape], { seed: 31, numRuns: 1 })[0] as Record<string, unknown>;
  expect(checkNodeLocalCandidate(contextShape, { ...context, 'rv:ratingScaleMin': [2] })).toBe(false);
  const contributionShape = profileRegistry['text-contribution-v1'].shapes[0];
  const contribution = fc.sample(shapeArbitraries[contributionShape], { seed: 11, numRuns: 1 })[0] as Record<string, unknown>;
  expect(checkNodeLocalCandidate(contributionShape, { ...contribution, 'rv:language': ['not a language tag'] })).toBe(false);
});
