import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite, type BatchCommand } from '@rezics/definitions/bulk';
import { mapBangumiVocabulary } from '../src/bangumi-vocabulary.ts';
import { convertCrossMediaEntity, converter_revision } from '../src/cross-media-entities.ts';

const alias = 'bangumi_cross_media';
const subject = '11111111-1111-4111-8111-111111111111';
const scheme = '22222222-2222-4222-8222-222222222222';
const concept = '33333333-3333-4333-8333-333333333333';
const bindings = {
  releaseDigest: bundledDigest,
  schemes: [
    {
      taxonomy: 'bangumi.person.career',
      id: scheme,
      uri: 'https://rezics.com/schemes/bangumi/careers',
      type: 'skos:ConceptScheme' as const,
      releaseDigest: bundledDigest,
    },
  ],
  concepts: [
    {
      taxonomy: 'bangumi.person.career',
      code: 'producer',
      id: concept,
      type: 'skos:Concept' as const,
      schemeId: scheme,
      releaseDigest: bundledDigest,
    },
  ],
};

function convert(type: number, career?: unknown) {
  const record = {
    id: 8101,
    type,
    name: '星見',
    summary: 'A source biography.',
    ...(career === undefined ? {} : { career }),
  };
  return convertCrossMediaEntity(
    { external_id: 'person:8101', record_revision: null, record },
    { source: alias, subjectId: subject },
    { sourceKind: 'bangumi' },
  );
}

function careers(result: ReturnType<typeof convert>) {
  return result.proposals.filter(
    (command): command is Extract<BatchCommand, { op: 'propose' }> =>
      command.op === 'propose' && command.statement.property.id === 'wdt:P106',
  );
}

function mapCareers(result: ReturnType<typeof convert>, type = 'schema:Person', currentBindings = bindings) {
  const codes = Array.isArray(result.normalizedRecord.career)
    ? result.normalizedRecord.career.filter((code): code is string => typeof code === 'string')
    : [];
  return mapBangumiVocabulary({
    metadata: {
      provider: 'bangumi',
      sourceAlias: alias,
      externalId: 'person:8101',
      recordRevision: null,
      digest: result.digest,
      converterRevision: converter_revision,
      recordUrl: 'https://bgm.tv/person/8101',
      license: 'CC-BY-SA-3.0',
      attribution: 'Bangumi contributors',
    },
    bindings: currentBindings,
    rows: codes.map((code) => ({
      kind: 'person-career' as const,
      person: { id: subject, type, releaseDigest: bundledDigest },
      code,
      path: '/career',
    })),
  });
}

test('selected Bangumi Person careers use current source Concepts and released occupation', () => {
  const valid = convert(1, ['producer']);
  const mapped = mapCareers(valid);
  const proposals = mapped.proposals.filter(
    (command): command is Extract<BatchCommand, { op: 'propose' }> =>
      command.op === 'propose' && command.statement.property.id === 'wdt:P106',
  );
  expect(valid.normalizedRecord.career).toEqual(['producer']);
  expect(valid.normalizedRecord.summary).toBe('A source biography.');
  expect(proposals).toHaveLength(1);
  expect(proposals[0]?.op === 'propose' ? proposals[0].subject : undefined).toBe(subject);
  expect(proposals[0]?.op === 'propose' ? proposals[0].statement.value : undefined).toEqual({
    type: 'value',
    content: concept,
  });
  expect(proposals[0]?.op === 'propose' ? proposals[0].statement.references?.[0]?.parts : []).toContainEqual({
    property: { id: 'schema:url' },
    value: { type: 'value', content: 'https://bgm.tv/person/8101#/career' },
  });
  expect(
    valid.proposals.some(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:hasOccupation',
    ),
  ).toBe(false);
  expect(checkBatchWrite({ commands: [...valid.proposals, ...mapped.proposals] }, bundledRelease)).toEqual([]);
  expect(
    mapCareers(valid, 'schema:Person', { releaseDigest: bundledDigest, schemes: [], concepts: [] }).gaps,
  ).toContainEqual(expect.objectContaining({ reason: 'missing_scheme', property: 'skos:ConceptScheme' }));

  for (const value of [[], ['future-role'], { role: 'producer' }, ['producer', null]]) {
    const result = convert(1, value);
    const mappedResult = mapCareers(result);
    expect(careers(result)).toHaveLength(0);
    if (Array.isArray(value) && value[0] === 'producer') expect(mappedResult.proposals).toHaveLength(1);
    else expect(mappedResult.proposals).toHaveLength(0);
    expect(
      result.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'wdt:P6298'),
    ).toBe(true);
    expect(checkBatchWrite({ commands: [...result.proposals] }, bundledRelease)).toEqual([]);
  }
  expect(mapCareers(convert(1, ['future-role'])).gaps.map((gap) => gap.reason)).toContain('unknown_code');
  expect(convert(1, { role: 'producer' }).diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    'malformed_person_career',
  );
  expect(mapCareers(convert(2, ['producer']), 'schema:Organization').gaps.map((gap) => gap.reason)).toContain(
    'unsupported_source_case',
  );
});
