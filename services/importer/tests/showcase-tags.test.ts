import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision, vndbRecordUrl } from '@rezics/conversion/cross-media-entities';
import {
  vndbTagsRatingDocumentation,
  vndbTagsRatingEndpoint,
  vndbTagsRatingMetric,
} from '@rezics/conversion/vndb-vocabulary';
import {
  commandKey,
  sourceDigest,
  sourceEnvelope,
  vndbPublicTagConceptUri,
  vndbPublicTagScheme,
} from '../../../packages/conversion/src/support.ts';
import { showcaseVocabularyExternalId } from '../src/showcase-manifest.ts';
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
  prepareShowcaseTags,
  prepareShowcaseVndbPublicTagVocabulary,
  readShowcaseVndbPublicTagVocabulary,
  projectShowcaseTagTables,
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
const unavailableKanaFetch: typeof fetch = async () => {
  throw new Error('Kana unavailable in authored test');
};

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
  expect(plan.gaps.some((gap) => gap.record.metric === 'vndb.tags.rating')).toBe(false);
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
    const kanaResponse = (rating: number, spoiler: number) =>
      JSON.stringify({
        more: false,
        results: [{ id: 'v410', tags: [{ id: 'g311', rating, spoiler, lie: false }, { id: 'g44', rating: 0.75, spoiler: 0, lie: false }] }],
      });
    const fetchRatings: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(vndbTagsRatingEndpoint);
      expect(JSON.parse(String(init?.body))).toEqual({
        filters: ['id', '=', 'v410'],
        fields: 'id,tags{id,rating,spoiler,lie}',
        results: 1,
      });
      return new Response(kanaResponse(1.25, 1), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const prepared = await prepareShowcaseTags({
      tables: authoredTables(),
      selectedVids: ['v410'],
      port: port(commands),
      known,
      fetch: fetchRatings,
    });
    expect(prepared.tagWeightObservations).toMatchObject([
      { workId: 'v410', state: 'available', bindings: [{ tagId: 'g311', conceptId: conceptIds.g311 }] },
    ]);
    expect(prepared.tagWeightRefreshes).toEqual(['v410']);

    const recorded: { uri: string; state: string }[] = [];
    const first = await importShowcaseTags({
      tables: authoredTables(),
      selectedVids: ['v410'],
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      known,
      fetch: fetchRatings,
      manifest: {
        recordVocabulary(records) {
          recorded.push(...records.map((item) => ({ uri: item.uri, state: item.state })));
        },
      },
    });
    expect(first.status).toBe('imported-with-gaps');
    expect(first.converterRevision).toBe(converter_revision);
    expect(first.tagWeightObservations[0]).toMatchObject({ workId: 'v410', state: 'available' });
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
    expect(genres).toHaveLength(4);
    const content = (command: Extract<BatchCommand, { op: 'propose' }>) =>
      command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    expect(new Set(genres.map(content))).toEqual(new Set([conceptIds.g311, conceptIds.g44]));
    const hasMetric = (command: Extract<BatchCommand, { op: 'propose' }>) =>
      command.statement.qualifiers?.some(
        (term) => term.property.id === 'rezics:sourceTagWeightMetric' && term.value.content === vndbTagsRatingMetric,
      );
    const weights = genres.filter(hasMetric);
    const associations = genres.filter((command) => !hasMetric(command));
    expect(associations).toHaveLength(2);
    expect(weights).toHaveLength(2);
    const spoiler = (rows: Extract<BatchCommand, { op: 'propose' }>[], id: string) =>
      rows
        .find((command) => command.statement.value.type === 'value' && command.statement.value.content === id)
        ?.statement.qualifiers?.find((term) => term.property.id === 'rezics:spoilerLevel')?.value;
    expect(spoiler(associations, conceptIds.g311)).toEqual({ type: 'value', content: { amount: '+0', unit: '1' } });
    expect(spoiler(associations, conceptIds.g44)).toEqual({ type: 'value', content: { amount: '+2', unit: '1' } });
    expect(spoiler(weights, conceptIds.g311)).toEqual({ type: 'value', content: { amount: '+1', unit: '1' } });
    const referenceValue = (command: Extract<BatchCommand, { op: 'propose' }>, property: string) => {
      for (const reference of command.statement.references ?? [])
        for (const part of reference.parts)
          if (part.property.id === property && part.value.type === 'value') return part.value.content;
      return undefined;
    };
    const weight = weights.find((command) => referenceValue(command, 'rezics:sourceTagId') === 'g311')!;
    expect(weight.statement.qualifiers).toContainEqual({
      property: { id: 'rezics:sourceTagWeight' },
      value: { type: 'value', content: { amount: '+1.25', unit: '1' } },
    });
    expect(weight.statement.qualifiers).toContainEqual({
      property: { id: 'rezics:sourceTagWeightMetric' },
      value: { type: 'value', content: vndbTagsRatingMetric },
    });
    expect(weight.statement.references?.[1]?.parts[0]?.value.content).toBe(vndbTagsRatingDocumentation);
    expect(referenceValue(weight, 'rezics:sourceSnapshot')).toBe(
      `unversioned:sha256:${createHash('sha256').update(kanaResponse(1.25, 1)).digest('hex')}`,
    );
    expect(JSON.stringify(weights)).not.toContain('u9001');
    expect(JSON.stringify(weights)).not.toContain('vote');
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
      fetch: async () =>
        new Response(kanaResponse(2.5, 2), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    expect(refreshed.readings.map((row) => row.externalId)).toEqual(['v410']);
    const nextGenres = commands.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:genre',
    );
    expect(nextGenres.map((command) => command.key).slice(0, keys.length)).toEqual(keys);
    const nextWeights = nextGenres.filter(hasMetric);
    expect(nextWeights.length).toBeGreaterThan(weights.length);
    expect(nextWeights.slice(weights.length).map((command) => command.subject)).toEqual(weights.map((command) => command.subject));
    expect(nextWeights.slice(weights.length).map((command) => command.statement.value)).toEqual(weights.map((command) => command.statement.value));
    expect(new Set(nextWeights.map((command) => referenceValue(command, 'rezics:sourceSnapshot'))).size).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('COPY votes never become weights and conflicting or unavailable Kana ratings withhold only weights', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'showcase-tags-invalid-'));
  try {
    const conflicting = await importShowcaseTags({
      tables: authoredTables(),
      selectedVids: ['v410'],
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      known,
      fetch: async () =>
        new Response(
          JSON.stringify({
            more: false,
            results: [
              {
                id: 'v410',
                tags: [
                  { id: 'g311', rating: 1.25, spoiler: 0, lie: false },
                  { id: 'g311', rating: 2.5, spoiler: 0, lie: false },
                  { id: 'g44', rating: 0, spoiler: 0, lie: false },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
    });
    expect(conflicting.tagWeightObservations[0]).toMatchObject({ workId: 'v410', state: 'available' });
    const genres = commands.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:genre',
    );
    expect(genres).toHaveLength(2);
    expect(
      genres.every((command) =>
        command.statement.qualifiers?.every((term) => term.property.id !== 'rezics:sourceTagWeightMetric'),
      ),
    ).toBe(true);
    expect(JSON.stringify(genres)).not.toContain('u9001');
    expect(JSON.stringify(genres)).not.toContain('vote');

    const unavailable = await importShowcaseTags({
      tables: authoredTables(),
      selectedVids: ['v410'],
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      known,
      fetch: unavailableKanaFetch,
    });
    expect(unavailable.tagWeightObservations[0]).toMatchObject({ workId: 'v410', state: 'unavailable' });
    expect(unavailable.admitted.map((row) => row.tag)).toEqual(['g311', 'g44']);
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
      'g311\tcont\t0\tt\tt\t学園\t\\N\t\\N',
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
      for (const command of request.commands) {
        if (command.op !== 'create' && command.op !== 'propose') continue;
        journal.prepareCommand(command);
      }
      const results = request.commands.map((command) => {
        if (command.op === 'create') {
          const id = identities.get(command.source.external_id) ?? randomUUID();
          identities.set(command.source.external_id, id);
          if (!subjects.has(id)) subjects.set(id, { subject: { id, type: command.subject.type, statements: {} } });
          return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
        }
        if (command.op === 'propose') {
          const subject = subjects.get(command.subject)?.subject;
          if (subject) {
            const statement = structuredClone(command.statement) as { value: { type: string; content: unknown } };
            subject.statements[command.statement.property.id] = [statement];
          }
          return { key: command.key, status: 201 as const, value: { candidate: randomUUID(), revision: 1 } };
        }
        return { key: command.key, status: 201 as const, value: { revision: 1 } };
      });
      for (const [index, command] of request.commands.entries()) {
        if (command.op !== 'create' && command.op !== 'propose') continue;
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
      ['skos:Concept', 'vndb.tag.cont:g311', 'v410'],
      ['skos:Concept', 'vndb.tag.ero:g44', 'v410'],
      ['skos:Concept', 'vndb.tag.cont:g12', 'v410'],
      ['skos:Concept', 'vndb.tag.cont:g88', 'v410'],
    ]);
    const conceptLabels = (externalId: string) => {
      const created = commands.find(
        (command) =>
          command.op === 'create' &&
          command.source.external_id === externalId &&
          command.subject.type === 'skos:Concept',
      );
      return created && created.op === 'create' ? created.subject.labels : undefined;
    };
    expect(conceptLabels('vocabulary:vndb.tag.cont:g311')).toEqual({ und: '学園' });
    expect(conceptLabels('vocabulary:vndb.tag.ero:g44')).toEqual({ und: 'Authored erotic tag' });
    expect(conceptLabels('vocabulary:vndb.tag.cont:g12')).toEqual({ und: '親タグ' });
    expect(
      commands
        .filter(
          (command): command is Extract<BatchCommand, { op: 'create' }> =>
            command.op === 'create' && command.subject.type === 'skos:Concept',
        )
        .every((command) => command.subject.labels.und !== undefined && command.subject.labels.ja === undefined),
    ).toBe(true);
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
      fetch: unavailableKanaFetch,
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
    expect(
      imported.vocabulary
        .filter((item) => item.state === 'adopted')
        .map((item) => item.key)
        .sort(),
    ).toEqual(['cont', 'ero', 'g12', 'g311', 'g44', 'g88'].sort());
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
      fetch: unavailableKanaFetch,
    });
    const laterGenres = commands.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:genre',
    );
    expect(laterGenres.filter((command) => content(command) === g311 && !genres.includes(command))).toEqual([]);
    expect(afterRetract.bindings.concepts.map((item) => item.code)).toEqual(['g44']);
    subject.statements['schema:url'] = [{ value: { content: vndbPublicTagScheme('cont') } }];

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

const adapterRevision = 'vndb-public-tag-vocabulary@1';

function guessedTagCreate(input: {
  sourceKey: string;
  uri: string;
  citation: string;
  labels: Record<string, string>;
}): Extract<BatchCommand, { op: 'create' }> {
  const source = sourceEnvelope(
    {
      source: 'vndb_cross_media',
      external_id: showcaseVocabularyExternalId(input.sourceKey),
      record_revision: null,
      converter_revision: adapterRevision,
      digest: sourceDigest({
        sourceKey: input.sourceKey,
        uri: input.uri,
        citations: [input.uri, input.citation],
        adapterRevision,
      }),
    },
    'facts',
  );
  return {
    op: 'create',
    key: `vndb-public-tag-vocabulary:${commandKey([JSON.stringify(source), 'create', 'skos:Concept', JSON.stringify(input.labels)])}`,
    source,
    subject: { type: 'skos:Concept', labels: input.labels },
  };
}

test('reopening a pre-repair journal recovers sealed sends and original Concept identities before any later create', async () => {
  const tables = publicationTables();
  const plan = await planShowcaseTags({ tables, selectedVids: ['v410'] });
  const directory = await mkdtemp(join(tmpdir(), 'showcase-tags-repair-'));
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  const commands: BatchCommand[] = [];
  const prior = journaledPort(journal, commands);
  const kana = guessedTagCreate({
    sourceKey: 'vndb.tag.cont:g12',
    uri: vndbPublicTagConceptUri('cont', 'g12'),
    citation: vndbRecordUrl('g12'),
    labels: { ja: '親タグ' },
  });
  const han = guessedTagCreate({
    sourceKey: 'vndb.tag.cont:g311',
    uri: vndbPublicTagConceptUri('cont', 'g311'),
    citation: vndbRecordUrl('g311'),
    labels: { 'zh-Hant': '学園' },
  });
  try {
    await prior.batch({ commands: [kana] });
    const sealedKanaId = prior.identities.get(kana.source.external_id)!;
    const sealedKana = prior.subjects.get(sealedKanaId)!;
    journal.prepareCommand(han);
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const port = journaledPort(journal, commands);
    port.identities.set(kana.source.external_id, sealedKanaId);
    port.subjects.set(sealedKanaId, sealedKana);
    await prepareShowcaseVndbPublicTagVocabulary({
      tables,
      selectedVids: ['v410'],
      plan,
      port,
      journal,
      stage: 'schemes',
    });
    await prepareShowcaseVndbPublicTagVocabulary({
      tables,
      selectedVids: ['v410'],
      plan,
      port,
      journal,
      stage: 'concepts',
    });
    const creates = commands.filter(
      (command): command is Extract<BatchCommand, { op: 'create' }> =>
        command.op === 'create' && command.subject.type === 'skos:Concept',
    );
    expect(creates.find((command) => command.source.external_id === kana.source.external_id)?.key).toBe(kana.key);
    expect(creates.find((command) => command.source.external_id === kana.source.external_id)?.subject.labels).toEqual({
      ja: '親タグ',
    });
    expect(creates.filter((command) => command.source.external_id === kana.source.external_id)).toHaveLength(1);
    expect(port.identities.get(kana.source.external_id)).toBe(sealedKanaId);
    const recoveredHan = creates.find((command) => command.source.external_id === han.source.external_id);
    expect(recoveredHan?.key).toBe(han.key);
    expect(recoveredHan?.subject.labels).toEqual({ 'zh-Hant': '学園' });
    expect(creates.filter((command) => command.source.external_id === han.source.external_id)).toHaveLength(1);
    expect(
      creates.find((command) => command.source.external_id === 'vocabulary:vndb.tag.ero:g44')?.subject.labels,
    ).toEqual({
      und: 'Authored erotic tag',
    });
    const current = await readShowcaseVndbPublicTagVocabulary({
      tables,
      selectedVids: ['v410'],
      plan,
      port,
      journal,
    });
    expect(current.concepts.find((item) => item.code === 'g12')?.id).toBe(sealedKanaId);
    const imported = await importShowcaseTags({
      tables,
      selectedVids: ['v410'],
      path: join(directory, 'state.sqlite'),
      port,
      known: knownShowcaseTagBindings(current),
      fetch: unavailableKanaFetch,
    });
    const genres = commands.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:genre',
    );
    const content = (command: Extract<BatchCommand, { op: 'propose' }>) =>
      command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    const g311 = current.concepts.find((item) => item.code === 'g311')!.id;
    const g44 = current.concepts.find((item) => item.code === 'g44')!.id;
    expect(g311).not.toBe(sealedKanaId);
    expect(new Set(genres.map(content))).toEqual(new Set([g311, g44]));
    const spoiler = (id: string) =>
      genres
        .find((command) => content(command) === id)
        ?.statement.qualifiers?.find((term) => term.property.id === 'rezics:spoilerLevel')?.value;
    expect(spoiler(g311)).toEqual({ type: 'value', content: { amount: '+0', unit: '1' } });
    expect(spoiler(g44)).toEqual({ type: 'value', content: { amount: '+2', unit: '1' } });
    expect(
      imported.vocabulary
        .filter((item) => item.state === 'adopted')
        .map((item) => item.key)
        .sort(),
    ).toEqual(['cont', 'ero', 'g12', 'g311', 'g44', 'g88'].sort());
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('reviewed tag association bounds let one association from each selected work through voter duplicates', async () => {
  const repeated = Array.from({ length: 300 }, () => ({
    date: '2026-10-24',
    tag: 'g311',
    vid: 'v410',
    uid: 'u9001',
    vote: '3',
    spoiler: '0',
    ignore: 'f',
    lie: 'f',
    notes: null,
  }));
  const input = {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      if (provider !== 'vndb') return;
      if (table === 'tags_vn') yield* [...repeated, { ...repeated[0]!, vid: 'v999' }];
      if (table === 'tags') yield* parseAuthoredVndbCopy('tags', tagsHeader, [tagsCopy[0]!]);
      if (table === 'vn') yield* [{ id: 'v410' }, { id: 'v999' }];
      if (table === 'vn_titles')
        yield* [
          { id: 'v410', official: 't', lang: 'en', title: 'First work', latin: null },
          { id: 'v999', official: 't', lang: 'en', title: 'Second work', latin: null },
        ];
      if (table === 'entry_meta')
        yield* [
          { id: 'v410', revision: 1 },
          { id: 'v999', revision: 1 },
        ];
    },
  };
  const projected = await projectShowcaseTagTables(input, ['v410', 'v999'], new Set(['g311']));
  const associations: Record<string, unknown>[] = [];
  for await (const row of projected.tables.rows('vndb', 'tags_vn')) associations.push(row);
  expect(associations.map((row) => row.vid)).toEqual(['v410', 'v999']);
  expect(projected.truncated).toBe(false);
});
