import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision } from '@rezics/conversion/cross-media-entities';
import { developmentShowcaseSelection } from '../../../scripts/datasets/cross-media-seed.ts';
import { ImportTransportError } from '../src/import-client.ts';
import {
  CrossMediaDumpFiles,
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import {
  decodeVndbReleased,
  developmentStatusConceptUri,
  developmentStatusSchemeUri,
  developmentStatusTaxonomy,
  importVndbReleaseFidelity,
  planVndbReleaseFidelity,
  readVndbReleaseBindings,
} from '../src/vndb-release-fidelity.ts';

/** Authored COPY tables. These are not observed public dump evidence. */
async function authoredCopy(directory: string, released = '20200229') {
  const db = join(directory, 'db');
  await mkdir(db, { recursive: true });
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang\tdevstatus\talias', 'v1\tja\t1\t\\N'],
    vn_titles: ['id\tlang\tofficial\ttitle\tlatin', 'v1\tja\tt\tAuthored work\t\\N'],
    entry_meta: ['id\trevision\tlastmod', 'v1\t1\t2026-10-25 00:00:00+00'],
    releases: [
      'id\treleased',
      [
        `r1\t${released}`,
        'r2\t20200300',
        'r3\t20200000',
        'r4\t99999999',
        'r5\t00000000',
        'r6\t\\N',
        'r7\t20210101',
      ].join('\n'),
    ],
    releases_titles: [
      'id\tlang\tmtl\ttitle\tlatin',
      [
        'r1\tja\tt\tAuthored exact release\t\\N',
        'r2\tja\tt\tAuthored month release\t\\N',
        'r3\tja\tt\tAuthored year release\t\\N',
        'r4\tja\tt\tAuthored TBA release\t\\N',
        'r5\tja\tt\tAuthored unknown release\t\\N',
        'r6\tja\tt\tAuthored absent release\t\\N',
        'r7\tja\tt\tAuthored unsupported completeness\t\\N',
      ].join('\n'),
    ],
    releases_media: ['id\tmedium\tqty', ''],
    releases_platforms: ['id\tplatform', ''],
    releases_vn: [
      'id\tvid\trtype',
      [
        'r1\tv1\tcomplete',
        'r2\tv1\tpartial',
        'r3\tv1\tcomplete',
        'r4\tv1\tcomplete',
        'r5\tv1\tcomplete',
        'r6\tv1\tcomplete',
        'r7\tv1\tbundle',
      ].join('\n'),
    ],
    releases_supersedes: ['id\trid', 'r1\tr2'],
  };
  for (const [name, [header, body]] of Object.entries(files)) {
    await writeFile(join(db, `${name}.header`), `${header}\n`);
    await writeFile(join(db, name), `${body}\n`);
  }
  return new CrossMediaDumpFiles(join(directory, 'bangumi'), directory);
}

