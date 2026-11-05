import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  MAX_PAGE_COST,
  MAX_PAGE_READS,
  planReads,
  platformRegistry,
  readCost,
  resolveView,
  resolveTemplate,
  templateViews,
  type View,
} from '@rezics/composition';
import { platformProfile } from '../../src/presentation/setup.ts';

const subject = '00000000-0000-8000-8000-000000000000';
const pick = (type: string) =>
  resolveTemplate(platformProfile(), { type, bases: bundledRelease.types[type]?.bases ?? [] });
const lists = (type: string, view: View = 'overview') => {
  const resolved = resolveView(platformProfile(), { type, bases: bundledRelease.types[type]?.bases ?? [] }, view);
  if (resolved === null) throw new Error(`Missing ${view} view for ${type}`);
  return Object.values(planReads(platformRegistry, resolved.document, { subject }).reads).flatMap((read) =>
    read.kind === 'links' ? [read.property] : [],
  );
};

test('people, organisations, concepts, characters and series list their works', () => {
  expect(lists('schema:Person', 'works')).toEqual([
    'schema:author',
    'schema:illustrator',
    'schema:director',
    'schema:musicBy',
  ]);
  expect(lists('schema:Person', 'characters')).toEqual(['wdt:P725']);
  expect(lists('schema:Organization', 'works')).toEqual(['schema:publisher', 'schema:productionCompany', 'wdt:P178']);
  expect(lists('skos:Concept', 'works')).toEqual(['schema:genre']);
  expect(lists('wd:Q95074', 'appearances')).toEqual(['schema:character']);
  expect(pick('wd:Q7725310')).toMatchObject({ scope: 'base', key: 'schema:CreativeWorkSeries' });
  expect(pick('schema:TVSeries')).toMatchObject({ scope: 'base', key: 'schema:CreativeWorkSeries' });
  expect(lists('wd:Q7725310', 'contents')).toEqual(['wdt:P179', 'schema:isPartOf']);
  expect(lists('schema:TVSeries', 'contents')).toEqual(['wdt:P179', 'schema:isPartOf']);
  expect(pick('schema:Book')).toMatchObject({ scope: 'base', key: 'schema:CreativeWork' });
  expect(lists('schema:Book', 'editions')).toEqual(['schema:exampleOfWork']);

  for (const [type, required] of [
    ['schema:Person', ['schema:author', 'schema:illustrator', 'schema:director', 'schema:musicBy', 'wdt:P725']],
    ['schema:Organization', ['schema:publisher', 'schema:productionCompany', 'wdt:P178']],
    ['skos:Concept', ['schema:genre']],
    ['wd:Q95074', ['schema:character']],
    ['wd:Q7725310', ['wdt:P179', 'schema:isPartOf']],
    ['schema:TVSeries', ['wdt:P179', 'schema:isPartOf']],
    ['schema:Book', ['schema:exampleOfWork']],
  ] as const) {
    expect(lists(type)).toEqual(expect.arrayContaining(required));
  }
});

test('every default page stays within the page read budget', () => {
  const documents = [platformProfile().generic, ...platformProfile().bases, ...platformProfile().types].flatMap(
    (template) => Object.values(templateViews(template)),
  );
  for (const document of documents) {
    const { reads } = planReads(platformRegistry, document, { subject });
    const all = Object.values(reads);
    expect(all.length).toBeLessThanOrEqual(MAX_PAGE_READS);
    expect(all.reduce((sum, read) => sum + readCost(read), 0)).toBeLessThanOrEqual(MAX_PAGE_COST);
    expect(all.filter((read) => read.kind === 'subject').length).toBeLessThanOrEqual(1);
  }
});
