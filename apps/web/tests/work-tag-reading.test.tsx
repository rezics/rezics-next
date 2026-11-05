import { expect, test } from 'bun:test';
import type { Release } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { Related, Subject } from '../src/subject/types';
import type { Stmt } from '../src/features/pages/shared';
import { projectWorkTags } from '../src/features/catalogue/work-tag-reading/model';
import { subjectCatalogueTagDefinitions } from '../src/features/pages/subject-catalogue-metadata';

const workId = '00000000-0000-4000-8000-000000000001';
const property = 'schema:genre';
const definitions = (facetLabel = 'Themes') =>
  ({
    types: {
      'schema:CreativeWork': { bases: [], facets: [] },
      'schema:Book': { bases: ['schema:CreativeWork'], facets: [property] },
      'skos:Concept': { bases: [], facets: [] },
    },
    properties: {
      [property]: {
        datatype: 'wikibase-item',
        targets: ['skos:Concept'],
        labels: facetLabel ? { en: facetLabel } : {},
      },
    },
  }) as unknown as Pick<Release, 'types' | 'properties'>;

const id = (index: number) => `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`;
const snak = (propertyId: string, dataType: string, content: unknown) => ({
  property: { id: propertyId, data_type: dataType },
  value: { type: 'value', content },
});

function assertion(index: number, targetId: string, spoiler = 0): Stmt {
  return {
    id: id(index + 1000),
    rank: 'normal',
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: targetId },
    qualifiers: spoiler ? [snak('rezics:spoilerLevel', 'quantity', { amount: `+${spoiler}`, unit: '1' })] : [],
    references: [],
  } as unknown as Stmt;
}

function subject(statements: Stmt[], release = 'release-a'): Subject {
  return {
    id: workId,
    type: 'schema:Book',
    context: 'global',
    release,
    revision: release === 'release-a' ? 1 : 2,
    labels: { en: 'A bounded work' },
    statements: { [property]: statements },
  } as unknown as Subject;
}

function related(targets: readonly string[]): Related {
  return Object.fromEntries(
    targets.map((target, index) => [target, { type: 'skos:Concept', labels: { en: `Theme ${index}` } }]),
  ) as unknown as Related;
}

test('projection retains distinct assertions and counts only labelled tags admitted at the current spoiler setting', () => {
  const targets = Array.from({ length: 30 }, (_, index) => id(index));
  targets[1] = targets[0]!;
  const statements = targets.map((target, index) => assertion(index, target, index === 14 || index === 18 ? 2 : 0));
  const response = subject(statements);
  const entries = related(targets.slice(0, 29));
  const model = projectWorkTags({
    subject: response,
    related: entries,
    definitions: definitions(),
    locale: 'en',
    spoilerThreshold: 0,
  });

  expect(model?.state).toBe('available');
  expect(model?.rows).toHaveLength(28);
  expect(model?.rows[0]?.targetId).toBe(model?.rows[1]?.targetId);
  expect(model?.rows[0]?.key).not.toBe(model?.rows[1]?.key);
  expect(model?.rows.some((row) => row.spoilerLevel > 0)).toBe(false);
  expect(model?.disclosedCount).toBe(27);
  expect(model?.rows[27]?.targetId).toBe(targets[29]);
  expect(model?.sourceKey).toContain('release-a');
});

test('empty, unsupported and unavailable facet readings stay distinct', () => {
  const empty = projectWorkTags({
    subject: subject([]),
    related: related([]),
    definitions: definitions(),
    locale: 'en',
    spoilerThreshold: 0,
  });
  const unsupported = projectWorkTags({
    subject: subject([]),
    related: related([]),
    definitions: {
      types: {
        'schema:CreativeWork': { bases: [], facets: [] },
        'schema:Book': { bases: ['schema:CreativeWork'], facets: [] },
      },
      properties: {},
    } as unknown as Pick<Release, 'types' | 'properties'>,
    locale: 'en',
    spoilerThreshold: 0,
  });
  const unavailable = projectWorkTags({
    subject: subject([]),
    related: related([]),
    definitions: definitions(''),
    locale: 'en',
    spoilerThreshold: 0,
  });

  expect(empty?.state).toBe('empty');
  expect(unsupported?.state).toBe('unsupported');
  expect(unavailable?.state).toBe('unavailable');
});

test.each(['wd:Q689445', 'schema:Movie', 'schema:TVSeries'])(
  'released %s metadata displays its supplied Concept tag',
  (type) => {
    const targetId = id(9000);
    const current = { ...subject([assertion(0, targetId)], bundledDigest), type };
    const definitions = subjectCatalogueTagDefinitions(current, {
      state: 'released',
      type,
      digest: bundledDigest,
      definitions: { types: bundledRelease.types, properties: bundledRelease.properties },
    });

    const model = projectWorkTags({
      subject: current,
      related: related([targetId]),
      definitions,
      locale: 'en',
      spoilerThreshold: 0,
    });

    expect(model).toMatchObject({
      state: 'available',
      rows: [{ property, targetId }],
      disclosedCount: 1,
      hasUnavailable: false,
    });
  },
);

test('hidden membership cannot change rows, empty state or pagination; a preference change restores exact assertions', () => {
  const visible = assertion(0, id(0));
  const hidden = Array.from({ length: 24 }, (_, index) => assertion(index + 1, id(index + 1), 2));
  const project = (statements: Stmt[], spoilerThreshold = 0) =>
    projectWorkTags({
      subject: subject(statements),
      related: related([id(0)]),
      definitions: definitions(),
      locale: 'en',
      spoilerThreshold,
    })!;
  const withHidden = project([...hidden, visible]);
  expect(withHidden.rows).toEqual(project([visible]).rows);
  expect(withHidden.disclosedCount).toBe(1);
  expect(withHidden.hasUnavailable).toBe(false);
  expect(project(hidden).state).toBe('empty');
  const revealed = project([...hidden, visible], 2);
  expect(revealed.rows.map((row) => row.statement)).toEqual([...hidden, visible]);
  expect(revealed.rows[0]?.spoilerQualifiers).toEqual([{ property: 'rezics:spoilerLevel', in: ['2'] }]);
});
