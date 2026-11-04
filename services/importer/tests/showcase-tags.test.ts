import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision } from '@rezics/conversion/cross-media-entities';
import { vndbPublicTagConceptUri, vndbPublicTagScheme } from '../../../packages/conversion/src/support.ts';
import type { CrossMediaPort } from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { parseAuthoredVndbCopy } from '../src/vndb-public-tags.ts';
import { VNDB_PUBLIC_TAG_COLUMNS } from '../src/vndb-tables.ts';
import { ShowcaseJournal } from '../src/showcase-publication.ts';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import {
  importShowcaseTags,
  knownShowcaseTagBindings,
  parseShowcaseTagKnownBindings,
  planShowcaseTags,
  prepareShowcaseVndbPublicTagVocabulary,
  readShowcaseVndbPublicTagVocabulary,
  showcaseTagWeightGapReason,
  showcaseTagWeightProperty,
} from '../src/showcase-tags.ts';

const tagsHeader = VNDB_PUBLIC_TAG_COLUMNS.tags.join('\t');
const associationHeader = VNDB_PUBLIC_TAG_COLUMNS.tags_vn.join('\t');
const parentHeader = VNDB_PUBLIC_TAG_COLUMNS.tags_parents.join('\t');
const tagsCopy = [
  'g311\tcont\t0\tt\tt\tAuthored content tag\t\\N\t\\N',
  'g44\tero\t2\tt\tt\tAuthored erotic tag\t\\N\t\\N',
  'g12\tcont\t0\tt\tt\tAuthored parent tag\t\\N\t\\N',
  'g88\tcont\t0\tt\tt\tAuthored false tag\t\\N\t\\N',
  'g50\t????\t0\tt\tt\tMalformed category\t\\N\t\\N',
  'g900\tcont\t0\tt\tt\tUnrelated work tag\t\\N\t\\N',
];
const associationCopy = [
  '2026-10-24\tg311\tv410\tu9001\t3\t0\tf\tf\tprivate note',
  '2026-10-24\tg44\tv410\tu9001\t2\t2\tf\tf\t\\N',
  '2026-10-24\tg88\tv410\tu9001\t-2\t0\tf\tt\tsecret lie',
  '2026-10-24\tg50\tv410\tu9001\t2\t0\tf\tf\t\\N',
  '2026-10-24\tg900\tv999\tu9001\t3\t0\tf\tf\t\\N',
];
const parentCopy = ['g311\tg12\tt'];

