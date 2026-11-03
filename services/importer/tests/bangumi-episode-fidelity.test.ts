import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision } from '@rezics/conversion/cross-media-entities';
import type { CrossMediaPort } from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import {
  episodeTypeConceptUri,
  episodeTypeSchemeUri,
  importBangumiEpisodeFidelity,
  planBangumiEpisodeFidelity,
  readEpisodeTypeBindings,
} from '../src/bangumi-episode-fidelity.ts';

function authoredTables() {
  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [{ id: 81, type: 2, name: 'Authored series' }],
    'bangumi/episode': [
      {
        id: 900001,
        subject_id: 81,
        name: 'Authored fractional episode',
        sort: 1.5,
        type: 0,
        airdate: '2006-04-06',
        duration: '24m',
        description: 'Authored CC-BY-SA episode description.',
        disc: 3,
      },
      {
        id: 900002,
        subject_id: 81,
        name: 'Authored special',
        sort: 0,
        type: 1,
        duration: 'two reels',
        disc: 1,
      },
      {
        id: 900003,
        subject_id: 81,
        name: 'Authored unknown kind',
        sort: 2,
        type: 99,
      },
    ],
  };
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

const schemeId = '00000000-0000-4000-8000-000000000090';
const specialId = '00000000-0000-4000-8000-000000000091';
const subjects: Record<string, object> = {
  [schemeId]: {
    subject: {
      id: schemeId,
      type: 'skos:ConceptScheme',
      statements: { 'schema:url': [{ value: { content: episodeTypeSchemeUri } }] },
    },
  },
  [specialId]: {
    subject: {
      id: specialId,
      type: 'skos:Concept',
      statements: {
        'schema:url': [{ value: { content: episodeTypeConceptUri('1') } }],
        'skos:inScheme': [{ value: { content: schemeId } }],
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

test('operator plans authored episodes without using disc as identity and imports through the seed caller', async () => {
  const plan = await planBangumiEpisodeFidelity(authoredTables());
  expect(plan.records.bangumi.map((row) => row.key)).toEqual(['81']);
  expect(plan.entities.bangumi.map((row) => row.key)).toEqual(['episode:900001', 'episode:900002', 'episode:900003']);
  expect(plan.edges.every((edge) => edge.property === 'schema:isPartOf' && edge.target === '81')).toBe(true);
  const commands: BatchCommand[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-episode-fidelity-'));
  try {
    const bindings = await readEpisodeTypeBindings(port(commands), {
      schemeId,
      concepts: [{ code: '1', id: specialId }],
    });
    expect(bindings.concepts.map((item) => item.code)).toEqual(['1']);
    const first = await importBangumiEpisodeFidelity({
      tables: authoredTables(),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings,
    });
    expect(first.status).toBe('imported');
    expect(first.converterRevision).toBe(converter_revision);
    const proposed = commands.filter((command) => command.op === 'propose');
    expect(
      proposed.some((command) => command.statement.property.id === 'schema:episodeNumber' && command.statement.value.content === '1.5'),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.statement.property.id === 'schema:duration' &&
          JSON.stringify(command.statement.value.content) ===
            JSON.stringify({ amount: '+1440', unit: 'http://www.wikidata.org/entity/Q11574' }),
      ),
    ).toBe(true);
    expect(proposed.some((command) => command.source.field_group === 'summary' && command.rights?.license === 'CC-BY-SA-3.0')).toBe(
      true,
    );
    expect(proposed.some((command) => command.statement.property.id === 'schema:keywords' && command.statement.value.content === specialId)).toBe(
      true,
    );
    expect(proposed.some((command) => command.statement.property.id === 'schema:isPartOf')).toBe(true);
    const count = commands.length;
    const again = await importBangumiEpisodeFidelity({
      tables: authoredTables(),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings,
    });
    expect(again.runs.bangumi?.counts.unchanged).toBeGreaterThan(0);
    expect(commands.length).toBeGreaterThanOrEqual(count);
    subjects[specialId] = {
      subject: { id: specialId, type: 'skos:Concept', statements: {} },
    };
    const withheld = await readEpisodeTypeBindings(port([]), {
      schemeId,
      concepts: [{ code: '1', id: specialId }],
    });
    expect(withheld.concepts).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
