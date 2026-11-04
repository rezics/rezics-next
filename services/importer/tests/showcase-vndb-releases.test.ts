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

type Row = Record<string, unknown>;

/** Compact COPY-shaped selected family. These rows are not observed public dump evidence. */
function family(overrides: { released?: Row[]; vn?: Row[]; links?: Row[]; supersedes?: Row[] } = {}): CrossMediaTables {
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
    'vndb/vn': overrides.vn ?? [
      { id: 'v1', olang: 'ja', alias: null, devstatus: 1 },
      { id: 'v2', olang: 'ja', alias: null },
      { id: 'v3', olang: 'ja', alias: null },
    ],
    'vndb/entry_meta': [
      { id: 'v1', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v2', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v3', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
    ],
    'vndb/releases': overrides.released ?? [
      { id: 'r1', released: '20200229' },
      { id: 'r2', released: '99999999' },
      { id: 'r4', released: '20200300' },
      { id: 'r3', released: '20210101' },
    ],
    'vndb/releases_titles': [
      { id: 'r1', lang: 'ja', mtl: 't', title: 'Selected day release', latin: null },
      { id: 'r2', lang: 'ja', mtl: 't', title: 'Selected TBA release', latin: null },
      { id: 'r4', lang: 'ja', mtl: 't', title: 'Selected month release', latin: null },
      { id: 'r5', lang: 'ja', mtl: 't', title: 'Selected unknown release', latin: null },
      { id: 'r3', lang: 'ja', mtl: 't', title: 'Unselected owner', latin: null },
    ],
    'vndb/releases_vn': overrides.links ?? [
      { id: 'r1', vid: 'v1', rtype: 'complete' },
      { id: 'r2', vid: 'v1', rtype: 'bundle' },
      { id: 'r4', vid: 'v2', rtype: 'complete' },
      { id: 'r3', vid: 'v99', rtype: 'complete' },
    ],
    'vndb/releases_supersedes': overrides.supersedes ?? [{ id: 'r1', rid: 'r2' }],
  };
  return {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

const schemeId = '00000000-0000-4000-8000-000000000021';
const statusId = '00000000-0000-4000-8000-000000000022';
const hiddenStatus = '00000000-0000-4000-8000-000000000025';
const catalogue = {
  'vndb-development-status-scheme': schemeId,
  'vndb-development-status-1': statusId,
};

function subjects(statusBound: boolean): Record<string, object> {
  const conceptId = statusBound ? statusId : hiddenStatus;
  return {
    [schemeId]: {
      subject: {
        id: schemeId,
        type: 'skos:ConceptScheme',
        statements: { 'schema:url': [{ value: { content: developmentStatusSchemeUri } }] },
      },
    },
    [conceptId]: {
      subject: {
        id: conceptId,
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

function port(commands: BatchCommand[], statusBound: boolean, created = new Map<string, string>()): CrossMediaPort {
  const metadata = sourceRecordMetadataFixture();
  const known = subjects(statusBound);
  return {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const id = created.get(command.key) ?? randomUUID();
            created.set(command.key, id);
            return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
          }
          return {
            key: command.key,
            status: 201 as const,
            value: command.op === 'propose' ? { candidate: randomUUID(), revision: 1 } : { revision: 1 },
          };
        }),
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

function extras() {
  return {
    providers: ['vndb'] as const,
    mediaDeadlineMs: 0,
    recordConcurrency: 1,
    episodeCatalogueSubjects: catalogue,
  };
}

function dateContent(command: BatchCommand) {
  return command.op === 'propose' && command.statement.value.type === 'value'
    ? command.statement.value.content
    : undefined;
}

test('default seed without binding files rereads catalogue state and exposes selected dates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-vndb-releases-'));
  const created = new Map<string, string>();
  try {
    const tables = family();
    const plan = await planCrossMediaSeed(tables);
    expect(plan.entities.vndb.some((row) => row.key === 'r1')).toBe(true);
    expect(plan.entities.vndb.some((row) => row.key === 'r2')).toBe(true);
    expect(plan.entities.vndb.some((row) => row.key === 'r4')).toBe(true);
    expect(plan.entities.vndb.some((row) => row.key === 'r3')).toBe(false);
    const firstCommands: BatchCommand[] = [];
    const first = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: join(directory, 'state.sqlite'),
      port: port(firstCommands, true, created),
      extras: extras(),
    });
    expect(first.converterRevision).toBe(converter_revision);
    expect(first.bindings.releaseDigest).toBe(bundledDigest);
    expect(first.bindings.concepts.some((row) => row.id === statusId && row.code === '1')).toBe(true);
    expect(first.facts.releases.get('r1')?.links).toEqual([{ vid: 'v1', completeness: 'complete' }]);
    expect(first.facts.releases.get('r2')?.links).toEqual([{ vid: 'v1', completeness: 'bundle' }]);
    expect(first.facts.releases.has('r3')).toBe(false);
    expect(first.identities.some((row) => row.key === 'v1' && row.kind === 'work' && row.subjectId)).toBe(true);
    expect(first.identities.some((row) => row.key === 'r1' && row.kind === 'release')).toBe(true);
    const proposed = firstCommands.filter((command) => command.op === 'propose');
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'r1' &&
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(dateContent(command)).includes('+2020-02-29T00:00:00Z'),
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'r4' &&
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(dateContent(command)).includes('+2020-03-00T00:00:00Z'),
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'v1' &&
          command.statement.property.id === 'schema:keywords' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === statusId,
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) => command.source.external_id === 'r2' && command.statement.property.id === 'schema:datePublished',
      ),
    ).toBe(false);
    expect(
      proposed.some(
        (command) => command.source.external_id === 'r2' && command.statement.property.id === 'schema:keywords',
      ),
    ).toBe(false);
    expect(first.gaps.some((row) => row.reason.includes('finite reviewed inventory'))).toBe(true);
    expect(
      first.vocabularyGaps.some(
        (gap) =>
          gap.path === '/releases_vn/r1/v1' &&
          gap.code === 'complete' &&
          gap.reason === 'qualifier_not_admitted' &&
          gap.property === 'wdt:P31',
      ),
    ).toBe(true);
    expect(JSON.stringify(proposed)).not.toContain('wdt:P155');
    expect(JSON.stringify(proposed)).not.toContain('wdt:P1365');
    const workId = first.identities.find((row) => row.key === 'v1')?.subjectId;
    const releaseId = first.identities.find((row) => row.key === 'r1')?.subjectId;
    const againCommands: BatchCommand[] = [];
    const again = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: join(directory, 'state.sqlite'),
      port: port(againCommands, true, created),
      extras: extras(),
    });
    expect(again.identities.find((row) => row.key === 'v1')?.subjectId).toBe(workId);
    expect(again.identities.find((row) => row.key === 'r1')?.subjectId).toBe(releaseId);
    expect(again.bindings.concepts.some((row) => row.id === statusId)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('malformed and retracted source states withhold only affected claims', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-vndb-releases-edges-'));
  const created = new Map<string, string>();
  try {
    const tables = family({
      vn: [
        { id: 'v1', olang: 'ja', alias: null, devstatus: 1 },
        { id: 'v2', olang: 'ja', alias: null, devstatus: 9 },
        { id: 'v3', olang: 'ja', alias: null },
      ],
      released: [
        { id: 'r1', released: '20200229' },
        { id: 'r2', released: null },
        { id: 'r4', released: 'not-a-date' },
        { id: 'r5', released: '00000000' },
        { id: 'r3', released: '20210101' },
      ],
      links: [
        { id: 'r1', vid: 'v1', rtype: 'complete' },
        { id: 'r2', vid: 'v1', rtype: 'complete' },
        { id: 'r4', vid: 'v1', rtype: 'complete' },
        { id: 'r5', vid: 'v1', rtype: 'complete' },
        { id: 'r3', vid: 'v99', rtype: 'complete' },
      ],
      supersedes: [{ id: 'r1', rid: 'r5' }],
    });
    const plan = await planCrossMediaSeed(tables);
    const firstCommands: BatchCommand[] = [];
    const first = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: join(directory, 'state.sqlite'),
      port: port(firstCommands, true, created),
      extras: extras(),
      groups: [
        {
          taxonomy: developmentStatusTaxonomy,
          uri: developmentStatusSchemeUri,
          schemeId,
          concepts: [{ code: '1', id: statusId }],
        },
      ],
    });
    const proposed = firstCommands.filter((command) => command.op === 'propose');
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'r1' &&
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(dateContent(command)).includes('+2020-02-29T00:00:00Z'),
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'v1' &&
          command.statement.property.id === 'schema:keywords' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === statusId,
      ),
    ).toBe(true);
    for (const id of ['r2', 'r4', 'r5']) {
      expect(
        proposed.some(
          (command) => command.source.external_id === id && command.statement.property.id === 'schema:datePublished',
        ),
      ).toBe(false);
    }
    expect(first.vocabularyGaps.some((gap) => gap.path === '/releases/r2/released' && gap.code === 'absent')).toBe(
      true,
    );
    expect(first.gaps.some((row) => row.reason.includes('finite reviewed inventory'))).toBe(true);
    expect(plan.gaps.some((row) => row.reason.includes('supersession'))).toBe(true);
    expect(JSON.stringify(proposed)).not.toContain('wdt:P155');
    const workId = first.identities.find((row) => row.key === 'v1')?.subjectId;
    const releaseId = first.identities.find((row) => row.key === 'r1')?.subjectId;
    const retracted: BatchCommand[] = [];
    const lost = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: join(directory, 'state.sqlite'),
      port: port(retracted, false, created),
      extras: extras(),
      groups: [
        {
          taxonomy: developmentStatusTaxonomy,
          uri: developmentStatusSchemeUri,
          schemeId,
          concepts: [{ code: '1', id: hiddenStatus }],
        },
      ],
    });
    expect(lost.identities.find((row) => row.key === 'v1')?.subjectId).toBe(workId);
    expect(lost.identities.find((row) => row.key === 'r1')?.subjectId).toBe(releaseId);
    expect(lost.bindings.concepts.some((row) => row.code === '1')).toBe(false);
    expect(
      retracted.some(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === 'v1' &&
          command.statement.property.id === 'schema:keywords' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === hiddenStatus,
      ),
    ).toBe(false);
    expect(
      retracted.some(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === 'r1' &&
          command.statement.property.id === 'schema:datePublished',
      ),
    ).toBe(false);
    expect(JSON.stringify(retracted)).not.toContain('wdt:P155');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
