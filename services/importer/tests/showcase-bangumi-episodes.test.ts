import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BATCH_LIMIT, type BatchCommand } from '@rezics/definitions/bulk';
import { bundledDigest } from '@rezics/definitions/bundled';
import { bangumiRecordUrl } from '@rezics/conversion/cross-media-entities';
import type { SourceVocabularyBindings } from '@rezics/conversion';
import type { CrossMediaPort, CrossMediaTables } from '../src/cross-media-seed.ts';
import { planCrossMediaSeed, seedCrossMedia } from '../src/cross-media-seed.ts';
import { composeVocabularyAdmissions, SHOWCASE_EPISODE_WINDOW } from '../src/showcase-bangumi-episodes.ts';
import { episodeTypeConceptUri, episodeTypeSchemeUri } from '../src/bangumi-episode-fidelity.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const schemeId = '00000000-0000-4000-8000-000000000190';
const mainKindId = '00000000-0000-4000-8000-000000000191';
const withheldKindId = '00000000-0000-4000-8000-000000000192';
const catalogueSubjects = {
  'bangumi-episode-types-scheme': schemeId,
  'bangumi-episode-type-0': mainKindId,
  'bangumi-episode-type-1': withheldKindId,
};

function tables(): CrossMediaTables {
  const fillerCount = Math.max(0, BATCH_LIMIT - 2);
  const episodes = [
    {
      id: 900001,
      subject_id: 81,
      name: 'Main episode',
      sort: 1.5,
      type: 0,
      airdate: '2006-04-06',
      duration: '24m',
      description: 'A source-attributed episode summary.',
    },
    { id: 900003, subject_id: 99, name: 'Unrelated episode', sort: 1, type: 1 },
    { id: 900002, subject_id: 81, name: 'Fractional special', sort: 0, type: 1 },
    ...Array.from({ length: fillerCount }, (_, index) => ({
      id: 910000 + index,
      subject_id: 81,
      name: `Selected episode ${index}`,
      sort: index + 2,
      type: 0,
    })),
    { id: 999999, subject_id: 81, name: 'Overflow episode', sort: 999, type: 0 },
  ];
  return {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') {
        yield { id: 81, type: 2, name: 'STEINS;GATE' };
        yield { id: 99, type: 2, name: 'Unrelated title' };
        yield { id: 82, type: 2, name: 'CLANNAD' };
        yield { id: 83, type: 2, name: 'Fate/stay night' };
      }
      if (provider === 'bangumi' && table === 'episode') yield* episodes;
      if (provider === 'vndb' && table === 'vn_titles') {
        yield { id: 'v81', lang: 'ja', title: 'STEINS;GATE', latin: 'STEINS;GATE', official: 't' };
        yield { id: 'v82', lang: 'ja', title: 'CLANNAD', latin: 'CLANNAD', official: 't' };
        yield { id: 'v83', lang: 'ja', title: 'Fate/stay night', latin: 'Fate/stay night', official: 't' };
      }
      if (provider === 'vndb' && table === 'vn') {
        yield { id: 'v81', olang: 'ja', alias: null };
        yield { id: 'v82', olang: 'ja', alias: null };
        yield { id: 'v83', olang: 'ja', alias: null };
      }
      if (provider === 'vndb' && table === 'entry_meta') {
        yield { id: 'v81', revision: '1', lastmod: '2026-11-01' };
        yield { id: 'v82', revision: '1', lastmod: '2026-11-01' };
        yield { id: 'v83', revision: '1', lastmod: '2026-11-01' };
      }
    },
  };
}

const currentVocabulary: SourceVocabularyBindings = {
  releaseDigest: bundledDigest,
  schemes: [
    {
      taxonomy: 'bangumi.episode.type',
      id: schemeId,
      uri: episodeTypeSchemeUri,
      type: 'skos:ConceptScheme',
      releaseDigest: bundledDigest,
    },
  ],
  concepts: [
    {
      taxonomy: 'bangumi.episode.type',
      code: '0',
      id: mainKindId,
      type: 'skos:Concept',
      schemeId,
      releaseDigest: bundledDigest,
    },
  ],
};

