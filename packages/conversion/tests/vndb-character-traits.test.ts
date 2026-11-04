import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { converter_revision } from '../src/cross-media-entities.ts';
import { mapVndbVocabulary } from '../src/vndb-vocabulary.ts';
import { createSourceRegistration } from '../../../services/importer/src/source-registry.ts';
import type {
  NativeIdentity,
  ResolvedConcept,
  ResolvedScheme,
  SourceVocabularyInput,
} from '../src/source-vocabulary.ts';
import {
  appearanceRoleSchemeUri,
  characterTraitSchemeUri,
} from '../../../services/importer/src/vndb-character-traits.ts';

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

const traitScheme = scheme('vndb.character-trait', characterTraitSchemeUri, 90);
const roleScheme = scheme('vndb.char_role', appearanceRoleSchemeUri, 92);
const hair = concept('vndb.character-trait', 'i73', traitScheme.id, 91);
const mainRole = concept('vndb.char_role', 'main', roleScheme.id, 93);
const character = native(1, 'wd:Q95074');
const work = native(2, 'wd:Q689445');

function input(rows: SourceVocabularyInput['rows']): SourceVocabularyInput {
  return {
    metadata: {
      provider: 'vndb',
      sourceAlias: 'vndb_cross_media',
      externalId: 'c1',
      recordRevision: null,
      digest: 'a'.repeat(64),
      converterRevision: converter_revision,
      recordUrl: 'https://vndb.org/c1',
      license: 'ODbL-1.0',
      attribution: 'VNDB (database: ODbL-1.0; permitted metadata contents: DbCL-1.0)',
    },
    bindings: { releaseDigest: bundledDigest, schemes: [traitScheme, roleScheme], concepts: [hair, mainRole] },
    rows,
  };
}

test('production caller publishes exact traits and appearance roles and withholds lie and release-scoped rows', () => {
  const registration = createSourceRegistration('vndb', {
    source: 'vndb_cross_media',
    converterRevision: converter_revision,
  });
  const traits = registration.convert(
    { external_id: 'c1', record_revision: null, record: { id: 'c1', name: 'Authored character' } },
    {
      source: registration.source,
      subjectId: character.id,
      sourceVocabulary: {
        bindings: input([]).bindings,
        rows: [
          { kind: 'character-trait', path: '/chars_traits/c1/i73', character, code: 'i73', spoiler: 1, lie: false },
          { kind: 'character-trait', path: '/chars_traits/c1/i80', character, code: 'i80', spoiler: 0, lie: true },
        ],
      },
    },
  );
  const keyword = traits.proposals.filter(
    (command) => command.op === 'propose' && command.statement.property.id === 'schema:keywords',
  );
  expect(keyword).toHaveLength(1);
  expect(keyword[0]).toMatchObject({
    subject: character.id,
    statement: {
      value: { content: hair.id },
      qualifiers: [
        { property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount: '+1', unit: '1' } } },
      ],
    },
  });
  expect(traits.sourceVocabularyGaps).toMatchObject([
    { path: '/chars_traits/c1/i80', code: 'i80', reason: 'unsupported_source_case', property: 'chars_traits.lie' },
  ]);
  expect(checkBatchWrite({ commands: [...keyword] }, bundledRelease)).toEqual([]);

  const appearances = mapVndbVocabulary(
    input([
      {
        kind: 'character-appearance',
        path: '/chars_vns/c1/v1',
        subject: work,
        character,
        characterCode: 'c1',
        roleCode: 'main',
        spoiler: 0,
        releaseCode: null,
      },
      {
        kind: 'character-appearance',
        path: '/chars_vns/c1/v1/r9',
        subject: work,
        character,
        characterCode: 'c1',
        roleCode: 'side',
        spoiler: 1,
        releaseCode: 'r9',
      },
    ]),
  );
  const published = appearances.proposals.filter(
    (command) => command.op === 'propose' && command.statement.property.id === 'schema:character',
  );
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    subject: work.id,
    statement: {
      value: { content: character.id },
      qualifiers: [
        { property: { id: 'wdt:P3831' }, value: { type: 'value', content: mainRole.id } },
        { property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount: '+0', unit: '1' } } },
      ],
    },
  });
  expect(appearances.gaps).toMatchObject([
    { path: '/chars_vns/c1/v1/r9', code: 'r9', reason: 'unsupported_source_case', property: 'chars_vns.rid' },
  ]);
  expect(checkBatchWrite({ commands: [...published] }, bundledRelease)).toEqual([]);
});
