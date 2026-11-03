import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite, type BatchCommand } from '@rezics/definitions/bulk';
import { mapBangumiVocabulary } from '../src/bangumi-vocabulary.ts';
import { mapVndbVocabulary } from '../src/vndb-vocabulary.ts';
import type {
  NativeIdentity,
  ResolvedConcept,
  ResolvedScheme,
  SourceVocabularyInput,
  SourceVocabularyProvider,
} from '../src/source-vocabulary.ts';
import { createSourceRegistration } from '../../../services/importer/src/source-registry.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const native = (n: number, type: string): NativeIdentity => ({ id: id(n), type, releaseDigest: bundledDigest });
const scheme = (taxonomy: string, uri: string, n: number): ResolvedScheme => ({
  taxonomy, uri, id: id(n), type: 'skos:ConceptScheme', releaseDigest: bundledDigest,
});
const concept = (taxonomy: string, code: string, schemeId: string, n: number): ResolvedConcept => ({
  taxonomy, code, id: id(n), type: 'skos:Concept', schemeId, releaseDigest: bundledDigest,
});
function input(provider: SourceVocabularyProvider, rows: SourceVocabularyInput['rows'], concepts: ResolvedConcept[] = [], schemes: ResolvedScheme[] = []): SourceVocabularyInput {
  return {
    metadata: {
      provider, sourceAlias: provider, externalId: provider === 'bangumi' ? '410' : 'v410',
      recordRevision: '7', digest: 'a'.repeat(64), converterRevision: 'native@1',
      recordUrl: provider === 'bangumi' ? 'https://bgm.tv/subject/410' : 'https://vndb.org/v410.7',
      license: provider === 'bangumi' ? 'CC-BY-SA-3.0' : 'ODbL-1.0', attribution: provider === 'bangumi' ? 'Bangumi' : 'VNDB',
    },
    bindings: { releaseDigest: bundledDigest, schemes, concepts },
    rows,
  };
}
const proposals = (commands: readonly BatchCommand[]) => commands.filter((item) => item.op === 'propose');

test('Bangumi episode kind and fractional sort use released properties and exact concept bindings', () => {
  const schemeId = id(90);
  const result = mapBangumiVocabulary(input('bangumi', [
    { kind: 'episode-sort', path: '/episode/410/sort', episode: native(1, 'schema:Episode'), sort: 1.5 },
    { kind: 'episode-kind', path: '/episode/410/type', episode: native(1, 'schema:Episode'), code: 2 },
    { kind: 'episode-kind', path: '/episode/410/type', episode: native(1, 'schema:Episode'), code: 3 },
    { kind: 'episode-kind', path: '/episode/410/type', episode: native(1, 'schema:Episode'), code: 99 },
  ], [concept('bangumi.episode.type', '2', schemeId, 91)], [scheme(
    'bangumi.episode.type', 'https://rezics.com/schemes/bangumi/episode-types', 90,
  )]));

  expect(proposals(result.proposals)).toHaveLength(2);
  expect(result.proposals.map((item) => item.op === 'propose' && item.statement.value.type === 'value'
    ? [item.statement.property.id, item.statement.value.content]
    : null))
    .toEqual([['schema:episodeNumber', '1.5'], ['schema:keywords', id(91)]]);
  expect(result.gaps).toMatchObject([
    { provider: 'bangumi', path: '/episode/410/type', code: '3', reason: 'missing_concept' },
    { provider: 'bangumi', path: '/episode/410/type', code: '99', reason: 'unknown_code' },
  ]);
  expect(result.proposals[0]).toMatchObject({
    source: { source: 'bangumi', external_id: '410', record_revision: '7', converter_revision: 'native@1' },
  });
  expect(result.proposals[0]).not.toHaveProperty('rights');
  expect(checkBatchWrite({ commands: [...proposals(result.proposals)] }, bundledRelease)).toEqual([]);
});

