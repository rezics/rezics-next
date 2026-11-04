import { expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { converter_revision, convertCrossMediaEntity } from '../src/cross-media-entities.ts';
import { createSourceRegistration } from '../../../services/importer/src/source-registry.ts';
import type { NativeIdentity, ResolvedConcept, ResolvedScheme } from '../src/source-vocabulary.ts';

const releaseId = '00000000-0000-4000-8000-000000000004';
const workId = '00000000-0000-4000-8000-000000000009';
const schemeId = '00000000-0000-4000-8000-000000000098';
const statusId = '00000000-0000-4000-8000-000000000099';
const release: NativeIdentity = { id: releaseId, type: 'wd:Q20631656', releaseDigest: bundledDigest };
const work: NativeIdentity = { id: workId, type: 'wd:Q689445', releaseDigest: bundledDigest };
const statusScheme: ResolvedScheme = {
  taxonomy: 'vndb.development-status',
  uri: 'https://vndb.org/development-status',
  id: schemeId,
  type: 'skos:ConceptScheme',
  releaseDigest: bundledDigest,
};
const inDevelopment: ResolvedConcept = {
  taxonomy: 'vndb.development-status',
  code: '1',
  id: statusId,
  type: 'skos:Concept',
  schemeId,
  releaseDigest: bundledDigest,
};

const registration = () =>
  createSourceRegistration('vndb', { source: 'vndb_cross_media', converterRevision: converter_revision });

test('production VNDB release caller admits exact, month and year dates, TBA, unknown and absent dates, and two completeness states', () => {
  const convert = registration();
  const bound = convert.convert(
    { external_id: 'r1', record_revision: null, record: { id: 'r1', title: 'Authored exact release', released: '20200229' } },
    {
      source: convert.source,
      subjectId: releaseId,
      sourceVocabulary: {
        bindings: { releaseDigest: bundledDigest, schemes: [statusScheme], concepts: [inDevelopment] },
        rows: [
          { kind: 'release-date', path: '/releases/r1/released', release, value: '2020-02-29' },
          { kind: 'release-date', path: '/releases/r2/released', release, value: '2020-03' },
          { kind: 'release-date', path: '/releases/r3/released', release, value: '2020' },
          { kind: 'release-date', path: '/releases/r4/released', release, value: 'TBA' },
          { kind: 'release-date', path: '/releases/r5/released', release, value: 'unknown' },
          { kind: 'release-date', path: '/releases/r6/released', release, value: null },
          {
            kind: 'release-work',
            path: '/releases_vn/r1/v1',
            release,
            work,
            workCode: 'v1',
            completenessCode: 'complete',
          },
          {
            kind: 'release-work',
            path: '/releases_vn/r2/v1',
            release,
            work,
            workCode: 'v1',
            completenessCode: 'partial',
          },
        ],
      },
    },
  );
  expect(checkBatchWrite({ commands: [...bound.proposals] })).toEqual([]);
  expect(bound.normalized).toMatchObject({ id: 'r1', released: '20200229' });
  const dates = bound.proposals
    .filter((command) => command.op === 'propose' && command.statement.property.id === 'schema:datePublished')
    .map((command) =>
      command.op === 'propose' && command.statement.value.type === 'value' ? command.statement.value.content : null,
    );
  expect(dates).toEqual([
    { time: '+2020-02-29T00:00:00Z', precision: 11, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
    { time: '+2020-03-00T00:00:00Z', precision: 10, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
    { time: '+2020-00-00T00:00:00Z', precision: 9, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
  ]);
  expect(
    bound.proposals.filter((command) => command.op === 'propose' && command.statement.property.id === 'schema:exampleOfWork'),
  ).toHaveLength(2);
  expect(JSON.stringify(bound.proposals)).not.toContain('wdt:P155');
  expect(bound.sourceVocabularyGaps).toMatchObject([
    { path: '/releases/r4/released', code: 'TBA', reason: 'property_not_admitted', property: 'schema:keywords' },
    { path: '/releases/r5/released', code: 'unknown', reason: 'property_not_admitted', property: 'schema:keywords' },
    { path: '/releases/r6/released', code: 'absent', reason: 'unsupported_source_case', property: 'schema:datePublished' },
    { path: '/releases_vn/r1/v1', code: 'complete', reason: 'qualifier_not_admitted', property: 'wdt:P31' },
    { path: '/releases_vn/r2/v1', code: 'partial', reason: 'qualifier_not_admitted', property: 'wdt:P31' },
  ]);
  expect(convertCrossMediaEntity({ external_id: 'r1', record_revision: null, record: { id: 'r1', title: 'Authored' } }).proposals).toHaveLength(
    1,
  );
});

test('unsupported completeness, missing Concepts and withheld release states remain visible review gaps', () => {
  const convert = registration();
  const workRecord = {
    vn: { id: 'v1', olang: 'ja', devstatus: 1 },
    entry_meta: { id: 'v1', revision: 1 },
    vn_titles: [{ id: 'v1', lang: 'ja', official: true, title: 'Authored work', latin: null }],
  };
  const status = convert.convert(
    { external_id: 'v1', record_revision: '1', record: workRecord },
    {
      source: convert.source,
      subjectId: workId,
      sourceVocabulary: {
        bindings: { releaseDigest: bundledDigest, schemes: [statusScheme], concepts: [inDevelopment] },
        rows: [{ kind: 'development-status', path: '/vn/v1/devstatus', subject: work, code: 1 }],
      },
    },
  );
  expect(
    status.proposals.some(
      (command) =>
        command.op === 'propose' &&
        command.statement.property.id === 'schema:keywords' &&
        command.statement.value.type === 'value' &&
        command.statement.value.content === statusId,
    ),
  ).toBe(true);
  const missing = convert.convert(
    { external_id: 'r1', record_revision: null, record: { id: 'r1', title: 'Authored' } },
    {
      source: convert.source,
      subjectId: releaseId,
      sourceVocabulary: {
        bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
        rows: [
          {
            kind: 'release-work',
            path: '/releases_vn/r7/v1',
            release,
            work,
            workCode: 'v1',
            completenessCode: 'bundle',
          },
          { kind: 'development-status', path: '/vn/v1/devstatus', subject: work, code: 1 },
        ],
      },
    },
  );
  expect(missing.sourceVocabularyGaps).toMatchObject([
    { path: '/releases_vn/r7/v1', code: 'bundle', reason: 'unknown_code', property: 'releases_vn.rtype' },
    { path: '/vn/v1/devstatus', code: '1', reason: 'missing_scheme' },
  ]);
  expect(
    missing.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:keywords'),
  ).toBe(false);
});