function port(commands: BatchCommand[]): CrossMediaPort {
  const metadata = sourceRecordMetadataFixture();
  const ids = new Map<string, string>();
  const types = new Map<string, string>();
  const sourceKeys = new Map<string, string>();
  const catalog = new Map<string, unknown>([
    [
      schemeId,
      {
        subject: {
          id: schemeId,
          type: 'skos:ConceptScheme',
          statements: { 'schema:url': [{ value: { type: 'value', content: episodeTypeSchemeUri } }] },
        },
      },
    ],
    [
      mainKindId,
      {
        subject: {
          id: mainKindId,
          type: 'skos:Concept',
          statements: {
            'schema:url': [{ value: { type: 'value', content: episodeTypeConceptUri('0') } }],
            'skos:inScheme': [{ value: { type: 'value', content: schemeId } }],
          },
        },
      },
    ],
    [withheldKindId, { subject: { id: withheldKindId, type: 'skos:Concept', statements: {} } }],
  ]);
  return {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const owner = `${command.source.source}\u0000${command.source.external_id}`;
            const id = ids.get(owner) ?? randomUUID();
            ids.set(owner, id);
            types.set(id, command.subject.type);
            sourceKeys.set(id, command.source.external_id);
            return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
          }
          if (command.op === 'propose')
            return { key: command.key, status: 201 as const, value: { candidate: randomUUID(), revision: 1 } };
          return { key: command.key, status: 200 as const, value: { revision: 1 } };
        }),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {
      throw new Error('No statistic in this episode fixture');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      const existing = catalog.get(id);
      if (existing) return existing as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
      const key = sourceKeys.get(id);
      const identity = key
        ? key.startsWith('episode:')
          ? { property: 'schema:url', value: bangumiRecordUrl(key) }
          : { property: 'wdt:P5732', value: key }
        : undefined;
      return {
        subject: {
          id,
          type: types.get(id) ?? 'schema:Thing',
          statements: identity
            ? {
                [identity.property]: [
                  { property: { id: identity.property }, value: { type: 'value', content: identity.value } },
                ],
              }
            : {},
        },
      } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
}

test('default seed keeps selected Episode identities, current kinds, exact parents and bounded overflow while composing adapters', async () => {
  expect(SHOWCASE_EPISODE_WINDOW).toBe(BATCH_LIMIT);
  let retainedHookCalls = 0;
  const retainedAdmission = {
    request() {
      retainedHookCalls++;
      return undefined;
    },
  };
  const composed = composeVocabularyAdmissions(retainedAdmission, {
    request: () => ({ bindings: currentVocabulary, rows: [] }),
  });
  expect(
    composed?.request?.({
      owner: { source: 'bangumi_cross_media', external_id: 'episode:900001' },
      conversion: { normalized: { type: 0 } } as never,
      subject: randomUUID(),
    })?.rows,
  ).toHaveLength(0);

  const plan = await planCrossMediaSeed(tables());
  const selected = plan.entities.bangumi.filter((record) => record.key.startsWith('episode:'));
  expect(selected).toHaveLength(BATCH_LIMIT);
  expect(selected.some((record) => record.key === 'episode:900003')).toBe(false);
  expect(plan.gaps.find((gap) => gap.externalId === 'episode:999999')?.reason).toContain('delivery window');
  const deliveryKeys = new Set(['81', 'episode:900001', 'episode:900002']);
  plan.records.bangumi = plan.records.bangumi.filter((record) => deliveryKeys.has(record.key));
  plan.records.vndb = [];
  plan.entities.bangumi = plan.entities.bangumi.filter((record) => deliveryKeys.has(record.key));
  plan.entities.vndb = [];
  plan.edges = plan.edges.filter((edge) => edge.holder.startsWith('episode:'));
  plan.credits = [];

  const commands: BatchCommand[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'showcase-bangumi-episodes-'));
  try {
    const result = await seedCrossMedia(plan, join(directory, 'state.sqlite'), port(commands), undefined, {
      episodeCatalogueSubjects: catalogueSubjects,
      vocabularyAdmission: retainedAdmission,
      providers: ['bangumi'],
    });
    expect(result.status).toBe('imported-with-gaps');
    expect(retainedHookCalls).toBeGreaterThan(0);
    expect(result.episodeDiagnostics).toContainEqual(
      expect.objectContaining({ sourceKey: 'episode:900002', reason: 'unbound_concept' }),
    );
    expect(result.gaps.some((gap) => 'externalId' in gap && gap.externalId === 'episode:999999')).toBe(true);

    const source = (command: BatchCommand) => command.source.external_id;
    const value = (command: Extract<BatchCommand, { op: 'propose' }>) =>
      command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    expect(
      commands.some(
        (command) =>
          command.op === 'propose' &&
          source(command) === 'episode:900001' &&
          command.statement.property.id === 'schema:keywords' &&
          value(command) === mainKindId,
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.op === 'propose' &&
          source(command) === 'episode:900002' &&
          command.statement.property.id === 'schema:keywords',
      ),
    ).toBe(false);
    expect(
      commands.some(
        (command) =>
          command.op === 'propose' &&
          source(command) === 'episode:900001' &&
          command.statement.property.id === 'schema:episodeNumber' &&
          value(command) === '1.5',
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.op === 'propose' &&
          source(command) === 'episode:900002' &&
          command.statement.property.id === 'schema:episodeNumber' &&
          value(command) === '0',
      ),
    ).toBe(true);
    const parentId = result.readings.find((row) => row.externalId === '81')?.subject.subject?.id;
    const episodeId = result.readings.find((row) => row.externalId === 'episode:900001')?.subject.subject?.id;
    const parentEdge = commands.find(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' &&
        source(command) === 'episode:900001' &&
        command.statement.property.id === 'schema:isPartOf',
    );
    expect(parentId && episodeId && episodeId !== parentId).toBeTruthy();
    expect(parentEdge && value(parentEdge)).toBe(parentId);
    expect(parentEdge?.statement.qualifiers ?? []).not.toContainEqual(
      expect.objectContaining({ property: { id: 'schema:episodeNumber' } }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