test('source reference and rights bytes change the deterministic command key', () => {
  const row = { kind: 'episode-sort', path: '/episode/410/sort', episode: native(1, 'schema:Episode'), sort: '1.5' } as const;
  const request = input('bangumi', [row]);
  const changed = { ...request, metadata: { ...request.metadata, recordUrl: 'https://bgm.tv/episode/411' } };
  const changedRights = { ...request, metadata: { ...request.metadata, attribution: 'Bangumi Archive' } };
  const originalCommand = mapBangumiVocabulary(request).proposals[0];
  const changedCommand = mapBangumiVocabulary(changed).proposals[0];
  const changedRightsCommand = mapBangumiVocabulary(changedRights).proposals[0];
  expect(originalCommand?.key).not.toBe(changedCommand?.key);
  expect(originalCommand?.key).not.toBe(changedRightsCommand?.key);
});

test('Bangumi credits, appearances and voice roles keep their supplied qualifications', () => {
  const staffScheme = id(100);
  const appearanceScheme = id(102);
  const result = mapBangumiVocabulary(input('bangumi', [
    { kind: 'staff', path: '/subject-persons/0/position', subject: native(10, 'schema:Book'), holder: native(11, 'schema:Person'), holderCode: 'person-11', subjectType: 1, roleCode: 2001, creditedAs: 'Source credit', order: 0 },
    { kind: 'character-appearance', path: '/subject-characters/0/type', subject: native(12, 'schema:TVSeries'), character: native(13, 'wd:Q95074'), characterCode: 'character-13', roleCode: 1 },
    { kind: 'voice-credit', path: '/person-characters/0/character_id', subject: native(12, 'schema:TVSeries'), performer: native(14, 'schema:Person'), performerCode: 'person-14', character: native(13, 'wd:Q95074'), characterCode: 'character-13', creditedAs: 'Source voice credit' },
  ], [
    concept('bangumi.staff', '2001', staffScheme, 101),
    concept('bangumi.subject-characters.type', '1', appearanceScheme, 103),
  ], [
    scheme('bangumi.staff', 'https://rezics.com/schemes/bangumi/staff', 100),
    scheme('bangumi.subject-characters.type', 'https://rezics.com/schemes/bangumi/appearance-roles', 102),
  ]));
  const mapped = proposals(result.proposals);
  expect(mapped).toHaveLength(3);
  const staff = mapped.find((item) => item.op === 'propose' && item.statement.property.id === 'schema:author')!;
  expect(staff).toMatchObject({ subject: id(10), statement: { value: { content: id(11) } } });
  expect(staff.op === 'propose' && staff.statement.qualifiers).toEqual(expect.arrayContaining([
    { property: { id: 'wdt:P3831' }, value: { type: 'value', content: id(101) } },
    { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Source credit' } },
    { property: { id: 'schema:position' }, value: { type: 'value', content: '1' } },
  ]));
  const appearance = mapped.find((item) => item.op === 'propose' && item.statement.property.id === 'schema:character')!;
  expect(appearance.op === 'propose' && appearance.statement.qualifiers).toContainEqual(
    { property: { id: 'wdt:P3831' }, value: { type: 'value', content: id(103) } },
  );
  const voice = mapped.find((item) => item.op === 'propose' && item.statement.property.id === 'wdt:P725')!;
  expect(voice.op === 'propose' && voice.statement.qualifiers).toEqual(expect.arrayContaining([
    { property: { id: 'wdt:P453' }, value: { type: 'value', content: id(13) } },
    { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Source voice credit' } },
  ]));
  expect(checkBatchWrite({ commands: [...mapped] }, bundledRelease)).toEqual([]);
});

test('VNDB tags preserve spoiler level and staff roles target the resolved holder', () => {
  const genreScheme = id(92);
  const roleScheme = id(94);
  const traitScheme = id(96);
  const statusScheme = id(98);
  const result = mapVndbVocabulary(input('vndb', [
    { kind: 'tag', path: '/tags_vn/0/tag', subject: native(2, 'wd:Q689445'), category: 'cont', code: '311', spoiler: 2 },
    { kind: 'staff', path: '/vn_staff/0/role', subject: native(2, 'wd:Q689445'), holder: native(3, 'schema:Person'), holderCode: 'a1', roleCode: 'scenario' },
    { kind: 'character-trait', path: '/chars_traits/0/tid', character: native(5, 'wd:Q95074'), code: '73', spoiler: 1 },
    { kind: 'development-status', path: '/vn/2/devstatus', subject: native(2, 'wd:Q689445'), code: 1 },
  ], [
    concept('vndb.tag.cont', '311', genreScheme, 93),
    concept('vndb.credit_type', 'scenario', roleScheme, 95),
    concept('vndb.character-trait', '73', traitScheme, 97),
    concept('vndb.development-status', '1', statusScheme, 99),
  ], [
    scheme('vndb.tag.cont', 'https://vndb.org/tags', 92),
    scheme('vndb.credit_type', 'https://vndb.org/credit-types', 94),
    scheme('vndb.character-trait', 'https://vndb.org/traits', 96),
    scheme('vndb.development-status', 'https://vndb.org/development-status', 98),
  ]));
  const mapped = proposals(result.proposals);
  expect(mapped).toHaveLength(4);
  const genre = mapped.find((item) => item.op === 'propose' && item.statement.property.id === 'schema:genre')!;
  expect(genre.op === 'propose' && genre.statement.qualifiers).toContainEqual({
    property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount: '+2', unit: '1' } },
  });
  const credit = mapped.find((item) => item.op === 'propose' && item.statement.property.id === 'schema:author')!;
  expect(credit).toMatchObject({ op: 'propose', subject: id(2), statement: { value: { content: id(3) } } });
  expect(credit.op === 'propose' && credit.statement.qualifiers).not.toContainEqual(
    expect.objectContaining({ property: { id: 'schema:position' } }),
  );
  const trait = mapped.find((item) => item.op === 'propose' && item.statement.property.id === 'schema:keywords')!;
  expect(trait.op === 'propose' && trait.statement.qualifiers).toContainEqual({
    property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount: '+1', unit: '1' } },
  });
  expect(mapped.some((item) => item.op === 'propose' && item.subject === id(2) &&
    item.statement.property.id === 'schema:keywords' && item.statement.value.type === 'value' &&
    item.statement.value.content === id(99))).toBe(true);
  expect(checkBatchWrite({ commands: [...mapped] }, bundledRelease)).toEqual([]);
});

