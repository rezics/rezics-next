import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite, type BatchCommand } from '@rezics/definitions/bulk';
import { mapVndbVocabulary } from '../src/vndb-vocabulary.ts';
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
      provider: 'vndb',
      sourceAlias: 'vndb_cross_media',
      externalId: 'v1',
      recordRevision: '7',
      digest: 'a'.repeat(64),
      converterRevision: 'cross-media-entities@2',
      recordUrl: 'https://vndb.org/v1.7',
      license: 'ODbL-1.0',
      attribution: 'VNDB (database: ODbL-1.0; permitted metadata contents: DbCL-1.0)',
    },
    bindings: { releaseDigest: bundledDigest, schemes, concepts },
    rows,
  };
}
const proposals = (commands: readonly BatchCommand[]) => commands.filter((item) => item.op === 'propose');
const content = (command: BatchCommand) =>
  command.op === 'propose' && command.statement.value.type === 'value' ? command.statement.value.content : undefined;
const qualifiers = (command: BatchCommand) => (command.op === 'propose' ? (command.statement.qualifiers ?? []) : []);

test('two aliases keep one person identity, exact roles, credited spelling and voice character', () => {
  const roleScheme = id(94);
  const result = mapVndbVocabulary(
    input(
      [
        {
          kind: 'staff',
          path: '/vn_staff/10/scenario',
          subject: native(2, 'wd:Q689445'),
          holder: native(3, 'schema:Person'),
          holderCode: 's4',
          roleCode: 'scenario',
          creditedAs: 'Writer Alias',
        },
        {
          kind: 'staff',
          path: '/vn_staff/20/chardesign',
          subject: native(2, 'wd:Q689445'),
          holder: native(3, 'schema:Person'),
          holderCode: 's4',
          roleCode: 'chardesign',
          creditedAs: 'Artist Alias',
        },
        {
          kind: 'voice-credit',
          path: '/vn_seiyuu/10/c3',
          subject: native(2, 'wd:Q689445'),
          performer: native(3, 'schema:Person'),
          performerCode: 's4',
          character: native(5, 'wd:Q95074'),
          characterCode: 'c3',
          creditedAs: 'Voice Alias',
        },
      ],
      [
        concept('vndb.credit_type', 'scenario', roleScheme, 95),
        concept('vndb.credit_type', 'chardesign', roleScheme, 96),
      ],
      [scheme('vndb.credit_type', 'https://vndb.org/credit-types', 94)],
    ),
  );
  const mapped = proposals(result.proposals);
  expect(mapped).toHaveLength(3);
  const author = mapped.find((item) => item.op === 'propose' && item.statement.property.id === 'schema:author')!;
  const art = mapped.find((item) => item.op === 'propose' && item.statement.property.id === 'schema:illustrator')!;
  const voice = mapped.find((item) => item.op === 'propose' && item.statement.property.id === 'wdt:P725')!;
  expect(content(author)).toBe(id(3));
  expect(content(art)).toBe(id(3));
  expect(content(voice)).toBe(id(3));
  expect(qualifiers(author)).toEqual(
    expect.arrayContaining([
      { property: { id: 'wdt:P3831' }, value: { type: 'value', content: id(95) } },
      { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Writer Alias' } },
    ]),
  );
  expect(qualifiers(art)).toEqual(
    expect.arrayContaining([
      { property: { id: 'wdt:P3831' }, value: { type: 'value', content: id(96) } },
      { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Artist Alias' } },
    ]),
  );
  expect(qualifiers(voice)).toEqual(
    expect.arrayContaining([
      { property: { id: 'wdt:P453' }, value: { type: 'value', content: id(5) } },
      { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Voice Alias' } },
    ]),
  );
  expect(result.gaps).toEqual([]);
  expect(checkBatchWrite({ commands: [...mapped] }, bundledRelease)).toEqual([]);
});

test('missing alias, organization staff, unknown role, withdrawn concept and invalid spelling withhold the credit', () => {
  const roleScheme = id(94);
  const result = mapVndbVocabulary(
    input(
      [
        {
          kind: 'staff',
          path: '/vn_staff/11/scenario',
          subject: native(2, 'wd:Q689445'),
          holderCode: 's9',
          roleCode: 'scenario',
          creditedAs: 'Missing person',
        },
        {
          kind: 'staff',
          path: '/vn_staff/12/scenario',
          subject: native(2, 'wd:Q689445'),
          holder: native(8, 'schema:Organization'),
          holderCode: 'p9',
          roleCode: 'scenario',
          creditedAs: 'Studio',
        },
        {
          kind: 'staff',
          path: '/vn_staff/13/unknown',
          subject: native(2, 'wd:Q689445'),
          holder: native(3, 'schema:Person'),
          holderCode: 's4',
          roleCode: 'unknown',
        },
        {
          kind: 'staff',
          path: '/vn_staff/14/songs',
          subject: native(2, 'wd:Q689445'),
          holder: native(3, 'schema:Person'),
          holderCode: 's4',
          roleCode: 'songs',
        },
        {
          kind: 'staff',
          path: '/vn_staff/15/scenario',
          subject: native(2, 'wd:Q689445'),
          holder: native(3, 'schema:Person'),
          holderCode: 's4',
          roleCode: 'scenario',
          creditedAs: '   ',
        },
        {
          kind: 'voice-credit',
          path: '/vn_seiyuu/10/c9',
          subject: native(2, 'wd:Q689445'),
          performer: native(3, 'schema:Person'),
          performerCode: 's4',
          characterCode: 'c9',
        },
      ],
      [concept('vndb.credit_type', 'scenario', roleScheme, 95)],
      [scheme('vndb.credit_type', 'https://vndb.org/credit-types', 94)],
    ),
  );
  expect(proposals(result.proposals)).toEqual([]);
  expect(result.gaps.map((gap) => [gap.path, gap.reason])).toEqual([
    ['/vn_staff/11/scenario', 'missing_identity'],
    ['/vn_staff/12/scenario', 'incompatible_identity'],
    ['/vn_staff/13/unknown', 'unknown_code'],
    ['/vn_staff/14/songs', 'missing_concept'],
    ['/vn_staff/15/scenario', 'invalid_source_value'],
    ['/vn_seiyuu/10/c9', 'missing_identity'],
  ]);
});