const schemeId = '00000000-0000-4000-8000-000000000098';
const statusId = '00000000-0000-4000-8000-000000000099';
const subjects: Record<string, object> = {
  [schemeId]: {
    subject: {
      id: schemeId,
      type: 'skos:ConceptScheme',
      statements: { 'schema:url': [{ value: { content: developmentStatusSchemeUri } }] },
    },
  },
  [statusId]: {
    subject: {
      id: statusId,
      type: 'skos:Concept',
      statements: {
        'schema:url': [{ value: { content: developmentStatusConceptUri('1') } }],
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

test('operator plans authored VNDB COPY releases without mixing work and release grains and imports through the seed caller', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-fidelity-'));
  try {
    const tables = await authoredCopy(directory);
    const plan = await planVndbReleaseFidelity(tables);
    expect(plan.records.vndb.map((row) => row.key)).toEqual(['v1']);
    expect(plan.entities.vndb.map((row) => row.key)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
    expect(plan.members.some((row) => row.key === 'v1' && row.kind === 'work')).toBe(true);
    expect(plan.members.filter((row) => row.kind === 'release')).toHaveLength(7);
    expect(plan.gaps.some((gap) => gap.reason.includes('supersession'))).toBe(false);
    expect(plan.edges.filter((edge) => edge.table === 'releases_vn')).toHaveLength(7);
    expect(
      plan.edges
        .filter((edge) => edge.table === 'releases_vn')
        .every((edge) => edge.property === 'schema:exampleOfWork'),
    ).toBe(true);
    expect(plan.edges.filter((edge) => edge.table === 'releases_supersedes')).toMatchObject([
      {
        holder: 'r1',
        target: 'r2',
        property: 'rezics:releaseSupersedes',
        record: { id: 'r1', rid: 'r2' },
        fields: ['releases_supersedes.id', 'releases_supersedes.rid'],
      },
    ]);
    expect(decodeVndbReleased('20200229')).toBe('2020-02-29');
    expect(decodeVndbReleased('20200300')).toBe('2020-03');
    expect(decodeVndbReleased('20200000')).toBe('2020');
    expect(decodeVndbReleased('99999999')).toBe('TBA');
    expect(decodeVndbReleased('00000000')).toBe('unknown');
    expect(decodeVndbReleased(null)).toBeNull();
    expect(plan.facts.releases.get('r1')?.links).toEqual([{ vid: 'v1', completeness: 'complete' }]);
    expect(plan.facts.releases.get('r2')?.links).toEqual([{ vid: 'v1', completeness: 'partial' }]);
    const commands: BatchCommand[] = [];
    const bindings = await readVndbReleaseBindings(port(commands), [
      {
        taxonomy: developmentStatusTaxonomy,
        uri: developmentStatusSchemeUri,
        schemeId,
        concepts: [{ code: '1', id: statusId }],
      },
    ]);
    expect(bindings.concepts.map((item) => item.code)).toEqual(['1']);
    const first = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings,
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    expect(first.converterRevision).toBe(converter_revision);
    const proposed = commands.filter((command) => command.op === 'propose');
    const content = (command: (typeof proposed)[number]) =>
      command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    expect(
      proposed.some(
        (command) =>
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(content(command)).includes('+2020-02-29T00:00:00Z'),
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(content(command)).includes('"precision":10'),
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(content(command)).includes('"precision":9'),
      ),
    ).toBe(true);
    expect(
      proposed.some((command) => command.statement.property.id === 'schema:keywords' && content(command) === statusId),
    ).toBe(true);
    expect(proposed.some((command) => command.statement.property.id === 'schema:exampleOfWork')).toBe(true);
    expect(JSON.stringify(proposed)).not.toContain('wdt:P155');
    const count = commands.length;
    const again = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings,
    });
    expect(again.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    expect(commands.length).toBeGreaterThanOrEqual(count);
    const changed: BatchCommand[] = [];
    const successor = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory, '20200301'),
      path: join(directory, 'state.sqlite'),
      port: port(changed),
      bindings,
    });
    expect(successor.runs.vndb?.counts.changed).toBeGreaterThan(0);
    expect(
      changed.some(
        (command) =>
          command.op === 'propose' &&
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(
            command.statement.value.type === 'value' ? command.statement.value.content : undefined,
          ).includes('+2020-03-01T00:00:00Z'),
      ),
    ).toBe(true);
    subjects[statusId] = { subject: { id: statusId, type: 'skos:Concept', statements: {} } };
    const withheld = await readVndbReleaseBindings(port([]), [
      {
        taxonomy: developmentStatusTaxonomy,
        uri: developmentStatusSchemeUri,
        schemeId,
        concepts: [{ code: '1', id: statusId }],
      },
    ]);
    expect(withheld.concepts).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test('default selected-family traversal acquires directed release endpoints and retries the exact current proposal', async () => {
  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [
      { id: 10380, type: 2, name: 'STEINS;GATE' },
      { id: 84148, type: 1, name: 'STEINS;GATE Official Book' },
      { id: 51, type: 2, name: 'CLANNAD' },
    ],
    'vndb/vn': [
      { id: 'v2002', olang: 'ja', devstatus: '1', alias: null },
      { id: 'v4', olang: 'ja', devstatus: '2', alias: null },
      { id: 'v3000', olang: 'ja', devstatus: '3', alias: null },
    ],
    'vndb/entry_meta': [
      { id: 'v2002', revision: '1', lastmod: '2026-11-01 00:00:00+00' },
      { id: 'v4', revision: '1', lastmod: '2026-11-01 00:00:00+00' },
      { id: 'v3000', revision: '2', lastmod: '2026-11-02 00:00:00+00' },
    ],
    'vndb/vn_titles': [
      { id: 'v2002', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
      { id: 'v4', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
      { id: 'v3000', lang: 'ja', official: 't', title: 'Unselected membership work', latin: null },
    ],
    'vndb/releases_vn': [
      { id: 'r1', vid: 'v2002', rtype: 'complete' },
      { id: 'r2', vid: 'v3000', rtype: 'partial' },
      { id: 'r3', vid: 'v3000', rtype: 'complete' },
    ],
    'vndb/releases': [
      { id: 'r1', released: '20200229' },
      { id: 'r2', released: '20200301' },
      { id: 'r3', released: '20210101' },
    ],
    'vndb/releases_titles': [
      { id: 'r1', lang: 'ja', mtl: false, title: 'Selected release', latin: null },
      { id: 'r2', lang: 'ja', mtl: false, title: 'Superseded release', latin: null },
      { id: 'r3', lang: 'ja', mtl: false, title: 'Cycle release', latin: null },
    ],
    'vndb/releases_supersedes': [
      { id: 'r1', rid: 'r2' },
      { id: 'r1', rid: 'r1' },
      { id: 'r1', rid: 'not-a-release' },
      { id: 'r2', rid: 'r3' },
      { id: 'r3', rid: 'r2' },
      { id: 'r90', rid: 'r91' },
      { id: 'r90', rid: 'r90' },
    ],
  };
  const tables: CrossMediaTables = {
    async *rows(provider, table, limits) {
      for (const row of rows[`${provider}/${table}`] ?? []) {
        limits?.consumeRow?.(Buffer.byteLength(JSON.stringify(row), 'utf8') + 1);
        yield row;
      }
    },
  };
  const plan = await planCrossMediaSeed(tables, { selection: developmentShowcaseSelection });
  const releases = plan.edges.filter((edge) => edge.table === 'releases_supersedes');
  expect(releases).toMatchObject([
    {
      holder: 'r1',
      target: 'r2',
      property: 'rezics:releaseSupersedes',
      record: { id: 'r1', rid: 'r2' },
      fields: ['releases_supersedes.id', 'releases_supersedes.rid'],
    },
  ]);
  expect(plan.entities.vndb.map((record) => record.key)).toContain('r3');
  expect(plan.entities.vndb.map((record) => record.key)).not.toContain('r90');
  expect(plan.records.vndb.map((record) => record.key)).toContain('v3000');
  expect(plan.gaps.some((gap) => gap.reason.includes('self-referential'))).toBe(true);
  expect(plan.gaps.some((gap) => gap.reason.includes('cycle'))).toBe(true);

  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-default-seed-'));
  const statePath = join(directory, 'state.sqlite');
  const native = new Map<
    string,
    { id: string; type: string; statements: Record<string, { value: { type: string; content: unknown } }[]> }
  >();
  const created = new Map<string, string>();
  const successful = new Map<
    string,
    { id: string; revision: number } | { candidate: string; revision: number } | { revision: number }
  >();
  const attemptedRelations: BatchCommand[] = [];
  const relationFenceSnapshots: { source: string; externalId: string; fieldGroup: string }[][] = [];
  const currentReadCounts: Map<string, number>[] = [];
  const releaseReads = (counts: Map<string, number>) =>
    new Map([...counts].filter(([externalId]) => /^r[1-9][0-9]*$/u.test(externalId)));
  try {
    const makePort = (options: { unknownRelation?: boolean; refusedRelease?: string } = {}): CrossMediaPort => {
      const metadata = sourceRecordMetadataFixture();
      const readCounts = new Map<string, number>();
      const fenceCalls: { source: string; externalId: string; fieldGroup: string }[] = [];
      currentReadCounts.push(readCounts);
      return {
        async batch(request) {
          return {
            results: request.commands.map((command) => {
              if (command.op === 'create') {
                const existing = created.get(command.key);
                const id = existing ?? randomUUID();
                created.set(command.key, id);
                native.set(id, native.get(id) ?? { id, type: command.subject.type, statements: {} });
                return {
                  key: command.key,
                  status: existing ? (200 as const) : (201 as const),
                  value: { id, revision: 1 },
                };
              }
              if (command.op === 'propose' && command.statement.property.id === 'rezics:releaseSupersedes') {
                attemptedRelations.push(command);
                relationFenceSnapshots.push([...fenceCalls]);
                if (options.unknownRelation)
                  return {
                    key: command.key,
                    status: 503 as const,
                    problem: { type: 'about:blank', title: 'Unavailable', status: 503 },
                  };
              }
              const prior = successful.get(command.key);
              if (prior) return { key: command.key, status: 200 as const, value: prior };
              if (command.op === 'propose') {
                const subject = native.get(command.subject);
                if (
                  subject &&
                  command.statement.property.id === 'wdt:P3180' &&
                  command.statement.value.type === 'value'
                ) {
                  subject.statements['wdt:P3180'] ??= [];
                  subject.statements['wdt:P3180'].push({ value: command.statement.value });
                }
                const value = { candidate: randomUUID(), revision: 1 };
                successful.set(command.key, value);
                return { key: command.key, status: 201 as const, value };
              }
              const value = { revision: 1 };
              successful.set(command.key, value);
              return { key: command.key, status: 201 as const, value };
            }),
          };
        },
        setSourceRecordMetadata: metadata.setSourceRecordMetadata,
        async fence(input) {
          fenceCalls.push(input);
          return { fenced: false, securityRevision: null };
        },
        async writeSourceStatistic() {
          throw new Error('No statistic in the selected release fixture');
        },
        async clearSourceStatistic() {},
        async readReviewedSubject(id) {
          const subject = native.get(id);
          if (subject) {
            const sourceIds = subject.statements['wdt:P3180']?.map((statement) => statement.value.content) ?? [];
            for (const sourceId of sourceIds) {
              if (typeof sourceId === 'string') readCounts.set(sourceId, (readCounts.get(sourceId) ?? 0) + 1);
            }
            const sourceId = sourceIds.find((value) => value === options.refusedRelease);
            if (sourceId) throw new ImportTransportError(403);
            return { subject } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
          }
          const known = subjects[id];
          if (!known) return { subject: { id } } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
          return known as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
        },
      };
    };

    const unknown = await seedCrossMedia(plan, statePath, makePort({ unknownRelation: true }));
    const unknownEvidence = unknown.releaseSupersessions?.[0]!;
    expect(unknownEvidence.status).toBe('unresolved');
    expect(unknownEvidence.command?.op).toBe('propose');
    const exactCommand = unknownEvidence.command;
    expect(exactCommand).toMatchObject({
      source: { source: crossMediaAliases.vndb, external_id: 'r1', record_revision: 'unversioned' },
      statement: {
        property: { id: 'rezics:releaseSupersedes' },
        references: [
          { parts: [{ value: { content: 'https://vndb.org/r1' } }] },
          { parts: [{ value: { content: 'https://vndb.org/r2' } }] },
        ],
      },
    });
    expect(attemptedRelations).toHaveLength(1);
    expect(attemptedRelations[0]).toEqual(exactCommand);
    expect(releaseReads(currentReadCounts[0]!)).toEqual(new Map([['r1', 1], ['r2', 1], ['r3', 1]]));
    expect(relationFenceSnapshots[0]?.at(-1)).toMatchObject({
      source: crossMediaAliases.vndb,
      externalId: 'r1',
      fieldGroup: 'facts',
    });

    const refused = await seedCrossMedia(plan, statePath, makePort({ refusedRelease: 'r2' }));
    expect(refused.releaseSupersessions?.[0]).toMatchObject({ status: 'unresolved', command: exactCommand });
    expect(refused.unresolved).toContainEqual(
      expect.objectContaining({ property: 'rezics:releaseSupersedes', reason: 'current_release_refused:r2' }),
    );
    expect(attemptedRelations).toHaveLength(1);
    expect(releaseReads(currentReadCounts[1]!)).toEqual(new Map([['r1', 1], ['r2', 1], ['r3', 1]]));

    const delivered = await seedCrossMedia(plan, statePath, makePort());
    expect(delivered.releaseSupersessions?.[0]).toMatchObject({ status: 'proposed', command: exactCommand });
    expect(delivered.releaseSupersessions?.[0]?.candidate).toMatch(/^[0-9a-f-]{36}$/u);
    expect(attemptedRelations).toHaveLength(2);
    expect(releaseReads(currentReadCounts[2]!)).toEqual(new Map([['r1', 1], ['r2', 1], ['r3', 1]]));
    expect(relationFenceSnapshots[1]?.at(-1)).toMatchObject({
      source: crossMediaAliases.vndb,
      externalId: 'r1',
      fieldGroup: 'facts',
    });

    const replay = await seedCrossMedia(plan, statePath, makePort());
    expect(replay.releaseSupersessions?.[0]).toMatchObject({
      status: 'proposed',
      command: exactCommand,
      candidate: delivered.releaseSupersessions?.[0]?.candidate,
    });
    expect(attemptedRelations[1]).toEqual(exactCommand);
    expect(attemptedRelations).toHaveLength(2);
    expect(releaseReads(currentReadCounts[3]!)).toEqual(new Map([['r1', 1], ['r2', 1], ['r3', 1]]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