test('VNDB preserves date precision and reports TBA, absent dates, and release endpoints without retargeting', () => {
  const release = native(4, 'wd:Q20631656');
  const result = mapVndbVocabulary(input('vndb', [
    { kind: 'release-date', path: '/releases/4/released', release, value: '2020' },
    { kind: 'release-date', path: '/releases/5/released', release: native(6, 'wd:Q20631656'), value: '2020-02' },
    { kind: 'release-date', path: '/releases/6/released', release: native(7, 'wd:Q20631656'), value: '2020-02-29' },
    { kind: 'release-date', path: '/releases/4/released', release, value: 'TBA' },
    { kind: 'release-date', path: '/releases/8/released', release: native(8, 'wd:Q20631656'), value: '0000-00-00' },
    { kind: 'release-date', path: '/releases/4/released', release, value: null },
    { kind: 'release-work', path: '/releases_vn/4/vn', release, work: native(9, 'wd:Q689445'), workCode: '9', completenessCode: 'complete' },
    { kind: 'release-supersedes', path: '/releases_supersedes/4/rid', release, endpoint: native(5, 'wd:Q20631656'), endpointCode: '5' },
    { kind: 'release-supersedes', path: '/releases_supersedes/4/rid', release, endpointCode: '6' },
  ]));
  const mapped = proposals(result.proposals);
  expect(mapped).toHaveLength(4);
  const dates = mapped.filter((item) => item.op === 'propose' && item.statement.property.id === 'schema:datePublished');
  expect(dates.map((item) => item.op === 'propose' && item.statement.value.type === 'value'
    ? item.statement.value.content
    : null)).toEqual([
    { time: '+2020-00-00T00:00:00Z', precision: 9, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
    { time: '+2020-02-00T00:00:00Z', precision: 10, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
    { time: '+2020-02-29T00:00:00Z', precision: 11, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
  ]);
  expect(JSON.stringify(mapped)).not.toContain('wdt:P155');
  expect(result.gaps).toMatchObject([
    { path: '/releases/4/released', code: 'TBA', reason: 'property_not_admitted', requiredProfile: 'wd:Q20631656', property: 'schema:keywords' },
    { path: '/releases/8/released', reason: 'invalid_source_value', property: 'schema:datePublished' },
    { path: '/releases/4/released', code: 'absent', reason: 'unsupported_source_case', property: 'schema:datePublished' },
    { path: '/releases_vn/4/vn', code: 'complete', reason: 'qualifier_not_admitted', property: 'wdt:P31' },
    { path: '/releases_supersedes/4/rid', endpoint: '5', reason: 'property_not_admitted', requiredProfile: 'wd:Q20631656', property: 'wdt:P155' },
    { path: '/releases_supersedes/4/rid', code: '6', endpoint: '6', reason: 'missing_identity' },
  ]);
});

test('registered Bangumi conversion invokes the row mapper and appends ordinary proposals', () => {
  const registration = createSourceRegistration('bangumi');
  const result = registration.convert({
    external_id: '410', record_revision: '7', record: { id: 410, type: 2, name: 'Example series' },
  }, {
    source: registration.source,
    subjectId: id(10),
    sourceVocabulary: {
      bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
      rows: [{ kind: 'episode-sort', path: '/episode/411/sort', episode: native(11, 'schema:Episode'), sort: 2.5 }],
    },
  });
  expect(registration.describeSourceRecord?.('410')).toMatchObject({
    licence: { id: 'CC-BY-SA-3.0' }, attribution: 'Bangumi contributors',
  });
  expect(result.proposals.some((item) => item.op === 'propose' && item.statement.property.id === 'schema:episodeNumber')).toBe(true);
  expect(result.sourceVocabularyGaps).toEqual([]);
});

test('Bangumi relation pairs coalesce to one canonical release relation', () => {
  const rows = [
    { kind: 'relation', path: '/subject_relations/1/related', subject: native(10, 'schema:Book'), endpoint: native(11, 'schema:Book'), endpointCode: '11', family: 2, code: 5 },
    { kind: 'relation', path: '/subject_relations/2/related', subject: native(11, 'schema:Book'), endpoint: native(10, 'schema:Book'), endpointCode: '10', family: 2, code: 4 },
  ] as const;
  const result = mapBangumiVocabulary(input('bangumi', rows));
  const reversed = mapBangumiVocabulary(input('bangumi', [...rows].reverse()));
  const mapped = proposals(result.proposals);
  expect(mapped).toHaveLength(1);
  expect(mapped[0]).toMatchObject({
    subject: id(10), statement: { property: { id: 'rezics:summaryOf' }, value: { content: id(11) } },
  });
  expect(proposals(reversed.proposals)[0]?.key).toBe(mapped[0]?.key);
  expect(result.gaps).toEqual([]);
});

test('hostile row objects become bounded diagnostics without leaking thrown values', () => {
  const privateValue = 'do-not-report-this';
  const hostile = new Proxy({}, { get: () => { throw new Error(privateValue); } });
  const result = mapVndbVocabulary(input('vndb', [hostile] as unknown as SourceVocabularyInput['rows']));
  expect(result.proposals).toEqual([]);
  expect(result.gaps).toEqual([{ provider: 'vndb', path: '/sourceVocabulary/rows', reason: 'invalid_row' }]);
  expect(JSON.stringify(result)).not.toContain(privateValue);
});
