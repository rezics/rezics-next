import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision } from '@rezics/conversion/cross-media-entities';
import { vndbPublicTagConceptUri, vndbPublicTagScheme } from '../../../packages/conversion/src/support.ts';
import type { CrossMediaPort } from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import {
  parseVndbCopyHeader,
  parseVndbCopyLine,
  projectVndbPublicTag,
  projectVndbPublicTagAssociation,
  VNDB_PUBLIC_TAG_COLUMNS,
} from '../src/vndb-tables.ts';
import {
  importVndbPublicTags,
  parseAuthoredVndbCopy,
  planVndbPublicTags,
  readVndbPublicTagBindings,
} from '../src/vndb-public-tags.ts';

const tagsHeader = VNDB_PUBLIC_TAG_COLUMNS.tags.join('\t');
const associationHeader = VNDB_PUBLIC_TAG_COLUMNS.tags_vn.join('\t');
const tagsCopy = [
  'g311\tcont\t0\tt\tt\tAuthored content tag\t\\N\t\\N',
  'g44\tero\t2\tt\tt\tAuthored erotic tag\t\\N\t\\N',
  'g7\ttech\t0\tt\tt\tAuthored technical tag\t\\N\t\\N',
  'g88\tcont\t0\tt\tt\tAuthored false tag\t\\N\t\\N',
  'g99\tcont\t1\tt\tt\tAuthored confidence tag\t\\N\t\\N',
];
const associationCopy = [
  '2026-10-24\tg311\tv410\tu9001\t3\t0\tf\tf\tprivate note',
  '2026-10-24\tg311\tv410\tu9002\t2\t1\tf\tf\tprivate aggregate',
  '2026-10-24\tg44\tv410\tu9001\t2\t2\tf\tf\t\\N',
  '2026-10-24\tg7\tv410\tu9001\t1\t\\N\tf\tf\t\\N',
  '2026-10-24\tg9999\tv410\tu9001\t3\t0\tf\tf\t\\N',
  '2026-10-24\tg88\tv410\tu9001\t-2\t0\tf\tt\tsecret lie',
  '2026-10-24\tg99\tv410\tu9001\t2.4\t1\tf\tf\t\\N',
];

