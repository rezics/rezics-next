import { expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BangumiVocabularyRow, NativeIdentity, SourceVocabularyInput } from '../src/source-vocabulary.ts';
import { mapBangumiVocabulary } from '../src/bangumi-vocabulary.ts';

const native = (number: number, type: string): NativeIdentity => ({
  id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  type,
  releaseDigest: bundledDigest,
});
const input = (rows: readonly BangumiVocabularyRow[]): SourceVocabularyInput => ({
  metadata: {
    provider: 'bangumi',
    sourceAlias: 'bangumi_cross_media',
    externalId: '410',
    recordRevision: null,
    digest: 'a'.repeat(64),
    converterRevision: 'bangumi-vocabulary@2',
    recordUrl: 'https://bgm.tv/subject/410',
    license: 'CC-BY-SA-3.0',
    attribution: 'Bangumi contributors',
  },
  bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
  rows,
});
const relation = (
  subject: NativeIdentity,
  endpoint: NativeIdentity | undefined,
  code: number,
  family: 1 | 2 | 3 | 4 | 6,
  reciprocalCode?: number,
): BangumiVocabularyRow => ({
  kind: 'relation',
  path: '/subject-relations/410/411',
  subject,
  ...(endpoint ? { endpoint } : {}),
  endpointCode: '411',
  family,
  code,
  ...(reciprocalCode === undefined ? {} : { reciprocalCode }),
});

test('live-action adaptation uses the admitted Movie profile and keeps a one-sided row', () => {
  const mapped = mapBangumiVocabulary(input([relation(native(10, 'schema:Movie'), native(11, 'schema:Book'), 1, 6)]));
  expect(mapped.gaps).toEqual([]);
  expect(mapped.proposals).toHaveLength(1);
  expect(mapped.proposals[0]).toMatchObject({
    op: 'propose',
    subject: native(10, 'schema:Movie').id,
    statement: {
      property: { id: 'rezics:crossMediaCounterpart' },
      value: { content: native(11, 'schema:Book').id },
    },
    source: { record_revision: 'unversioned', converter_revision: 'bangumi-vocabulary@2' },
  });
});

test('reciprocal parent-story evidence selects its canonical relation and changes the proposal key', () => {
  const subject = native(12, 'schema:TVSeries');
  const endpoint = native(13, 'schema:TVSeries');
  const oneSided = mapBangumiVocabulary(input([relation(subject, endpoint, 12, 2)]));
  const paired = mapBangumiVocabulary(input([relation(subject, endpoint, 12, 2, 6)]));
  expect(paired.proposals[0]).toMatchObject({
    subject: subject.id,
    statement: { property: { id: 'rezics:sideStoryOf' }, value: { content: endpoint.id } },
  });
  expect(paired.proposals[0]?.key).not.toBe(oneSided.proposals[0]?.key);
});

test('unknown, unreviewed music, missing endpoint, and unavailable profile remain bounded gaps', () => {
  const rows = [
    relation(native(20, 'schema:MusicAlbum'), native(21, 'schema:Movie'), 3001, 3),
    relation(native(20, 'schema:MusicAlbum'), native(21, 'schema:Movie'), 3999, 3),
    relation(native(20, 'schema:Movie'), undefined, 1, 6),
    relation(native(20, 'schema:Person'), native(21, 'schema:Movie'), 1, 6),
  ];
  const result = mapBangumiVocabulary(input(rows));
  expect(result.proposals).toEqual([]);
  expect(result.gaps).toMatchObject([
    { code: '3001', reason: 'unsupported_source_case', property: 'relation.3' },
    { code: '3999', reason: 'unknown_code', property: 'relation.3' },
    { code: '1', endpoint: '411', reason: 'missing_identity', property: 'rezics:crossMediaCounterpart' },
    {
      code: '1',
      reason: 'property_not_admitted',
      property: 'rezics:crossMediaCounterpart',
      requiredProfile: 'schema:Person',
    },
  ]);
});
