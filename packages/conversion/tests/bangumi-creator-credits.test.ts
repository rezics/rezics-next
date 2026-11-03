import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite, type BatchCommand } from '@rezics/definitions/bulk';
import { mapBangumiVocabulary } from '../src/bangumi-vocabulary.ts';
import type {
  NativeIdentity,
  ResolvedConcept,
  ResolvedScheme,
  SourceVocabularyInput,
} from '../src/source-vocabulary.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const native = (n: number, type: string): NativeIdentity => ({ id: id(n), type, releaseDigest: bundledDigest });
const scheme = (taxonomy: string, uri: string, n: number): ResolvedScheme => ({
  taxonomy,
  uri,
  id: id(n),
  type: 'skos:ConceptScheme',
  releaseDigest: bundledDigest,
});
const concept = (taxonomy: string, code: string, schemeId: string, n: number): ResolvedConcept => ({
  taxonomy,
  code,
  id: id(n),
  type: 'skos:Concept',
  schemeId,
  releaseDigest: bundledDigest,
});
function input(
  rows: SourceVocabularyInput['rows'],
  concepts: ResolvedConcept[] = [],
  schemes: ResolvedScheme[] = [],
): SourceVocabularyInput {
  return {
    metadata: {
      provider: 'bangumi',
      sourceAlias: 'bangumi',
      externalId: '12',
      recordRevision: '1',
      digest: 'a'.repeat(64),
      converterRevision: 'cross-media-entities@1',
      recordUrl: 'https://bgm.tv/subject/12',
      license: 'CC-BY-SA-3.0',
      attribution: 'Bangumi contributors',
    },
    bindings: { releaseDigest: bundledDigest, schemes, concepts },
    rows,
  };
}
const proposals = (commands: readonly BatchCommand[]) => commands.filter((item) => item.op === 'propose');

test('authored staff and voice rows keep detailed role and character without fabricated order', () => {
  const staffScheme = id(100);
  const result = mapBangumiVocabulary(
    input(
      [
        {
          kind: 'staff',
          path: '/subject-persons/12/101/position',
          subject: native(10, 'schema:TVSeries'),
          holder: native(11, 'schema:Person'),
          holderCode: 'person:101',
          subjectType: 2,
          roleCode: 2,
        },
        {
          kind: 'voice-credit',
          path: '/person-characters/12/102/201',
          subject: native(10, 'schema:TVSeries'),
          performer: native(12, 'schema:Person'),
          performerCode: 'person:102',
          character: native(13, 'wd:Q95074'),
          characterCode: 'character:201',
        },
      ],
      [concept('bangumi.staff', '2', staffScheme, 101)],
      [scheme('bangumi.staff', 'https://rezics.com/schemes/bangumi/staff', 100)],
    ),
  );
  const mapped = proposals(result.proposals);
  expect(mapped).toHaveLength(2);
  const staff = mapped.find((item) => item.op === 'propose' && item.statement.property.id === 'schema:director')!;
  expect(staff).toMatchObject({ subject: id(10), statement: { value: { content: id(11) } } });
  expect(staff.op === 'propose' && staff.statement.qualifiers).toEqual([
    { property: { id: 'wdt:P3831' }, value: { type: 'value', content: id(101) } },
  ]);
  const voice = mapped.find((item) => item.op === 'propose' && item.statement.property.id === 'wdt:P725')!;
  expect(voice).toMatchObject({ subject: id(10), statement: { value: { content: id(12) } } });
  expect(voice.op === 'propose' && voice.statement.qualifiers).toEqual([
    { property: { id: 'wdt:P453' }, value: { type: 'value', content: id(13) } },
  ]);
  expect(JSON.stringify(mapped)).not.toContain('schema:position');
  expect(result.gaps).toEqual([]);
  expect(checkBatchWrite({ commands: [...mapped] }, bundledRelease)).toEqual([]);
});

test('music and live-action staff remain the pinned omitted producer binding', () => {
  const result = mapBangumiVocabulary(
    input([
      {
        kind: 'staff',
        path: '/subject-persons/30/301/position',
        subject: native(20, 'schema:MusicAlbum'),
        holder: native(21, 'schema:Person'),
        holderCode: 'person:301',
        subjectType: 3,
        roleCode: 3001,
      },
      {
        kind: 'staff',
        path: '/subject-persons/60/601/position',
        subject: native(22, 'schema:Movie'),
        holder: native(23, 'schema:Person'),
        holderCode: 'person:601',
        subjectType: 6,
        roleCode: 4001,
      },
    ]),
  );
  expect(result.proposals).toEqual([]);
  expect(result.gaps).toEqual([
    {
      provider: 'bangumi',
      path: '/subject-persons/30/301/position',
      code: '3001',
      reason: 'unsupported_source_case',
      property: 'staff.3',
    },
    {
      provider: 'bangumi',
      path: '/subject-persons/60/601/position',
      code: '4001',
      reason: 'unsupported_source_case',
      property: 'staff.6',
    },
  ]);
});

test('absent endpoints, unknown roles and a changed role withhold or replace the credit', () => {
  const staffScheme = id(100);
  const bindings = {
    concepts: [concept('bangumi.staff', '2', staffScheme, 101), concept('bangumi.staff', '1', staffScheme, 102)],
    schemes: [scheme('bangumi.staff', 'https://rezics.com/schemes/bangumi/staff', 100)],
  };
  const director = {
    kind: 'staff' as const,
    path: '/subject-persons/12/101/position',
    subject: native(10, 'schema:TVSeries'),
    holder: native(11, 'schema:Person'),
    holderCode: 'person:101',
    subjectType: 2 as const,
    roleCode: 2,
  };
  const missing = mapBangumiVocabulary(
    input(
      [
        {
          kind: 'staff' as const,
          path: director.path,
          subject: director.subject,
          holderCode: director.holderCode,
          subjectType: director.subjectType,
          roleCode: director.roleCode,
        },
        {
          kind: 'voice-credit',
          path: '/person-characters/12/102/201',
          subject: native(10, 'schema:TVSeries'),
          performer: native(12, 'schema:Person'),
          performerCode: 'person:102',
          characterCode: 'character:201',
        },
        { ...director, path: '/subject-persons/12/101/unknown', roleCode: 9999 },
      ],
      bindings.concepts,
      bindings.schemes,
    ),
  );
  expect(missing.proposals).toEqual([]);
  expect(missing.gaps).toMatchObject([
    { reason: 'missing_identity', property: 'wdt:P453' },
    { reason: 'missing_identity', property: 'schema:director' },
    { reason: 'unknown_code', code: '9999', property: 'staff.2' },
  ]);
  const original = mapBangumiVocabulary(input([director], bindings.concepts, bindings.schemes)).proposals[0];
  const changed = mapBangumiVocabulary(
    input([{ ...director, roleCode: 1 }], bindings.concepts, bindings.schemes),
  ).proposals[0];
  expect(original?.key).toBeDefined();
  expect(changed?.key).toBeDefined();
  expect(changed?.key).not.toBe(original?.key);
});
