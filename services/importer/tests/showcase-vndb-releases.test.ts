import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { bundledDigest } from '@rezics/definitions/bundled';
import { converter_revision } from '@rezics/conversion/cross-media-entities';
import { planCrossMediaSeed, type CrossMediaPort, type CrossMediaTables } from '../src/cross-media-seed.ts';
import {
  developmentStatusConceptUri,
  developmentStatusSchemeUri,
  developmentStatusTaxonomy,
} from '../src/vndb-release-fidelity.ts';
import { seedShowcaseVndbReleases } from '../src/showcase-vndb-releases.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

/** Compact COPY-shaped selected family. These rows are not observed public dump evidence. */
function family(): CrossMediaTables {
  const rows: Record<string, Row[]> = {
    'bangumi/subject': [
      { id: 1, type: 2, name: 'STEINS;GATE' },
      { id: 2, type: 2, name: 'CLANNAD' },
      { id: 3, type: 2, name: 'Fate/stay night' },
    ],
    'vndb/vn_titles': [
      { id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
      { id: 'v2', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
      { id: 'v3', lang: 'ja', official: 't', title: 'Fate/stay night', latin: null },
    ],
    'vndb/vn': [
      { id: 'v1', olang: 'ja', alias: null, devstatus: 1 },
      { id: 'v2', olang: 'ja', alias: null },
      { id: 'v3', olang: 'ja', alias: null },
    ],
    'vndb/entry_meta': [
      { id: 'v1', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v2', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v3', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
    ],
    'vndb/releases': [
      { id: 'r1', released: '20200229' },
      { id: 'r2', released: '99999999' },
      { id: 'r3', released: '20210101' },
    ],
    'vndb/releases_titles': [
      { id: 'r1', lang: 'ja', mtl: 't', title: 'Selected day release', latin: null },
      { id: 'r2', lang: 'ja', mtl: 't', title: 'Selected TBA release', latin: null },
      { id: 'r3', lang: 'ja', mtl: 't', title: 'Unselected owner', latin: null },
    ],
    'vndb/releases_vn': [
      { id: 'r1', vid: 'v1', rtype: 'complete' },
      { id: 'r2', vid: 'v1', rtype: 'bundle' },
      { id: 'r3', vid: 'v99', rtype: 'complete' },
    ],
  };
  return {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

type Row = Record<string, unknown>;
const schemeId = '00000000-0000-4000-8000-000000000021';
const statusId = '00000000-0000-4000-8000-000000000022';
const hiddenStatus = '00000000-0000-4000-8000-000000000025';

function subjects(statusBound: boolean): Record<string, object> {
  return {
    [schemeId]: {
      subject: {
        id: schemeId,
        type: 'skos:ConceptScheme',
        statements: { 'schema:url': [{ value: { content: developmentStatusSchemeUri } }] },
      },
    },
    [statusBound ? statusId : hiddenStatus]: {
      subject: {
        id: statusBound ? statusId : hiddenStatus,
        type: statusBound ? 'skos:Concept' : 'wd:Q20631656',
        statements: statusBound
          ? {
              'schema:url': [{ value: { content: developmentStatusConceptUri('1') } }],
              'skos:inScheme': [{ value: { content: schemeId } }],
            }
          : {},
      },
    },
  };
}

function port(commands: BatchCommand[], statusBound: boolean): CrossMediaPort {
  const metadata = sourceRecordMetadataFixture();
  const known = subjects(statusBound);
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
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      const row = known[id];
      if (!row) return { subject: { id } } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
      return row as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
}

const groups = (statusIdValue: string) => [
  {
    taxonomy: developmentStatusTaxonomy,
    uri: developmentStatusSchemeUri,
    schemeId,
    concepts: [{ code: '1', id: statusIdValue }],
  },
];

test('selected-family seed publishes actual release dates and states and keeps completeness as a gap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-vndb-releases-'));
  try {
    const tables = family();
    const plan = await planCrossMediaSeed(tables);
    expect(plan.entities.vndb.some((row) => row.key === 'r1')).toBe(true);
    expect(plan.entities.vndb.some((row) => row.key === 'r2')).toBe(true);
    expect(plan.entities.vndb.some((row) => row.key === 'r3')).toBe(false);
    expect(plan.edges.filter((edge) => edge.table === 'releases_vn' && edge.holder === 'r1')).toHaveLength(1);
    const firstCommands: BatchCommand[] = [];
    const first = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: join(directory, 'state.sqlite'),
      port: port(firstCommands, false),
      groups: groups(hiddenStatus),
      extras: { providers: ['vndb'], mediaDeadlineMs: 0, recordConcurrency: 1 },
    });
    expect(first.converterRevision).toBe(converter_revision);
    expect(first.facts.releases.get('r1')?.links).toEqual([{ vid: 'v1', completeness: 'complete' }]);
    expect(first.facts.releases.get('r2')?.links).toEqual([{ vid: 'v1', completeness: 'bundle' }]);
    expect(first.facts.releases.has('r3')).toBe(false);
    expect(
      plan.edges.filter((edge) => edge.table === 'releases_vn' && edge.property === 'schema:exampleOfWork'),
    ).toHaveLength(2);
    expect(first.gaps.some((row) => row.reason.includes('finite reviewed inventory'))).toBe(true);
    const proposed = firstCommands.filter((command) => command.op === 'propose');
    const content = (command: (typeof proposed)[number]) =>
      command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'r1' &&
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(content(command)).includes('+2020-02-29T00:00:00Z'),
      ),
    ).toBe(true);
    expect(
      proposed.filter(
        (command) => command.source.external_id === 'r1' && command.statement.property.id === 'schema:exampleOfWork',
      ),
    ).toHaveLength(1);
    expect(
      proposed.some(
        (command) => command.source.external_id === 'v1' && command.statement.property.id === 'schema:keywords',
      ),
    ).toBe(false);
    expect(
      proposed.some(
        (command) => command.source.external_id === 'r2' && command.statement.property.id === 'schema:keywords',
      ),
    ).toBe(false);
    expect(
      first.vocabularyGaps.some(
        (gap) =>
          gap.path === '/releases_vn/r1/v1' &&
          gap.code === 'complete' &&
          gap.reason === 'qualifier_not_admitted' &&
          gap.property === 'wdt:P31',
      ),
    ).toBe(true);
    expect(first.vocabularyGaps.some((gap) => gap.path === '/releases_vn/r2/v1' && gap.reason === 'unknown_code')).toBe(
      true,
    );
    expect(JSON.stringify(proposed)).not.toContain('wdt:P155');
    const refreshed: BatchCommand[] = [];
    const again = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: join(directory, 'state.sqlite'),
      port: port(refreshed, true),
      groups: groups(statusId),
      extras: { providers: ['vndb'], mediaDeadlineMs: 0, recordConcurrency: 1 },
    });
    expect(again.bindings.releaseDigest).toBe(bundledDigest);
    expect(
      refreshed.some(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === 'v1' &&
          command.statement.property.id === 'schema:keywords' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === statusId,
      ),
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
