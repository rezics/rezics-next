import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { Related, Subject } from '../src/subject/types';
import { readWorkTags } from '../src/features/pages/showcase-work/tags';
import { subjectCatalogueTagDefinitions } from '../src/features/pages/subject-catalogue-metadata/index';

const subject = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'schema:VideoGame',
  context: 'global',
  release: bundledDigest,
  revision: 1,
  labels: { en: 'A seeded work' },
  statements: {},
} as unknown as Subject;

test.each(['schema:VideoGame', 'wd:Q689445', 'schema:TVSeries'])(
  'exact released %s metadata reaches work-tag admission and settles a valid empty reading',
  (type) => {
    const current = { ...subject, type };
    const catalogue = {
      state: 'released' as const,
      type,
      digest: bundledDigest,
      definitions: { types: bundledRelease.types, properties: bundledRelease.properties },
    };
    const definitions = subjectCatalogueTagDefinitions(current, catalogue);
    expect(definitions).toBeDefined();
    expect(readWorkTags(current, {} as Related, definitions, 'en', 0)).toMatchObject({ state: 'ready', tags: [] });
  },
);

test('missing, stale or mismatched page metadata does not open work-tag definitions', () => {
  const catalogue = {
    state: 'released' as const,
    type: subject.type,
    digest: bundledDigest,
    definitions: { types: bundledRelease.types, properties: bundledRelease.properties },
  };
  expect(subjectCatalogueTagDefinitions(subject, undefined)).toBeUndefined();
  expect(subjectCatalogueTagDefinitions(subject, { ...catalogue, digest: 'stale-release' })).toBeUndefined();
  expect(subjectCatalogueTagDefinitions(subject, { ...catalogue, type: 'schema:Book' })).toBeUndefined();
  const unavailable = subjectCatalogueTagDefinitions(subject, { ...catalogue, definitions: undefined });
  expect(readWorkTags(subject, {} as Related, unavailable, 'en', 0)).toEqual({ state: 'unavailable' });
});
