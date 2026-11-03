import { expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { documentText, parseDocument } from '@rezics/document';
import { converter_revision, convertCrossMediaEntity } from '../src/cross-media-entities.ts';
import { createSourceRegistration } from '../../../services/importer/src/source-registry.ts';
import type { NativeIdentity, ResolvedConcept, ResolvedScheme } from '../src/source-vocabulary.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
const schemeId = '00000000-0000-4000-8000-000000000090';
const conceptId = '00000000-0000-4000-8000-000000000091';
const episode: NativeIdentity = { id: subjectId, type: 'schema:Episode', releaseDigest: bundledDigest };
const scheme: ResolvedScheme = {
  taxonomy: 'bangumi.episode.type',
  uri: 'https://rezics.com/schemes/bangumi/episode-types',
  id: schemeId,
  type: 'skos:ConceptScheme',
  releaseDigest: bundledDigest,
};
const special: ResolvedConcept = {
  taxonomy: 'bangumi.episode.type',
  code: '1',
  id: conceptId,
  type: 'skos:Concept',
  schemeId,
  releaseDigest: bundledDigest,
};

function authoredEpisode(overrides: Record<string, unknown> = {}) {
  return {
    id: 900001,
    subject_id: 81,
    name: 'Authored fractional episode',
    name_cn: '编写的第1.5集',
    sort: 1.5,
    type: 1,
    airdate: '2006-04-06',
    duration: '24m',
    description: 'Authored CC-BY-SA episode description.',
    disc: 3,
    ...overrides,
  };
}

const registration = () =>
  createSourceRegistration('bangumi', { source: 'bangumi_cross_media', converterRevision: converter_revision });

test('production episode caller admits fractional ordinal, special kind, duration, airdate and attributed description', () => {
  const record = authoredEpisode();
  const convert = registration();
  const bound = convert.convert(
    { external_id: 'episode:900001', record_revision: null, record },
    {
      source: convert.source,
      subjectId,
      sourceVocabulary: {
        bindings: { releaseDigest: bundledDigest, schemes: [scheme], concepts: [special] },
        rows: [{ kind: 'episode-kind', path: '/episode/900001/type', episode, code: 1 }],
      },
    },
  );
  expect(checkBatchWrite({ commands: [...bound.proposals] })).toEqual([]);
  expect(bound.normalized).toMatchObject({
    id: 900001,
    sort: 1.5,
    type: 1,
    airdate: '2006-04-06',
    duration: '24m',
    description: 'Authored CC-BY-SA episode description.',
  });
  expect(bound.normalized).not.toHaveProperty('disc');
  const facts = bound.proposals.filter((command) => command.op === 'propose');
  expect(facts.find((command) => command.statement.property.id === 'schema:episodeNumber')?.statement.value).toEqual({
    type: 'value',
    content: '1.5',
  });
  expect(facts.find((command) => command.statement.property.id === 'schema:datePublished')?.statement.value).toEqual({
    type: 'value',
    content: {
      time: '+2006-04-06T00:00:00Z',
      precision: 11,
      calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
    },
  });
  expect(facts.find((command) => command.statement.property.id === 'schema:duration')?.statement.value).toEqual({
    type: 'value',
    content: { amount: '+1440', unit: 'http://www.wikidata.org/entity/Q11574' },
  });
  expect(facts.find((command) => command.statement.property.id === 'schema:keywords')?.statement.value).toEqual({
    type: 'value',
    content: conceptId,
  });
  const summary = facts.find((command) => command.source.field_group === 'summary')!;
  expect(summary.rights).toEqual({
    license: 'CC-BY-SA-3.0',
    obligations: ['cc:Attribution', 'cc:ShareAlike'],
    attribution: 'Bangumi contributors (https://bgm.tv/ep/900001)',
  });
  if (summary.statement.value.type !== 'value') throw new Error('Missing episode description');
  expect(documentText(parseDocument((summary.statement.value.content as { document: unknown }).document))).toBe(
    record.description,
  );
  expect(bound.sourceVocabularyGaps).toEqual([]);
  expect(convertCrossMediaEntity({ external_id: 'episode:900001', record_revision: null, record }).proposals).toHaveLength(
    1,
  );
});

test('unknown duration units and unknown or missing kind remain visible review gaps', () => {
  const convert = registration();
  const unknownDuration = convert.convert(
    { external_id: 'episode:900002', record_revision: null, record: authoredEpisode({ id: 900002, duration: '24:00' }) },
    { source: convert.source, subjectId },
  );
  expect(unknownDuration.diagnostics).toContainEqual({ pointer: '/duration', code: 'unknown_duration_unit' });
  expect(unknownDuration.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:duration')).toBe(
    false,
  );
  const unknownKind = convert.convert(
    { external_id: 'episode:900001', record_revision: null, record: authoredEpisode() },
    {
      source: convert.source,
      subjectId,
      sourceVocabulary: {
        bindings: { releaseDigest: bundledDigest, schemes: [scheme], concepts: [special] },
        rows: [{ kind: 'episode-kind', path: '/episode/900001/type', episode, code: 99 }],
      },
    },
  );
  expect(unknownKind.sourceVocabularyGaps).toMatchObject([
    { provider: 'bangumi', path: '/episode/900001/type', code: '99', reason: 'unknown_code' },
  ]);
  const missing = convert.convert(
    { external_id: 'episode:900001', record_revision: null, record: authoredEpisode() },
    {
      source: convert.source,
      subjectId,
      sourceVocabulary: {
        bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
        rows: [{ kind: 'episode-kind', path: '/episode/900001/type', episode, code: 1 }],
      },
    },
  );
  expect(missing.sourceVocabularyGaps).toMatchObject([
    { provider: 'bangumi', path: '/episode/900001/type', code: '1', reason: 'missing_scheme' },
  ]);
  expect(missing.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:keywords')).toBe(
    false,
  );
});