function authoredTables() {
  const rows: Record<string, Record<string, unknown>[]> = {
    'vndb/vn': [{ id: 'v410', olang: 'en' }],
    'vndb/vn_titles': [{ id: 'v410', lang: 'en', official: 't', title: 'Authored public tag work', latin: null }],
    'vndb/entry_meta': [{ id: 'v410', revision: 7, lastmod: '2026-10-24' }],
    'vndb/tags': parseAuthoredVndbCopy('tags', tagsHeader, tagsCopy),
    'vndb/tags_vn': parseAuthoredVndbCopy('tags_vn', associationHeader, associationCopy),
  };
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

const schemeIds = {
  cont: '00000000-0000-4000-8000-000000000020',
  ero: '00000000-0000-4000-8000-000000000021',
  tech: '00000000-0000-4000-8000-000000000022',
};
const conceptIds = {
  g311: '00000000-0000-4000-8000-000000000030',
  g44: '00000000-0000-4000-8000-000000000031',
  g7: '00000000-0000-4000-8000-000000000032',
};
const subjects: Record<string, object> = {
  [schemeIds.cont]: {
    subject: {
      id: schemeIds.cont,
      type: 'skos:ConceptScheme',
      statements: { 'schema:url': [{ value: { content: vndbPublicTagScheme('cont') } }] },
    },
  },
  [schemeIds.ero]: {
    subject: {
      id: schemeIds.ero,
      type: 'skos:ConceptScheme',
      statements: { 'schema:url': [{ value: { content: vndbPublicTagScheme('ero') } }] },
    },
  },
  [schemeIds.tech]: {
    subject: {
      id: schemeIds.tech,
      type: 'skos:ConceptScheme',
      statements: { 'schema:url': [{ value: { content: vndbPublicTagScheme('tech') } }] },
    },
  },
  [conceptIds.g311]: {
    subject: {
      id: conceptIds.g311,
      type: 'skos:Concept',
      statements: {
        'schema:url': [{ value: { content: vndbPublicTagConceptUri('cont', 'g311') } }],
        'skos:inScheme': [{ value: { content: schemeIds.cont } }],
      },
    },
  },
  [conceptIds.g44]: {
    subject: {
      id: conceptIds.g44,
      type: 'skos:Concept',
      statements: {
        'schema:url': [{ value: { content: vndbPublicTagConceptUri('ero', 'g44') } }],
        'skos:inScheme': [{ value: { content: schemeIds.ero } }],
      },
    },
  },
  [conceptIds.g7]: {
    subject: {
      id: conceptIds.g7,
      type: 'skos:Concept',
      statements: {
        'schema:url': [{ value: { content: vndbPublicTagConceptUri('tech', 'g7') } }],
        'skos:inScheme': [{ value: { content: schemeIds.tech } }],
      },
    },
  },
};

function port(commands: BatchCommand[]): CrossMediaPort {
  const metadata = sourceRecordMetadataFixture();
  return {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => ({
          key: command.key,
          status: 201 as const,
          value:
            command.op === 'create'
              ? { id: randomUUID(), revision: 1 }
              : command.op === 'propose'
                ? { candidate: randomUUID(), revision: 1 }
                : { revision: 1 },
        })),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {
      throw new Error('No statistic in this authored fixture');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      const known = subjects[id];
      if (!known) return { subject: { id } } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
      return known as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
}

test('extracted COPY public tag columns project exact category and spoiler cells', () => {
  const header = parseVndbCopyHeader(associationHeader, 'tags_vn');
  const cells = parseVndbCopyLine(header, associationCopy[2]!);
  expect(Object.keys(cells)).toEqual([...VNDB_PUBLIC_TAG_COLUMNS.tags_vn]);
  expect(projectVndbPublicTagAssociation(cells)).toEqual({
    tag: 'g44',
    vid: 'v410',
    spoiler: 2,
    vote: 2,
    ignore: false,
    lie: false,
  });
  const tag = projectVndbPublicTag(parseVndbCopyLine(parseVndbCopyHeader(tagsHeader, 'tags'), tagsCopy[0]!));
  expect(tag).toMatchObject({ id: 'g311', category: 'cont', defaultSpoiler: 0, applicable: true });
  expect(JSON.stringify(cells)).not.toContain('secret');
});

test('operator plans authored public tags and imports exact genre proposals through the seed caller', async () => {
  const plan = await planVndbPublicTags(authoredTables());
  expect(plan.records.vndb.map((row) => row.key)).toEqual(['v410']);
  expect(plan.admitted.map((row) => [row.tag, row.category, row.spoiler])).toEqual([
    ['g311', 'cont', 0],
    ['g44', 'ero', 2],
    ['g7', 'tech', 0],
  ]);
  expect(plan.gaps.map((row) => row.reason).sort()).toEqual([
    'Duplicate tag association is not aggregated',
    'Excluded false or confidence tag association',
    'Excluded false or confidence tag association',
    'Unresolved VNDB tag code',
  ]);
  expect(JSON.stringify(plan.gaps)).not.toContain('u9001');
  expect(JSON.stringify(plan.gaps)).not.toContain('u9002');
  expect(JSON.stringify(plan.gaps)).not.toContain('private note');
  expect(JSON.stringify(plan.gaps)).not.toContain('private aggregate');
  expect(JSON.stringify(plan.gaps)).not.toContain('secret lie');
  const commands: BatchCommand[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'vndb-public-tags-'));
  try {
    const bindings = await readVndbPublicTagBindings(port(commands), {
      schemes: [
        { category: 'cont', id: schemeIds.cont },
        { category: 'ero', id: schemeIds.ero },
        { category: 'tech', id: schemeIds.tech },
      ],
      concepts: [
        { category: 'cont', code: 'g311', id: conceptIds.g311 },
        { category: 'ero', code: 'g44', id: conceptIds.g44 },
        { category: 'tech', code: 'g7', id: conceptIds.g7 },
      ],
    });
    expect(bindings.concepts.map((item) => item.code).sort()).toEqual(['g311', 'g44', 'g7']);
    const first = await importVndbPublicTags({
      tables: authoredTables(),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings,
    });
    expect(first.status).toBe('imported-with-gaps');
    expect(first.converterRevision).toBe(converter_revision);
    const proposed = commands.filter((command) => command.op === 'propose');
    const genres = proposed.filter((command) => command.statement.property.id === 'schema:genre');
    expect(genres).toHaveLength(3);
    const content = (command: (typeof genres)[number]) =>
      command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    expect(new Set(genres.map(content))).toEqual(new Set([conceptIds.g311, conceptIds.g44, conceptIds.g7]));
    expect(JSON.stringify(proposed)).not.toContain('vndb-tag-rating');
    expect(JSON.stringify(proposed)).not.toContain('u9001');
    const keys = genres.map((command) => command.key);
    const count = commands.length;
    const again = await importVndbPublicTags({
      tables: authoredTables(),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings,
    });
    expect(again.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    const nextGenres = commands.filter(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:genre',
    );
    expect(nextGenres.map((command) => command.key).slice(0, keys.length)).toEqual(keys);
    expect(commands.length).toBeGreaterThanOrEqual(count);
    subjects[conceptIds.g44] = { subject: { id: conceptIds.g44, type: 'skos:Concept', statements: {} } };
    const withheld = await readVndbPublicTagBindings(port([]), {
      schemes: [
        { category: 'cont', id: schemeIds.cont },
        { category: 'ero', id: schemeIds.ero },
        { category: 'tech', id: schemeIds.tech },
      ],
      concepts: [
        { category: 'cont', code: 'g311', id: conceptIds.g311 },
        { category: 'ero', code: 'g44', id: conceptIds.g44 },
        { category: 'tech', code: 'g7', id: conceptIds.g7 },
      ],
    });
    expect(withheld.concepts.map((item) => item.code).sort()).toEqual(['g311', 'g7']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