function authoredTables() {
  const rows: Record<string, Record<string, unknown>[]> = {
    'vndb/vn': [
      { id: 'v410', olang: 'en' },
      { id: 'v999', olang: 'en' },
    ],
    'vndb/vn_titles': [
      { id: 'v410', lang: 'en', official: 't', title: 'Selected public tag work', latin: null },
      { id: 'v999', lang: 'en', official: 't', title: 'Unrelated work', latin: null },
    ],
    'vndb/entry_meta': [
      { id: 'v410', revision: 7, lastmod: '2026-10-24' },
      { id: 'v999', revision: 3, lastmod: '2026-10-24' },
    ],
    'vndb/tags': parseAuthoredVndbCopy('tags', tagsHeader, tagsCopy),
    'vndb/tags_vn': parseAuthoredVndbCopy('tags_vn', associationHeader, associationCopy),
    'vndb/tags_parents': parseAuthoredVndbCopy('tags_parents', parentHeader, parentCopy),
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
};
const conceptIds = {
  g311: '00000000-0000-4000-8000-000000000030',
  g44: '00000000-0000-4000-8000-000000000031',
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

test('default showcase adapter projects selected COPY tags with admitted, unsupported and qualified associations', async () => {
  const plan = await planShowcaseTags({ tables: authoredTables(), selectedVids: ['v410'] });
  expect(plan.records.vndb.map((row) => row.key)).toEqual(['v410']);
  expect(plan.admitted.map((row) => [row.tag, row.category, row.spoiler])).toEqual([
    ['g311', 'cont', 0],
    ['g44', 'ero', 2],
  ]);
  expect(plan.weightGap?.property).toBe(showcaseTagWeightProperty);
  expect(plan.weightGap?.reason).toBe(showcaseTagWeightGapReason);
  expect(plan.vocabulary.map((item) => [item.kind, item.key, item.uri])).toEqual([
    ['scheme', 'cont', vndbPublicTagScheme('cont')],
    ['scheme', 'ero', vndbPublicTagScheme('ero')],
    ['concept', 'g12', vndbPublicTagConceptUri('cont', 'g12')],
    ['concept', 'g311', vndbPublicTagConceptUri('cont', 'g311')],
    ['concept', 'g44', vndbPublicTagConceptUri('ero', 'g44')],
    ['concept', 'g88', vndbPublicTagConceptUri('cont', 'g88')],
  ]);
  expect(plan.gaps.some((gap) => gap.reason.includes('Parent tag relationship is not admitted'))).toBe(true);
  expect(plan.gaps.some((gap) => gap.reason === 'Excluded false or confidence tag association')).toBe(true);
  expect(JSON.stringify(plan)).not.toContain('v999');
  expect(JSON.stringify(plan)).not.toContain('g900');
  expect(JSON.stringify(plan)).not.toContain('u9001');
  expect(JSON.stringify(plan)).not.toContain('private note');
  expect(JSON.stringify(plan.admitted)).not.toContain('vote');

  const known = parseShowcaseTagKnownBindings({
    schemes: [
      { category: 'cont', id: schemeIds.cont },
      { category: 'ero', id: schemeIds.ero },
    ],
    concepts: [
      { category: 'cont', code: 'g311', id: conceptIds.g311 },
      { category: 'ero', code: 'g44', id: conceptIds.g44 },
    ],
  });
  const commands: BatchCommand[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'showcase-tags-'));
  try {
    const recorded: { uri: string; state: string }[] = [];
    const first = await importShowcaseTags({
      tables: authoredTables(),
      selectedVids: ['v410'],
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      known,
      manifest: {
        recordVocabulary(records) {
          recorded.push(...records.map((item) => ({ uri: item.uri, state: item.state })));
        },
      },
    });
    expect(first.status).toBe('imported-with-gaps');
    expect(first.converterRevision).toBe(converter_revision);
    expect(first.weightGap?.property).toBe(showcaseTagWeightProperty);
    expect(first.bindings.concepts.map((item) => item.code).sort()).toEqual(['g311', 'g44']);
    expect(
      recorded
        .filter((item) => item.state === 'adopted')
        .map((item) => item.uri)
        .sort(),
    ).toEqual(
      [
        vndbPublicTagScheme('cont'),
        vndbPublicTagScheme('ero'),
        vndbPublicTagConceptUri('cont', 'g311'),
        vndbPublicTagConceptUri('ero', 'g44'),
      ].sort(),
    );
    const genres = commands.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:genre',
    );
    expect(genres).toHaveLength(2);
    const content = (command: Extract<BatchCommand, { op: 'propose' }>) =>
      command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    expect(new Set(genres.map(content))).toEqual(new Set([conceptIds.g311, conceptIds.g44]));
    const spoiler = (id: string) =>
      genres
        .find((command) => content(command) === id)
        ?.statement.qualifiers?.find((term) => term.property.id === 'rezics:spoilerLevel')?.value;
    expect(spoiler(conceptIds.g311)).toEqual({ type: 'value', content: { amount: '+0', unit: '1' } });
    expect(spoiler(conceptIds.g44)).toEqual({ type: 'value', content: { amount: '+2', unit: '1' } });
    expect(JSON.stringify(commands)).not.toContain(showcaseTagWeightProperty);
    expect(JSON.stringify(commands)).not.toContain('vndb-tag-rating');
    const keys = genres.map((command) => command.key);
    const original = associationCopy.slice();
    original[0] = '2026-10-24\tg311\tv410\tu9001\t3\t1\tf\tf\tprivate note';
    const rows: Record<string, Record<string, unknown>[]> = {
      'vndb/vn': [{ id: 'v410', olang: 'en' }],
      'vndb/vn_titles': [{ id: 'v410', lang: 'en', official: 't', title: 'Selected public tag work', latin: null }],
      'vndb/entry_meta': [{ id: 'v410', revision: 7, lastmod: '2026-10-24' }],
      'vndb/tags': parseAuthoredVndbCopy('tags', tagsHeader, tagsCopy),
      'vndb/tags_vn': parseAuthoredVndbCopy('tags_vn', associationHeader, original),
      'vndb/tags_parents': parseAuthoredVndbCopy('tags_parents', parentHeader, parentCopy),
    };
    const refreshed = await importShowcaseTags({
      tables: {
        async *rows(provider, table) {
          yield* rows[`${provider}/${table}`] ?? [];
        },
      },
      selectedVids: ['v410'],
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      known,
    });
    expect(refreshed.readings.map((row) => row.externalId)).toEqual(['v410']);
    const nextGenres = commands.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:genre',
    );
    expect(nextGenres.map((command) => command.key).slice(0, keys.length)).toEqual(keys);
    expect(nextGenres.length).toBeGreaterThan(keys.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

function publicationTables(overrides: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  const rows: Record<string, Record<string, unknown>[]> = {
    'vndb/vn': [{ id: 'v410', olang: 'en' }],
    'vndb/vn_titles': [{ id: 'v410', lang: 'en', official: 't', title: 'Selected public tag work', latin: null }],
    'vndb/entry_meta': [{ id: 'v410', revision: 7, lastmod: '2026-10-24' }],
    'vndb/tags': parseAuthoredVndbCopy('tags', tagsHeader, [
      'g311\tcont\t0\tt\tt\tAuthored content tag\t\\N\t\\N',
      'g44\tero\t2\tt\tt\tAuthored erotic tag\t\\N\t\\N',
      'g12\tcont\t0\tt\tt\t親タグ\t\\N\t\\N',
      'g88\tcont\t0\tt\tt\tAuthored false tag\t\\N\t\\N',
    ]),
    'vndb/tags_vn': parseAuthoredVndbCopy('tags_vn', associationHeader, [
      '2026-10-24\tg311\tv410\tu9001\t3\t0\tf\tf\tprivate note',
      '2026-10-24\tg44\tv410\tu9001\t2\t2\tf\tf\t\\N',
      '2026-10-24\tg88\tv410\tu9001\t-2\t0\tf\tt\tsecret lie',
    ]),
    'vndb/tags_parents': parseAuthoredVndbCopy('tags_parents', parentHeader, ['g311\tg12\tt']),
    ...overrides,
  };
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

function journaledPort(journal: ShowcaseJournal, commands: BatchCommand[]) {
  const metadata = sourceRecordMetadataFixture();
  const identities = new Map<string, string>();
  const subjects = new Map<string, { subject: { id: string; type: string; statements: Record<string, unknown[]> } }>();
  return {
    subjects,
    identities,
    async batch(request: { commands: BatchCommand[] }): Promise<BatchWriteResult> {
      commands.push(...request.commands);
      for (const command of request.commands) journal.prepareCommand(command);
      const results = request.commands.map((command) => {
        if (command.op === 'create') {
          const id = identities.get(command.source.external_id) ?? randomUUID();
          identities.set(command.source.external_id, id);
          if (!subjects.has(id)) subjects.set(id, { subject: { id, type: command.subject.type, statements: {} } });
          return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
        }
        const subject = command.op === 'propose' ? subjects.get(command.subject)?.subject : undefined;
        if (subject && command.op === 'propose') {
          const statement = structuredClone(command.statement) as { value: { type: string; content: unknown } };
          subject.statements[command.statement.property.id] = [statement];
        }
        return { key: command.key, status: 201 as const, value: { candidate: randomUUID(), revision: 1 } };
      });
      for (const [index, command] of request.commands.entries()) {
        journal.acknowledgeCommand(
          command,
          results[index]! as Extract<BatchWriteResult['results'][number], { status: 200 | 201 }>,
        );
      }
      return { results } as BatchWriteResult;
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {
      throw new Error('No statistic in this authored fixture');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id: string) {
      const found = subjects.get(id);
      if (found) return found as ReviewedSubjectRead;
      return { subject: { id } } as ReviewedSubjectRead;
    },
  } satisfies CrossMediaPort & {
    subjects: Map<string, { subject: { id: string; type: string; statements: Record<string, unknown[]> } }>;
    identities: Map<string, string>;
  };
}

test('default seed publishes dictionary without a UUID file, rereads, and withholds changed or overflowing tags', async () => {
  const tables = publicationTables();
  const plan = await planShowcaseTags({ tables, selectedVids: ['v410'] });
  const directory = await mkdtemp(join(tmpdir(), 'showcase-tags-default-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const commands: BatchCommand[] = [];
  const port = journaledPort(journal, commands);
  try {
    await prepareShowcaseVndbPublicTagVocabulary({
      tables,
      selectedVids: ['v410'],
      plan,
      port,
      journal,
      stage: 'schemes',
    });
    const prepared = await prepareShowcaseVndbPublicTagVocabulary({
      tables,
      selectedVids: ['v410'],
      plan,
      port,
      journal,
      stage: 'concepts',
    });
    expect(prepared.requirements.map((item) => [item.nativeType, item.sourceKey, item.ownerKey])).toEqual([
      ['skos:ConceptScheme', 'vndb.tag.cont', 'v410'],
      ['skos:ConceptScheme', 'vndb.tag.ero', 'v410'],
      ['skos:Concept', 'vndb.tag.cont:g12', 'v410'],
      ['skos:Concept', 'vndb.tag.cont:g311', 'v410'],
      ['skos:Concept', 'vndb.tag.cont:g88', 'v410'],
      ['skos:Concept', 'vndb.tag.ero:g44', 'v410'],
    ]);
    const parentCreate = commands.find(
      (command) =>
        command.op === 'create' &&
        command.source.external_id === 'vocabulary:vndb.tag.cont:g12' &&
        command.subject.type === 'skos:Concept',
    );
    expect(parentCreate && parentCreate.op === 'create' ? parentCreate.subject.labels : undefined).toEqual({
      ja: '親タグ',
    });
    const current = await readShowcaseVndbPublicTagVocabulary({
      tables,
      selectedVids: ['v410'],
      plan,
      port,
      journal,
    });
    expect(current.concepts.map((item) => item.code).sort()).toEqual(['g12', 'g311', 'g44', 'g88']);
    const imported = await importShowcaseTags({
      tables,
      selectedVids: ['v410'],
      path: join(directory, 'state.sqlite'),
      port,
      known: knownShowcaseTagBindings(current),
    });
    const genres = commands.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:genre',
    );
    const content = (command: Extract<BatchCommand, { op: 'propose' }>) =>
      command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    const g311 = current.concepts.find((item) => item.code === 'g311')!.id;
    const g44 = current.concepts.find((item) => item.code === 'g44')!.id;
    expect(new Set(genres.map(content))).toEqual(new Set([g311, g44]));
    const spoiler = (id: string) =>
      genres
        .find((command) => content(command) === id)
        ?.statement.qualifiers?.find((term) => term.property.id === 'rezics:spoilerLevel')?.value;
    expect(spoiler(g311)).toEqual({ type: 'value', content: { amount: '+0', unit: '1' } });
    expect(spoiler(g44)).toEqual({ type: 'value', content: { amount: '+2', unit: '1' } });
    expect(imported.vocabulary.filter((item) => item.state === 'adopted').map((item) => item.key).sort()).toEqual(
      ['cont', 'ero', 'g12', 'g311', 'g44', 'g88'].sort(),
    );
    expect(JSON.stringify({ commands, imported, prepared })).not.toContain('u9001');
    expect(JSON.stringify({ commands, imported, prepared })).not.toContain('private note');
    expect(JSON.stringify(genres)).not.toContain('vote');

    const before = [...current.concepts].sort((left, right) => left.code.localeCompare(right.code));
    await prepareShowcaseVndbPublicTagVocabulary({
      tables,
      selectedVids: ['v410'],
      plan,
      port,
      journal,
      stage: 'concepts',
    });
    const rerun = await readShowcaseVndbPublicTagVocabulary({
      tables,
      selectedVids: ['v410'],
      plan,
      port,
      journal,
    });
    expect([...rerun.concepts].sort((left, right) => left.code.localeCompare(right.code))).toEqual(before);

    const contScheme = current.schemes.find((item) => item.taxonomy === 'vndb.tag.cont')!;
    const subject = port.subjects.get(contScheme.id)!.subject;
    subject.statements['schema:url'] = [{ value: { content: 'https://rezics.com/schemes/vndb/public-tags/other' } }];
    const withheld = await readShowcaseVndbPublicTagVocabulary({
      tables,
      selectedVids: ['v410'],
      plan,
      port,
      journal,
    });
    expect(withheld.concepts.map((item) => item.code).sort()).toEqual(['g44']);
    const afterRetract = await importShowcaseTags({
      tables,
      selectedVids: ['v410'],
      path: join(directory, 'state.sqlite'),
      port,
      known: knownShowcaseTagBindings(withheld),
    });
    const laterGenres = commands.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:genre',
    );
    expect(laterGenres.filter((command) => content(command) === g311 && !genres.includes(command))).toEqual([]);
    expect(afterRetract.bindings.concepts.map((item) => item.code)).toEqual(['g44']);

    const overflowParents = Array.from({ length: 520 }, (_, index) => `g${2000 + index}`);
    const overflow = publicationTables({
      'vndb/tags': parseAuthoredVndbCopy('tags', tagsHeader, [
        'g311\tcont\t0\tt\tt\tAuthored content tag\t\\N\t\\N',
        'g44\tero\t2\tt\tt\tAuthored erotic tag\t\\N\t\\N',
        ...overflowParents.map((id) => `${id}\tcont\t0\tt\tt\tOverflow ${id}\t\\N\t\\N`),
      ]),
      'vndb/tags_parents': parseAuthoredVndbCopy(
        'tags_parents',
        parentHeader,
        overflowParents.map((id) => `g311\t${id}\tt`),
      ),
    });
    const overflowed = await prepareShowcaseVndbPublicTagVocabulary({
      tables: overflow,
      selectedVids: ['v410'],
      plan,
      port,
      journal,
      stage: 'concepts',
    });
    expect(overflowed.truncated).toBe(true);
    expect(overflowed.requirements.some((item) => item.sourceKey.endsWith(':g2000'))).toBe(true);
    expect(overflowed.requirements.some((item) => item.sourceKey.endsWith(':g2519'))).toBe(false);
    expect(overflowed.requirements.some((item) => item.sourceKey === 'vndb.tag.ero:g44')).toBe(true);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
