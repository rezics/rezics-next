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
} from '@rezics/conversion/support';
import { showcaseVocabularyExternalId } from '../src/showcase-manifest.ts';
import type { CrossMediaPort } from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { parseAuthoredVndbCopy } from '../src/vndb-public-tags.ts';
import { VNDB_PUBLIC_TAG_COLUMNS, vndbPublicTagLimits } from '../src/vndb-tables.ts';
import { captureShowcaseCommands, ShowcaseJournal, type ShowcaseReviewPort } from '../src/showcase-publication.ts';
import { showcaseDigest } from '../src/showcase-contract.ts';
import { ImportTransportError, type ReviewedSubjectRead } from '../src/import-client.ts';
import type { VndbTagRatingFetch } from '../src/showcase-vndb-tag-ratings.ts';
import { importShowcaseTags } from '../src/selected-import.ts';
import {
  knownShowcaseTagBindings,
  parseShowcaseTagKnownBindings,
  planShowcaseTags,
  prepareShowcaseTags,
  prepareShowcaseVndbPublicTagVocabulary,
  readShowcaseVndbPublicTagVocabulary,
  projectShowcaseTagTables,
  openReviewedTagCandidates,
  readReviewedTagCandidatePage,
  importerOwnedReviewedTagRetirements,
  completeReviewedSharedTagFlow,
  adoptAcceptedReviewedTagSelection,
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
const unavailableKanaFetch: VndbTagRatingFetch = async () => {
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
  g12: '00000000-0000-4000-8000-000000000032',
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
  [conceptIds.g12]: {
    subject: {
      id: conceptIds.g12,
      type: 'skos:Concept',
      statements: {
        'schema:url': [{ value: { content: vndbPublicTagConceptUri('cont', 'g12') } }],
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
  await expect(
    planShowcaseTags({
      tables: authoredTables(),
      selectedVids: Array.from({ length: 97 }, (_, index) => `v${index + 1}`),
    }),
  ).rejects.toThrow('Selected VNDB work limit exceeded');
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
  expect(plan.sourceParents).toEqual([
    { child: 'g311', parent: 'g12', main: true, category: 'cont', path: '/tags_parents/g311/g12' },
  ]);
  expect(plan.tagParentEvidence).toEqual([]);
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
      { category: 'cont', code: 'g12', id: conceptIds.g12 },
      { category: 'ero', code: 'g44', id: conceptIds.g44 },
    ],
  });
  const commands: BatchCommand[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'showcase-tags-'));
  try {
    const kanaResponse = (rating: number, spoiler: number) =>
      JSON.stringify({
        more: false,
        results: [
          {
            id: 'v410',
            tags: [
              { id: 'g311', rating, spoiler, lie: false },
              { id: 'g44', rating: 0.75, spoiler: 0, lie: false },
            ],
          },
        ],
      });
    const fetchRatings: VndbTagRatingFetch = async (input, init) => {
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
    expect(prepared.tagWeightObservations[0]).toMatchObject({ workId: 'v410', state: 'available' });
    expect(prepared.tagWeightObservations[0]?.bindings.map((item) => [item.tagId, item.conceptId])).toEqual([
      ['g311', conceptIds.g311],
      ['g44', conceptIds.g44],
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
    expect(first.bindings.concepts.map((item) => item.code).sort()).toEqual(['g12', 'g311', 'g44']);
    expect(
      recorded
        .filter((item) => item.state === 'adopted')
        .map((item) => item.uri)
        .sort(),
    ).toEqual(
      [
        vndbPublicTagScheme('cont'),
        vndbPublicTagScheme('ero'),
        vndbPublicTagConceptUri('cont', 'g12'),
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
        (term) =>
          term.property.id === 'rezics:sourceTagWeightMetric' &&
          term.value.type === 'value' &&
          term.value.content === vndbTagsRatingMetric,
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
    expect(
      weight.statement.references?.some((reference) =>
        reference.parts.some(
          (part) =>
            part.property.id === 'schema:url' &&
            part.value.type === 'value' &&
            part.value.content === vndbTagsRatingDocumentation,
        ),
      ),
    ).toBe(true);
    expect(weight.statement.references).toContainEqual({
      parts: [
        {
          property: { id: 'schema:url' },
          value: { type: 'value', content: `${vndbTagsRatingEndpoint}#/tags/g311/rating` },
        },
        { property: { id: 'schema:version' }, value: { type: 'value', content: 'unversioned' } },
      ],
    });
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
    expect(nextWeights.slice(weights.length).map((command) => command.subject)).toEqual(
      weights.map((command) => command.subject),
    );
    expect(nextWeights.slice(weights.length).map((command) => command.statement.value)).toEqual(
      weights.map((command) => command.statement.value),
    );
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
      { category: 'cont', code: 'g12', id: conceptIds.g12 },
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
    const responseCases = [
      [
        'available',
        '{"more":false,"results":[{"id":"v410","tags":[{"id":"g311","rating":null,"spoiler":0,"lie":false},{"id":"g44","spoiler":0,"lie":false}]}]}',
      ],
      [
        'available',
        '{"more":false,"results":[{"id":"v410","tags":[{"id":"g311","rating":2.5,"spoiler":0,"lie":true}]}]}',
      ],
      [
        'unavailable',
        '{"more":false,"results":[{"id":"v999","tags":[{"id":"g311","rating":2.5,"spoiler":0,"lie":false}]}]}',
      ],
      [
        'unavailable',
        '{"more":true,"results":[{"id":"v410","tags":[{"id":"g311","rating":2.5,"spoiler":0,"lie":false}]}]}',
      ],
      ['unavailable', '{"more":false,"results":[{"id":410,"tags":[]}]}'],
      ['unavailable', '{"more":false,"results":[]'],
    ] as const;
    for (const [index, [state, bytes]] of responseCases.entries()) {
      const emitted: BatchCommand[] = [];
      const outcome = await importShowcaseTags({
        tables: authoredTables(),
        selectedVids: ['v410'],
        path: join(directory, `boundary-${index}.sqlite`),
        port: port(emitted),
        known,
        fetch: async () => new Response(bytes),
      });
      expect(outcome.tagWeightObservations[0]?.state).toBe(state);
      expect(outcome.admitted.map((row) => row.tag)).toEqual(['g311', 'g44']);
      expect(JSON.stringify(emitted)).not.toContain('rezics:sourceTagWeight');
    }
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
    const overflowed = await projectShowcaseTagTables(overflow, ['v410']);
    expect(overflowed.truncated).toBe(true);
    expect(overflowed.dictionary.size).toBeLessThanOrEqual(vndbPublicTagLimits.dictionary);
    expect(overflowed.dictionary.has('g2000')).toBe(true);
    expect(overflowed.dictionary.has('g2519')).toBe(false);
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

test('selected rating evidence survives response loss and reopen before terminal refresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-tag-rating-reopen-'));
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  const commands: BatchCommand[] = [];
  let fetches = 0;
  let loseResponse = true;
  const base = port([]);
  const replies = new Map<string, BatchWriteResult['results'][number]>();
  const transport: CrossMediaPort = {
    ...base,
    async batch(request) {
      commands.push(...request.commands);
      const results = [];
      for (const command of request.commands) {
        if (!replies.has(command.key)) {
          const response = await base.batch({ commands: [command] });
          replies.set(command.key, response.results[0]!);
        }
        results.push(replies.get(command.key)!);
      }
      return { results };
    },
  };
  const known = {
    schemes: [{ category: 'cont' as const, id: schemeIds.cont }],
    concepts: [
      { category: 'cont' as const, code: 'g311', id: conceptIds.g311 },
      { category: 'cont' as const, code: 'g12', id: conceptIds.g12 },
    ],
  };
  const fetchRatings: VndbTagRatingFetch = async () => {
    fetches++;
    return new Response(
      `{"more":false,"results":[{"id":"v410","tags":[{"id":"g311","rating":${fetches === 1 ? '2.5000' : '1.2500'},"spoiler":1,"lie":false}]}]}`,
    );
  };
  const input = () => ({
    tables: authoredTables(),
    selectedVids: ['v410'],
    path: join(directory, 'state.sqlite'),
    known,
    fetch: fetchRatings,
    journal,
    port: captureShowcaseCommands(
      {
        ...transport,
        async batch(request) {
          const result = await transport.batch(request);
          if (
            loseResponse &&
            request.commands.some(
              (command) =>
                command.op === 'propose' &&
                command.statement.qualifiers?.some((term) => term.property.id === 'rezics:sourceTagWeight'),
            )
          ) {
            loseResponse = false;
            throw new Error('Lost committed rating response');
          }
          return result;
        },
      },
      journal,
    ),
  });
  try {
    await expect(importShowcaseTags(input())).rejects.toThrow('Durable operations remain unresolved');
    expect(loseResponse).toBe(false);
    const sealed = journal.preparedCommands().filter((row) => row.command.op === 'propose');
    const receipt = journal.vndbTagRatingSource('v410')!;
    expect(sealed.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(receipt.snapshot!.bytes)).toContain('"rating":2.5000');
    expect(JSON.stringify(sealed)).toContain('"amount":"+2.5000"');
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const reopened = await importShowcaseTags(input());
    expect(fetches).toBe(1);
    expect(reopened.tagWeightObservations[0]?.responseDigest).toBe(receipt.snapshot!.digest);
    expect(journal.vndbTagRatingSource('v410')!.snapshot!.bytes).toEqual(receipt.snapshot!.bytes);
    for (const row of sealed)
      expect(commands.filter((command) => command.key === row.command.key)).toEqual([row.command, row.command]);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('reviewed-tag pages separate pending acceptance from rejected rows and retire vanished importer candidates', () => {
  const page = readReviewedTagCandidatePage({
    candidates: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        decision: null,
        retracted: null,
        head: 1,
        statement: {},
        rank: null,
        source: { source: 'vndb', external_id: 'g311' },
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        decision: 'accepted',
        retracted: null,
        rank: 'normal',
        head: 2,
        statement: {},
        source: { source: 'vndb', external_id: 'g12' },
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        decision: 'rejected',
        retracted: null,
        head: 3,
        statement: {},
        rank: null,
        source: { source: 'vndb', external_id: 'g88' },
      },
      {
        id: '00000000-0000-4000-8000-000000000004',
        decision: 'accepted',
        retracted: null,
        head: 4,
        statement: {},
        rank: null,
        source: { source: 'vndb', external_id: 'g99' },
      },
    ],
    next: null,
    adoption: { mode: 'replace', head: 4 },
  });
  const opened = openReviewedTagCandidates(page);
  expect(opened.pending.map((row) => row.id)).toEqual(['00000000-0000-4000-8000-000000000001']);
  expect(opened.accepted.map((row) => row.id)).toEqual([
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000004',
  ]);
  expect(opened.rejected.map((row) => row.id)).toEqual(['00000000-0000-4000-8000-000000000003']);
  expect(importerOwnedReviewedTagRetirements(page, new Set(['g311', 'g12']))).toEqual([
    '00000000-0000-4000-8000-000000000004',
  ]);
});

const schemeId = '00000000-0000-4000-8000-000000000010';
const schemeBId = '00000000-0000-4000-8000-000000000015';
const conceptId = '00000000-0000-4000-8000-000000000011';
const parentBId = '00000000-0000-4000-8000-000000000016';
const workId = '00000000-0000-4000-8000-000000000012';
const pageOneId = '00000000-0000-4000-8000-000000000021';
const pageTwoId = '00000000-0000-4000-8000-000000000022';
const editorialId = '00000000-0000-4000-8000-000000000023';
const vanishedId = '00000000-0000-4000-8000-000000000024';
const extraEditorialId = '00000000-0000-4000-8000-000000000025';

function candidateRow(
  id: string,
  source: { source: string; external_id: string } | null,
  decision: 'accepted' | 'rejected' | null = null,
  rank: 'normal' | 'preferred' | null = null,
) {
  return { id, decision, retracted: null, head: 1, rank, source, statement: {} };
}

function journaledReview(options: {
  schemeAvailable?: boolean;
  loseAdopt?: boolean;
  conflictOnce?: boolean;
  conceptBroader?: string[];
  extraSubjects?: Record<string, ReviewedSubjectRead>;
  workCandidates: {
    first: ReturnType<typeof candidateRow>[];
    second: ReturnType<typeof candidateRow>[];
    adoption?: { head: number; selection: { candidate: string; rank: 'normal' | 'preferred' }[] } | null;
  };
}) {
  const accepted = new Set<string>();
  const adoptKeys: string[] = [];
  const adoptBodies: unknown[] = [];
  const committedAdoptions = new Map<
    string,
    { head: number; selection: { candidate: string; rank: 'normal' | 'preferred' }[] }
  >();
  let schemeAvailable = options.schemeAvailable ?? true;
  let loseAdopt = options.loseAdopt ?? false;
  let conflictOnce = options.conflictOnce ?? false;
  const workCandidates = {
    first: options.workCandidates.first.map((row) => ({ ...row })),
    second: options.workCandidates.second.map((row) => ({ ...row })),
    adoption: options.workCandidates.adoption ?? null,
  };
  const markAccepted = (id: string) => {
    accepted.add(id);
    for (const row of [...workCandidates.first, ...workCandidates.second]) if (row.id === id) row.decision = 'accepted';
  };
  const valueStatement = (content: string) => ({
    value: { type: 'value', content },
  });
  const subjects: Record<string, ReviewedSubjectRead> = {
    [schemeId]: { subject: { id: schemeId, type: 'skos:ConceptScheme', statements: {} } } as ReviewedSubjectRead,
    [conceptId]: {
      subject: {
        id: conceptId,
        type: 'skos:Concept',
        statements: {
          'skos:inScheme': [valueStatement(schemeId)],
          ...(options.conceptBroader?.length
            ? { 'skos:broader': options.conceptBroader.map((id) => valueStatement(id)) }
            : {}),
        },
      },
    } as unknown as ReviewedSubjectRead,
    [workId]: {
      subject: {
        id: workId,
        type: 'schema:VideoGame',
        statements: {
          'schema:genre': [
            {
              id: pageOneId,
              rank: 'normal',
              property: { id: 'schema:genre' },
              value: { type: 'value', content: conceptId },
              qualifiers: [
                {
                  property: { id: 'rezics:sourceTagWeight' },
                  value: { type: 'value', content: { amount: '+2.6', unit: '1' } },
                },
                {
                  property: { id: 'rezics:sourceTagWeightMetric' },
                  value: { type: 'value', content: 'vndbTagsRating' },
                },
              ],
            },
          ],
        },
      },
    } as unknown as ReviewedSubjectRead,
    ...options.extraSubjects,
  };
  const review = {
    adoptKeys,
    adoptBodies,
    accepted,
    setSchemeAvailable(value: boolean) {
      schemeAvailable = value;
    },
    addCandidate(row: ReturnType<typeof candidateRow>) {
      workCandidates.first.push({ ...row });
    },
    setSubject(id: string, read: ReviewedSubjectRead) {
      subjects[id] = read;
    },
    async reviewedCandidates(id: string, query: { property: string; cursor?: string }) {
      if (id !== workId || query.property !== 'schema:genre') return { candidates: [], next: null, adoption: null };
      const currentRows = query.cursor === 'page-2' ? workCandidates.second : workCandidates.first;
      const currentRanks = new Map(workCandidates.adoption?.selection.map((item) => [item.candidate, item.rank]));
      const candidates = currentRows.map((row) => ({
        ...row,
        rank: currentRanks.get(row.id) ?? row.rank,
      }));
      const adoption = workCandidates.adoption
        ? { head: workCandidates.adoption.head, mode: 'replace' as const }
        : null;
      if (query.cursor === 'page-2') return { candidates, next: null, adoption };
      return {
        candidates,
        next: workCandidates.second.length ? 'page-2' : null,
        adoption,
      };
    },
    async acceptReviewedCandidate(_id: string, candidate: string) {
      markAccepted(candidate);
      return { candidate };
    },
    async adoptReviewedCandidates(_id: string, body: unknown, key: string) {
      adoptKeys.push(key);
      adoptBodies.push(body);
      const recovered = committedAdoptions.get(key);
      if (recovered) {
        workCandidates.adoption = recovered;
        return {
          adoption: {
            context: globalContext,
            property: isRecord(body) && typeof body.property === 'string' ? body.property : 'schema:genre',
            mode: 'replace',
            ...recovered,
          },
        };
      }
      if (conflictOnce) {
        conflictOnce = false;
        workCandidates.adoption = {
          head: (workCandidates.adoption?.head ?? 1) + 1,
          selection: workCandidates.adoption?.selection ?? [],
        };
        throw new ImportTransportError(409);
      }
      const selection = isRecord(body) && Array.isArray(body.selection) ? body.selection : [];
      const adoption = {
        head: (workCandidates.adoption?.head ?? 1) + 1,
        selection: selection as { candidate: string; rank: 'normal' | 'preferred' }[],
      };
      workCandidates.adoption = adoption;
      committedAdoptions.set(key, adoption);
      if (loseAdopt) {
        loseAdopt = false;
        throw new Error('Lost committed adoption');
      }
      return {
        adoption: {
          context: globalContext,
          property: isRecord(body) && typeof body.property === 'string' ? body.property : 'schema:genre',
          mode: 'replace',
          ...adoption,
        },
      };
    },
    async readReviewedSubject(id: string) {
      if (id === schemeId && !schemeAvailable) throw new ImportTransportError(404);
      const read = subjects[id];
      if (!read) throw new ImportTransportError(404);
      return read;
    },
    moveHead() {
      if (!workCandidates.adoption) return;
      workCandidates.adoption = { ...workCandidates.adoption, head: workCandidates.adoption.head + 1 };
    },
    conflictNextAdopt() {
      conflictOnce = true;
    },
  };
  return review;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

test('journaled caller paginates, binds distinct refresh keys, applies managed retirement beside editorial selection, and replays unknown delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reviewed-tag-flow-'));
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  try {
    const review = journaledReview({
      loseAdopt: true,
      workCandidates: {
        first: [
          candidateRow(pageOneId, { source: 'vndb', external_id: 'g311' }),
          candidateRow(editorialId, { source: 'editorial', external_id: 'note' }, 'accepted', 'preferred'),
          candidateRow(vanishedId, { source: 'vndb', external_id: 'g99' }, 'accepted', 'normal'),
        ],
        second: [candidateRow(pageTwoId, { source: 'vndb', external_id: 'g12' })],
        adoption: {
          head: 4,
          selection: [
            { candidate: editorialId, rank: 'preferred' },
            { candidate: vanishedId, rank: 'normal' },
          ],
        },
      },
    });
    const input = {
      review: review as unknown as ShowcaseReviewPort,
      schemes: [schemeId],
      concepts: [conceptId],
      works: [workId],
      properties: ['schema:genre'] as const,
    };
    await expect(
      completeReviewedSharedTagFlow({
        ...input,
        journal,
        keepExternalIds: new Set(['g311', 'g12', 'g99']),
      }),
    ).rejects.toThrow('Lost committed adoption');
    expect([...review.accepted].sort()).toEqual([pageOneId, pageTwoId].sort());
    expect(review.adoptKeys).toHaveLength(1);
    const sealedKey = review.adoptKeys[0]!;
    review.moveHead();
    review.addCandidate(
      candidateRow(extraEditorialId, { source: 'editorial', external_id: 'note-2' }, 'accepted'),
    );
    journal.close();
    journal = new ShowcaseJournal(journalPath);

    const replayed = await completeReviewedSharedTagFlow({
      ...input,
      journal,
      keepExternalIds: new Set(['g311', 'g12', 'g99']),
    });
    expect(review.adoptKeys[0]).toBe(sealedKey);
    expect(review.adoptKeys[1]).toBe(sealedKey);
    expect(review.adoptKeys[2]).not.toBe(sealedKey);
    expect(review.adoptKeys).toHaveLength(3);
    expect([...replayed.accepted].sort()).toEqual(
      [editorialId, extraEditorialId, pageOneId, pageTwoId, vanishedId].sort(),
    );
    expect(replayed.adopted[`${workId}:schema:genre`]?.selection.map((row) => row.candidate).sort()).toEqual(
      [editorialId, extraEditorialId, pageOneId, pageTwoId, vanishedId].sort(),
    );

    review.conflictNextAdopt();
    const retired = await completeReviewedSharedTagFlow({
      ...input,
      journal,
      keepExternalIds: new Set(['g311', 'g12']),
      intent: 'retire-g99',
    });
    expect(retired.retiredCandidateIds).toEqual([vanishedId]);
    expect(review.adoptKeys[3]).not.toBe(sealedKey);
    expect(review.adoptKeys[4]).not.toBe(review.adoptKeys[3]);
    expect(retired.adopted[`${workId}:schema:genre`]?.selection.map((row) => row.candidate).sort()).toEqual(
      [editorialId, extraEditorialId, pageOneId, pageTwoId].sort(),
    );
    expect(
      retired.adopted[`${workId}:schema:genre`]?.selection.find((row) => row.candidate === editorialId)?.rank,
    ).toBe('preferred');
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unavailable Scheme withholds membership until independent recovery on unchanged input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reviewed-tag-scheme-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  try {
    const review = journaledReview({
      schemeAvailable: false,
      workCandidates: {
        first: [candidateRow(pageOneId, { source: 'vndb', external_id: 'g311' })],
        second: [],
      },
    });
    const withheld = await completeReviewedSharedTagFlow({
      review: review as unknown as ShowcaseReviewPort,
      journal,
      schemes: [schemeId],
      concepts: [conceptId],
      works: [workId],
      properties: ['schema:genre'],
      keepExternalIds: new Set(['g311']),
    });
    expect(withheld.schemes).toEqual([
      { requestedId: schemeId, currentId: schemeId, type: null, available: false, inScheme: [], broader: [] },
    ]);
    expect(withheld.concepts).toEqual([]);
    expect(withheld.membership).toEqual([]);
    expect(review.accepted.size).toBe(0);

    review.setSchemeAvailable(true);
    const recovered = await completeReviewedSharedTagFlow({
      review: review as unknown as ShowcaseReviewPort,
      journal,
      schemes: [schemeId],
      concepts: [conceptId],
      works: [workId],
      properties: ['schema:genre'],
      keepExternalIds: new Set(['g311']),
    });
    expect(recovered.schemes[0]?.available).toBe(true);
    expect(recovered.concepts[0]?.available).toBe(true);
    expect(recovered.accepted).toEqual([pageOneId]);
    expect(recovered.membership).toEqual([
      {
        workId,
        property: 'schema:genre',
        currentId: workId,
        available: true,
        values: [conceptId],
        weights: [{ target: conceptId, amount: '+2.6', metric: 'vndbTagsRating' }],
      },
    ]);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('two admitted Schemes withhold membership until child and parent share one Scheme', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reviewed-tag-two-scheme-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const valueStatement = (content: string) => ({ value: { type: 'value', content } });
  const parentRead = (scheme: string) =>
    ({
      subject: {
        id: parentBId,
        type: 'skos:Concept',
        statements: { 'skos:inScheme': [valueStatement(scheme)] },
      },
    }) as unknown as ReviewedSubjectRead;
  try {
    const review = journaledReview({
      conceptBroader: [parentBId],
      extraSubjects: {
        [schemeBId]: { subject: { id: schemeBId, type: 'skos:ConceptScheme', statements: {} } } as ReviewedSubjectRead,
        [parentBId]: parentRead(schemeBId),
      },
      workCandidates: {
        first: [candidateRow(pageOneId, { source: 'vndb', external_id: 'g311' })],
        second: [],
      },
    });
    const input = {
      review: review as unknown as ShowcaseReviewPort,
      journal,
      schemes: [schemeId, schemeBId],
      concepts: [conceptId],
      works: [workId],
      properties: ['schema:genre'] as const,
      keepExternalIds: new Set(['g311']),
    };
    const withheld = await completeReviewedSharedTagFlow(input);
    expect(withheld.schemes.every((row) => row.available && row.type === 'skos:ConceptScheme')).toBe(true);
    expect(withheld.concepts[0]).toMatchObject({ requestedId: conceptId, available: true, type: 'skos:Concept' });
    expect(withheld.membership).toEqual([]);
    expect(review.accepted.size).toBe(0);

    review.setSubject(parentBId, parentRead(schemeId));
    const recovered = await completeReviewedSharedTagFlow(input);
    expect(recovered.concepts[0]?.available).toBe(true);
    expect(recovered.accepted).toEqual([pageOneId]);
    expect(recovered.membership).toEqual([
      {
        workId,
        property: 'schema:genre',
        currentId: workId,
        available: true,
        values: [conceptId],
        weights: [{ target: conceptId, amount: '+2.6', metric: 'vndbTagsRating' }],
      },
    ]);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const globalContext = '00000000-0000-8000-8000-000000000000';

function reviewedTagAdoptKey(subjectId: string, property: string, digest: string) {
  return `adopt:${showcaseDigest({ identity: `${subjectId}:${property}`, digest })}`;
}

function reviewedTagAdoptBody(
  selection: { candidate: string; rank: 'normal' | 'preferred' }[],
  head: number | null = 1,
) {
  return {
    context: globalContext,
    property: 'schema:genre',
    mode: 'replace' as const,
    expected_head: head,
    selection,
  };
}

test('reviewed-tag adopt resumes previous-format and later prepared keys before matching acknowledgements, then continues past 32 generations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reviewed-tag-adopt-lifetime-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const intent = 'current';
  const planned = reviewedTagAdoptBody([{ candidate: pageOneId, rank: 'normal' }]);
  const other = reviewedTagAdoptBody([{ candidate: editorialId, rank: 'preferred' }]);
  try {
    const historical = journaledReview({
      workCandidates: {
        first: [candidateRow(pageOneId, { source: 'vndb', external_id: 'g311' }, 'accepted', 'normal')],
        second: [],
        adoption: { head: 4, selection: planned.selection },
      },
    });
    const laterKey = reviewedTagAdoptKey(workId, 'schema:genre', showcaseDigest({ intent, generation: 1 }));
    journal.prepareAction(laterKey, planned, showcaseDigest({ action: laterKey, body: planned }));
    const resumed = await adoptAcceptedReviewedTagSelection(
      historical as unknown as Pick<ShowcaseReviewPort, 'reviewedCandidates' | 'adoptReviewedCandidates'>,
      workId,
      'schema:genre',
      journal,
      { intent },
    );
    expect(resumed.complete).toBe(true);
    expect(historical.adoptKeys).toEqual([journal.action(laterKey)!.idempotency_key]);
    expect(historical.adoptBodies[0]).toEqual(planned);

    const previousJournal = new ShowcaseJournal(join(directory, 'previous.sqlite'));
    const previousKey = reviewedTagAdoptKey(workId, 'schema:genre', showcaseDigest({ intent, body: planned }));
    previousJournal.prepareAction(previousKey, planned, showcaseDigest({ action: previousKey, body: planned }));
    const previousReview = journaledReview({
      workCandidates: {
        first: [candidateRow(pageOneId, { source: 'vndb', external_id: 'g311' }, 'accepted', 'normal')],
        second: [],
        adoption: { head: 4, selection: planned.selection },
      },
    });
    const previous = await adoptAcceptedReviewedTagSelection(
      previousReview as unknown as Pick<ShowcaseReviewPort, 'reviewedCandidates' | 'adoptReviewedCandidates'>,
      workId,
      'schema:genre',
      previousJournal,
      { intent },
    );
    expect(previous.complete).toBe(true);
    expect(previousReview.adoptKeys).toHaveLength(1);
    previousJournal.close();

    const boundJournal = new ShowcaseJournal(join(directory, 'bound.sqlite'));
    for (let generation = 0; generation < 32; generation += 1) {
      const action = reviewedTagAdoptKey(workId, 'schema:genre', showcaseDigest({ intent, generation }));
      boundJournal.prepareAction(action, other, `bound-${generation}`);
      boundJournal.acknowledgeAction(action);
    }
    const boundReview = journaledReview({
      workCandidates: {
        first: [candidateRow(pageOneId, { source: 'vndb', external_id: 'g311' }, 'accepted', 'normal')],
        second: [],
      },
    });
    const continued = await adoptAcceptedReviewedTagSelection(
      boundReview as unknown as Pick<ShowcaseReviewPort, 'reviewedCandidates' | 'adoptReviewedCandidates'>,
      workId,
      'schema:genre',
      boundJournal,
      { intent },
    );
    expect(continued.complete).toBe(true);
    expect(boundReview.adoptKeys).toHaveLength(1);
    boundJournal.close();

    const unknownPath = join(directory, 'unknown.sqlite');
    let unknownJournal = new ShowcaseJournal(unknownPath);
    for (let generation = 0; generation < 32; generation += 1) {
      const action = reviewedTagAdoptKey(workId, 'schema:genre', showcaseDigest({ intent, generation }));
      unknownJournal.prepareAction(action, other, `unknown-${generation}`);
      unknownJournal.acknowledgeAction(action);
    }
    const unknownReview = journaledReview({
      loseAdopt: true,
      workCandidates: {
        first: [candidateRow(pageOneId, { source: 'vndb', external_id: 'g311' }, 'accepted', 'normal')],
        second: [],
      },
    });
    await expect(
      adoptAcceptedReviewedTagSelection(
        unknownReview as unknown as Pick<ShowcaseReviewPort, 'reviewedCandidates' | 'adoptReviewedCandidates'>,
        workId,
        'schema:genre',
        unknownJournal,
        { intent },
      ),
    ).rejects.toThrow('Lost committed adoption');
    expect(unknownReview.adoptKeys).toHaveLength(1);
    const sealedKey = unknownReview.adoptKeys[0]!;
    const sealedBody = unknownReview.adoptBodies[0];
    unknownJournal.close();
    unknownJournal = new ShowcaseJournal(unknownPath);
    const starve = {
      context: globalContext,
      property: 'schema:keywords',
      mode: 'replace' as const,
      expected_head: 0,
      selection: [] as { candidate: string; rank: 'normal' }[],
    };
    for (let index = 0; index < 64; index += 1)
      unknownJournal.prepareAction(`adopt:${index.toString(16).padStart(64, '0')}`, starve, `starve-${index}`);
    unknownReview.moveHead();
    const recovered = await adoptAcceptedReviewedTagSelection(
      unknownReview as unknown as Pick<ShowcaseReviewPort, 'reviewedCandidates' | 'adoptReviewedCandidates'>,
      workId,
      'schema:genre',
      unknownJournal,
      { intent },
    );
    expect(recovered.complete).toBe(true);
    expect(unknownReview.adoptKeys).toEqual([sealedKey, sealedKey]);
    expect(unknownReview.adoptBodies[1]).toEqual(sealedBody);
    unknownJournal.close();
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reviewed-tag adopt recovers identity-bound generation 32 after close, a later recorded window, and another property prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reviewed-tag-unknown-32-'));
  const path = join(directory, 'showcase.sqlite');
  const intent = 'current';
  const planned = reviewedTagAdoptBody([{ candidate: pageOneId, rank: 'normal' }]);
  const other = reviewedTagAdoptBody([{ candidate: editorialId, rank: 'preferred' }]);
  const identity = `${workId}:schema:genre:${intent}`;
  const sealedKey = 'unknown-32';
  let journal = new ShowcaseJournal(path);
  try {
    for (let generation = 0; generation < 32; generation += 1) {
      const action = reviewedTagAdoptKey(workId, 'schema:genre', showcaseDigest({ intent, generation }));
      journal.prepareAction(action, other, `acked-${generation}`);
      journal.acknowledgeAction(action);
    }
    const generation32 = reviewedTagAdoptKey(workId, 'schema:genre', showcaseDigest({ intent, generation: 32 }));
    journal.prepareAction(generation32, planned, sealedKey);
    journal.recordPendingAdopt(identity, generation32);
    journal.advanceAdoptGeneration(identity, 70);
    journal.close();

    journal = new ShowcaseJournal(path);
    const starve = {
      context: globalContext,
      property: 'schema:keywords',
      mode: 'replace' as const,
      expected_head: 0,
      selection: [] as { candidate: string; rank: 'normal' }[],
    };
    for (let index = 0; index < 64; index += 1)
      journal.prepareAction(`adopt:${index.toString(16).padStart(64, '0')}`, starve, `starve-${index}`);
    const review = journaledReview({
      workCandidates: {
        first: [candidateRow(pageOneId, { source: 'vndb', external_id: 'g311' }, 'accepted', 'normal')],
        second: [],
        adoption: { head: 9, selection: other.selection },
      },
    });
    review.moveHead();
    const recovered = await adoptAcceptedReviewedTagSelection(
      review as unknown as Pick<ShowcaseReviewPort, 'reviewedCandidates' | 'adoptReviewedCandidates'>,
      workId,
      'schema:genre',
      journal,
      { intent },
    );
    expect(recovered.complete).toBe(true);
    expect(review.adoptKeys).toEqual([sealedKey]);
    expect(review.adoptBodies[0]).toEqual(planned);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reviewed-tag adopt replays a historical acknowledgement into later unknown delivery, then a distinct sealed retirement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reviewed-tag-unknown-delivery-'));
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  try {
    const review = journaledReview({
      loseAdopt: true,
      workCandidates: {
        first: [candidateRow(pageOneId, { source: 'vndb', external_id: 'g311' })],
        second: [],
      },
    });
    const input = {
      review: review as unknown as ShowcaseReviewPort,
      schemes: [schemeId],
      concepts: [conceptId],
      works: [workId],
      properties: ['schema:genre'] as const,
      keepExternalIds: new Set(['g311']),
    };
    await expect(completeReviewedSharedTagFlow({ ...input, journal })).rejects.toThrow('Lost committed adoption');
    const sealedKey = review.adoptKeys[0]!;
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const recovered = await completeReviewedSharedTagFlow({ ...input, journal });
    expect(review.adoptKeys).toEqual([sealedKey, sealedKey]);
    expect(recovered.accepted).toEqual([pageOneId]);
    const unchanged = await completeReviewedSharedTagFlow({ ...input, journal });
    expect(review.adoptKeys).toHaveLength(2);
    expect(unchanged.adopted[`${workId}:schema:genre`]?.selection).toEqual([{ candidate: pageOneId, rank: 'normal' }]);
    review.addCandidate(
      candidateRow(editorialId, { source: 'editorial', external_id: 'note' }, 'accepted', 'preferred'),
    );
    const changed = await completeReviewedSharedTagFlow({ ...input, journal, intent: 'include-editorial' });
    expect(review.adoptKeys[2]).not.toBe(sealedKey);
    expect(changed.adopted[`${workId}:schema:genre`]?.selection.map((row) => row.candidate).sort()).toEqual(
      [editorialId, pageOneId].sort(),
    );
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
