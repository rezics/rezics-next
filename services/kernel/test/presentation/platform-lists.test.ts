import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  MAX_PAGE_COST,
  MAX_PAGE_READS,
  planReads,
  platformRegistry,
  readCost,
  resolveTemplate,
} from '@rezics/composition';
import { platformProfile } from '../../src/presentation/setup.ts';

const subject = '00000000-0000-8000-8000-000000000000';
const pick = (type: string) =>
  resolveTemplate(platformProfile, { type, bases: bundledRelease.types[type]?.bases ?? [] });
const lists = (type: string) =>
  Object.values(planReads(platformRegistry, pick(type).document, { subject }).reads).flatMap((read) =>
    read.kind === 'search' && 'statement' in read.body.filter ? [read.body.filter.statement.property] : [],
  );

test('people, organisations, concepts, characters and series list their works', () => {
  expect(lists('schema:Person')).toEqual([
    'schema:author',
    'schema:illustrator',
    'schema:director',
    'schema:musicBy',
    'wdt:P725',
  ]);
  expect(lists('schema:Organization')).toEqual(['schema:publisher', 'schema:productionCompany', 'wdt:P178']);
  expect(lists('skos:Concept')).toEqual(['schema:genre']);
  expect(lists('wd:Q95074')).toEqual(['schema:character']);
  expect(pick('wd:Q7725310')).toMatchObject({ scope: 'base', key: 'schema:CreativeWorkSeries' });
  expect(pick('schema:TVSeries')).toMatchObject({ scope: 'base', key: 'schema:CreativeWorkSeries' });
  expect(lists('wd:Q7725310')).toEqual(['wdt:P179', 'schema:isPartOf']);
  expect(pick('schema:Book')).toMatchObject({ scope: 'base', key: 'schema:CreativeWork' });
  expect(lists('schema:Book')).toEqual(['schema:exampleOfWork']);
});

test('every default page stays within the page read budget', () => {
  const documents = [
    platformProfile.generic,
    ...platformProfile.bases.map(({ document }) => document),
    ...platformProfile.types.map(({ document }) => document),
  ];
  for (const document of documents) {
    const { reads } = planReads(platformRegistry, document, { subject });
    const all = Object.values(reads);
    expect(all.length).toBeLessThanOrEqual(MAX_PAGE_READS);
    expect(all.reduce((sum, read) => sum + readCost(read), 0)).toBeLessThanOrEqual(MAX_PAGE_COST);
    expect(all.filter((read) => read.kind === 'subject')).toHaveLength(1);
  }
});
