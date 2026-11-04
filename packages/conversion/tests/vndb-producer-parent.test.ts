import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite, type BatchCommand } from '@rezics/definitions/bulk';
import { mapSourceEnumeration, vndbProducerParentEnds } from '../src/cross-media-entities.ts';
import { mapVndbVocabulary } from '../src/vndb-vocabulary.ts';
import type { NativeIdentity, SourceVocabularyInput } from '../src/source-vocabulary.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const native = (n: number, type: string): NativeIdentity => ({ id: id(n), type, releaseDigest: bundledDigest });
function input(rows: SourceVocabularyInput['rows']): SourceVocabularyInput {
  return {
    metadata: {
      provider: 'vndb',
      sourceAlias: 'vndb_cross_media',
      externalId: 'p1',
      recordRevision: 'unversioned',
      digest: 'a'.repeat(64),
      converterRevision: 'vndb-vocabulary@1:producer-parent@1:par',
      recordUrl: 'https://vndb.org/p1',
      license: 'ODbL-1.0',
      attribution: 'VNDB (database: ODbL-1.0; permitted metadata contents: DbCL-1.0)',
    },
    bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
    rows,
  };
}
const proposals = (commands: readonly BatchCommand[]) => commands.filter((item) => item.op === 'propose');
const content = (command: BatchCommand) =>
  command.op === 'propose' && command.statement.value.type === 'value' ? command.statement.value.content : undefined;

test('par and sub emit released P749 in source orientation without P355', () => {
  expect(mapSourceEnumeration('vndb', 'producer_relation', 'par')).toMatchObject({
    status: 'existing',
    term: 'wdt:P749',
  });
  expect(mapSourceEnumeration('vndb', 'producer_relation', 'sub')).toMatchObject({
    status: 'existing',
    term: 'wdt:P749',
  });
  expect(vndbProducerParentEnds('par', 'p1', 'p2')).toEqual({ holder: 'p1', target: 'p2' });
  expect(vndbProducerParentEnds('sub', 'p1', 'p3')).toEqual({ holder: 'p3', target: 'p1' });
  const child = native(1, 'schema:Organization');
  const parent = native(2, 'schema:Organization');
  const subsidiary = native(3, 'schema:Organization');
  const mapped = mapVndbVocabulary(
    input([
      {
        kind: 'producer-parent',
        path: '/producers_relations/p1/p2',
        subject: child,
        endpoint: parent,
        endpointCode: 'p2',
        code: 'par',
      },
      {
        kind: 'producer-parent',
        path: '/producers_relations/p1/p3',
        subject: child,
        endpoint: subsidiary,
        endpointCode: 'p3',
        code: 'sub',
      },
    ]),
  );
  const proposed = proposals(mapped.proposals);
  expect(proposed).toHaveLength(2);
  expect(proposed[0]).toMatchObject({ subject: child.id, statement: { property: { id: 'wdt:P749' } } });
  expect(content(proposed[0]!)).toBe(parent.id);
  expect(proposed[1]).toMatchObject({ subject: subsidiary.id, statement: { property: { id: 'wdt:P749' } } });
  expect(content(proposed[1]!)).toBe(child.id);
  expect(proposed.some((item) => item.op === 'propose' && item.statement.property.id === 'wdt:P355')).toBe(false);
  expect(mapped.gaps).toEqual([]);
  expect(checkBatchWrite({ commands: [...proposed] }, bundledRelease)).toEqual([]);
});

test('Person, missing, unknown and omitted producer-parent codes stay addressable gaps', () => {
  const org = native(1, 'schema:Organization');
  const person = native(4, 'schema:Person');
  const mapped = mapVndbVocabulary(
    input([
      {
        kind: 'producer-parent',
        path: '/producers_relations/p1/p4',
        subject: org,
        endpoint: person,
        endpointCode: 'p4',
        code: 'par',
      },
      {
        kind: 'producer-parent',
        path: '/producers_relations/p1/p9',
        subject: org,
        endpointCode: 'p9',
        code: 'par',
      },
      {
        kind: 'producer-parent',
        path: '/producers_relations/p1/p2',
        subject: org,
        endpoint: native(2, 'schema:Organization'),
        endpointCode: 'p2',
        code: 'old',
      },
      {
        kind: 'producer-parent',
        path: '/producers_relations/p1/p8',
        subject: org,
        endpoint: native(8, 'schema:Organization'),
        endpointCode: 'p8',
        code: 'zzz',
      },
    ]),
  );
  expect(proposals(mapped.proposals)).toEqual([]);
  expect(mapped.gaps.map((gap) => [gap.path, gap.reason, gap.property])).toEqual([
    ['/producers_relations/p1/p4', 'incompatible_identity', 'wdt:P749'],
    ['/producers_relations/p1/p9', 'missing_identity', 'wdt:P749'],
    ['/producers_relations/p1/p2', 'unknown_code', 'producers_relations.relation'],
    ['/producers_relations/p1/p8', 'unknown_code', 'producers_relations.relation'],
  ]);
});
