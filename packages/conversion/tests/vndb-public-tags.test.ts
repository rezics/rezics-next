import { expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { converter_revision } from '../src/cross-media-entities.ts';
import { createSourceRegistration } from '../../../services/importer/src/source-registry.ts';
import { vndbPublicTagConceptUri, vndbPublicTagScheme, vndbPublicTagTaxonomy } from '../src/support.ts';
import { vndbPublicTagParentCommand, vndbPublicTagParentRevision } from '../src/vndb-vocabulary.ts';
import type { NativeIdentity, ResolvedConcept, ResolvedScheme } from '../src/source-vocabulary.ts';

const subjectId = '00000000-0000-4000-8000-000000000010';
const ids = {
  contScheme: '00000000-0000-4000-8000-000000000020',
  eroScheme: '00000000-0000-4000-8000-000000000021',
  techScheme: '00000000-0000-4000-8000-000000000022',
  cont: '00000000-0000-4000-8000-000000000030',
  ero: '00000000-0000-4000-8000-000000000031',
  tech: '00000000-0000-4000-8000-000000000032',
};
const work: NativeIdentity = { id: subjectId, type: 'wd:Q689445', releaseDigest: bundledDigest };

function scheme(category: 'cont' | 'ero' | 'tech', id: string): ResolvedScheme {
  return {
    taxonomy: vndbPublicTagTaxonomy(category),
    uri: vndbPublicTagScheme(category),
    id,
    type: 'skos:ConceptScheme',
    releaseDigest: bundledDigest,
  };
}
function concept(category: 'cont' | 'ero' | 'tech', code: string, schemeId: string, id: string): ResolvedConcept {
  return {
    taxonomy: vndbPublicTagTaxonomy(category),
    code,
    id,
    type: 'skos:Concept',
    schemeId,
    releaseDigest: bundledDigest,
  };
}

function authoredRecord() {
  return {
    vn: { id: 'v410', olang: 'en' },
    entry_meta: { id: 'v410', revision: 7, lastmod: '2026-10-24' },
    vn_titles: [{ id: 'v410', lang: 'en', official: true, title: 'Authored public tag work', latin: null }],
  };
}

const registration = () =>
  createSourceRegistration('vndb', { source: 'vndb_cross_media', converterRevision: converter_revision });
const bindings = {
  releaseDigest: bundledDigest,
  schemes: [scheme('cont', ids.contScheme), scheme('ero', ids.eroScheme), scheme('tech', ids.techScheme)],
  concepts: [
    concept('cont', 'g311', ids.contScheme, ids.cont),
    concept('ero', 'g44', ids.eroScheme, ids.ero),
    concept('tech', 'g7', ids.techScheme, ids.tech),
  ],
};

test('production VNDB public tag caller admits exact categories and spoilers', () => {
  const convert = registration();
  const bound = convert.convert(
    { external_id: 'v410', record_revision: '7', record: authoredRecord() },
    {
      source: convert.source,
      subjectId,
      sourceVocabulary: {
        bindings,
        rows: [
          { kind: 'tag', path: '/tags_vn/v410/g311/tag', subject: work, category: 'cont', code: 'g311', spoiler: 0 },
          { kind: 'tag', path: '/tags_vn/v410/g44/tag', subject: work, category: 'ero', code: 'g44', spoiler: 2 },
          { kind: 'tag', path: '/tags_vn/v410/g7/tag', subject: work, category: 'tech', code: 'g7', spoiler: 1 },
        ],
      },
    },
  );
  expect(checkBatchWrite({ commands: [...bound.proposals] })).toEqual([]);
  const genres = bound.proposals.filter(
    (command) => command.op === 'propose' && command.statement.property.id === 'schema:genre',
  );
  expect(genres).toHaveLength(3);
  const spoiler = (command: (typeof genres)[number]) =>
    command.op === 'propose'
      ? command.statement.qualifiers?.find((term) => term.property.id === 'rezics:spoilerLevel')?.value
      : undefined;
  const content = (command: (typeof genres)[number]) =>
    command.op === 'propose' && command.statement.value.type === 'value' ? command.statement.value.content : undefined;
  expect(genres.map((command) => [content(command), spoiler(command)])).toEqual([
    [ids.cont, { type: 'value', content: { amount: '+0', unit: '1' } }],
    [ids.ero, { type: 'value', content: { amount: '+2', unit: '1' } }],
    [ids.tech, { type: 'value', content: { amount: '+1', unit: '1' } }],
  ]);
  expect(JSON.stringify(bound.proposals)).not.toContain('vndb-tag-rating');
  expect(JSON.stringify(bound.proposals)).not.toContain('u9001');
  expect(bound.sourceVocabularyGaps).toEqual([]);
  expect(vndbPublicTagConceptUri('cont', 'g311')).toBe('https://rezics.com/schemes/vndb/public-tags/cont/g311');
});

test('unresolved VNDB tag codes remain structured gaps without a substituted concept', () => {
  const convert = registration();
  const missing = convert.convert(
    { external_id: 'v410', record_revision: '7', record: authoredRecord() },
    {
      source: convert.source,
      subjectId,
      sourceVocabulary: {
        bindings,
        rows: [
          { kind: 'tag', path: '/tags_vn/v410/g9999/tag', subject: work, category: 'cont', code: 'g9999', spoiler: 0 },
        ],
      },
    },
  );
  expect(missing.sourceVocabularyGaps).toMatchObject([
    { provider: 'vndb', path: '/tags_vn/v410/g9999/tag', code: 'g9999', reason: 'missing_concept' },
  ]);
  expect(
    missing.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:genre'),
  ).toBe(false);
  expect(JSON.stringify(missing.sourceVocabularyGaps)).not.toContain('uid');
});

test('a reviewed parent proposal cites the exact tags_parents row and both bound endpoints without rights or a main qualifier', () => {
  const command = vndbPublicTagParentCommand({
    child: 'g311',
    parent: 'g12',
    main: true,
    category: 'cont',
    path: '/tags_parents/g311/g12',
    childId: ids.cont,
    parentId: '00000000-0000-4000-8000-000000000040',
    schemeId: ids.contScheme,
    childUri: vndbPublicTagConceptUri('cont', 'g311'),
    parentUri: vndbPublicTagConceptUri('cont', 'g12'),
    schemeUri: vndbPublicTagScheme('cont'),
    releaseDigest: bundledDigest,
  });
  expect(command.source.converter_revision).toBe(vndbPublicTagParentRevision);
  expect(command.source.external_id).toBe('/tags_parents/g311/g12');
  expect(command.statement.property.id).toBe('skos:broader');
  expect(command.statement.value).toEqual({ type: 'value', content: '00000000-0000-4000-8000-000000000040' });
  expect(command.statement.qualifiers).toBeUndefined();
  expect(command.rights).toBeUndefined();
  expect(
    command.statement.references?.flatMap((reference) => reference.parts.map((part) => part.value.content)),
  ).toEqual([
    'https://vndb.org/g311#/tags_parents/g311/g12',
    vndbPublicTagConceptUri('cont', 'g311'),
    vndbPublicTagConceptUri('cont', 'g12'),
  ]);
  expect(
    checkBatchWrite({
      commands: [
        {
          ...command,
          subject: ids.cont,
          statement: {
            ...command.statement,
            value: { type: 'value', content: '00000000-0000-4000-8000-000000000040' },
          },
        },
      ],
    }),
  ).toEqual([]);
});
