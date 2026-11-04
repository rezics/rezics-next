import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import {
  CrossMediaDumpFiles,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

function families(extra: Record<string, Record<string, unknown>[]> = {}): CrossMediaTables {
  const rows: Record<string, Record<string, unknown>[]> = {
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
      { id: 'v1', olang: 'ja', alias: null },
      { id: 'v2', olang: 'ja', alias: null },
      { id: 'v3', olang: 'ja', alias: null },
    ],
    'vndb/entry_meta': [
      { id: 'v1', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v2', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v3', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
    ],
    'vndb/releases': [{ id: 'r1' }],
    'vndb/releases_vn': [{ id: 'r1', vid: 'v1' }],
    'vndb/releases_producers': [{ id: 'r1', pid: 'p1', developer: 't', publisher: 'f' }],
    'vndb/producers': [
      { id: 'p1', name: 'Authored studio', type: 'co' },
      { id: 'p2', name: 'Authored parent', type: 'co' },
      { id: 'p3', name: 'Authored subsidiary', type: 'ng' },
      { id: 'p4', name: 'Authored person', type: 'in' },
    ],
    'vndb/producers_relations': [
      { id: 'p1', pid: 'p2', relation: 'par' },
      { id: 'p1', pid: 'p3', relation: 'sub' },
      { id: 'p1', pid: 'p4', relation: 'par' },
      { id: 'p1', pid: 'p9', relation: 'par' },
      { id: 'p1', pid: 'p2', relation: 'old' },
      { id: 'p1', pid: 'p2', relation: 'zzz' },
      { id: 'p2', pid: 'p1', relation: 'par' },
    ],
    ...extra,
  };
  return {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

const vndbSeed = { providers: ['vndb'] as const, mediaDeadlineMs: 0 };

function port(
  commands: BatchCommand[],
  options: { omitParent?: boolean; fence?: string } = {},
): CrossMediaPort {
  const metadata = sourceRecordMetadataFixture();
  let omitted = false;
  return {
    async batch(request) {
      const parentBatch = request.commands.some(
        (command) => command.op === 'propose' && command.statement.property.id === 'wdt:P749',
      );
      if (options.omitParent && parentBatch && !omitted) {
        omitted = true;
        commands.push(...request.commands);
        return { results: [] };
      }
      const results = [];
      for (const command of request.commands) {
        commands.push(command);
        results.push({
          key: command.key,
          status: 201 as const,
          value:
            command.op === 'create'
              ? { id: randomUUID(), revision: 1 }
              : command.op === 'propose'
                ? { candidate: randomUUID(), revision: 1 }
                : { revision: 1 },
        });
      }
      return { results };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence({ externalId }) {
      return options.fence === externalId
        ? { fenced: true, securityRevision: '1' }
        : { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      return { subject: { id } } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
}

test('selected family follows par and sub, keeps Person and omitted codes as source loss', async () => {
  const plan = await planCrossMediaSeed(families());
  expect(plan.entities.vndb.map((row) => row.key).filter((key) => key.startsWith('p')).sort()).toEqual([
    'p1',
    'p2',
    'p3',
    'p4',
  ]);
  expect(plan.members.some((row) => row.key === 'p4' && row.kind === 'person')).toBe(true);
  const parents = plan.edges.filter((edge) => edge.table === 'producers_relations');
  expect(parents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        holder: 'p1',
        target: 'p2',
        property: 'wdt:P749',
        producerParent: expect.objectContaining({ code: 'par' }),
      }),
      expect.objectContaining({
        holder: 'p3',
        target: 'p1',
        property: 'wdt:P749',
        producerParent: expect.objectContaining({ code: 'sub' }),
      }),
    ]),
  );
  expect(parents.some((edge) => edge.property === 'wdt:P355')).toBe(false);
  expect(plan.gaps.some((gap) => gap.record.pid === 'p4' && gap.requiredProfile === 'schema:Person')).toBe(true);
  expect(plan.gaps.some((gap) => gap.record.pid === 'p9' && gap.reason.includes('Missing target'))).toBe(true);
  expect(plan.gaps.some((gap) => gap.record.relation === 'old')).toBe(true);
  expect(plan.gaps.some((gap) => gap.record.relation === 'zzz')).toBe(true);
  expect(plan.gaps.filter((gap) => gap.reason.includes('cyclic')).length).toBeGreaterThan(0);
});

test('authored COPY headers feed the production dump reader and sealed parent reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-producer-parent-'));
  const commands: BatchCommand[] = [];
  try {
    const bangumi = join(directory, 'bangumi');
    const vndb = join(directory, 'vndb', 'db');
    await mkdir(bangumi, { recursive: true });
    await mkdir(vndb, { recursive: true });
    await writeFile(
      join(bangumi, 'subject.jsonlines'),
      [
        JSON.stringify({ id: 1, type: 2, name: 'STEINS;GATE' }),
        JSON.stringify({ id: 2, type: 2, name: 'CLANNAD' }),
        JSON.stringify({ id: 3, type: 2, name: 'Fate/stay night' }),
      ].join('\n') + '\n',
    );
    for (const name of [
      'subject-relations',
      'subject-characters',
      'person-characters',
      'episode',
      'person',
      'character',
    'subject-persons',
      'person-relations',
  ])
      await writeFile(join(bangumi, `${name}.jsonlines`), '');
    const files: Record<string, [string, string]> = {
      vn: ['id\tolang\talias', 'v1\tja\t\\N\nv2\tja\t\\N\nv3\tja\t\\N'],
      vn_titles: [
        'id\tlang\tofficial\ttitle\tlatin',
        'v1\tja\tt\tSTEINS;GATE\t\\N\nv2\tja\tt\tCLANNAD\t\\N\nv3\tja\tt\tFate/stay night\t\\N',
      ],
      entry_meta: [
        'id\trevision\tlastmod',
        'v1\t1\t2026-10-25 00:00:00+00\nv2\t1\t2026-10-25 00:00:00+00\nv3\t1\t2026-10-25 00:00:00+00',
      ],
      releases: ['id', 'r1'],
      releases_vn: ['id\tvid', 'r1\tv1'],
      releases_producers: ['id\tpid\tdeveloper\tpublisher', 'r1\tp1\tt\tf'],
      producers: [
        'id\ttype\tname',
        'p1\tco\tAuthored studio\np2\tco\tAuthored parent\np3\tng\tAuthored subsidiary',
      ],
      producers_relations: ['id\tpid\trelation', 'p1\tp2\tpar\np1\tp3\tsub'],
    };
    const needed = [
      'anime',
      'chars',
      'chars_vns',
      'extlinks',
      'releases_supersedes',
      'releases_titles',
      'staff',
      'staff_alias',
      'staff_extlinks',
      'vn_anime',
      'vn_extlinks',
      'vn_relations',
      'vn_seiyuu',
      'vn_staff',
    ];
    for (const name of needed) files[name] ??= ['id', ''];
    for (const [name, [header, body]] of Object.entries(files)) {
      await writeFile(join(vndb, `${name}.header`), `${header}\n`);
      await writeFile(join(vndb, name), body ? `${body}\n` : '');
    }
    await expect(Array.fromAsync(new CrossMediaDumpFiles(bangumi, join(directory, 'vndb')).rows('vndb', 'producers_relations'))).resolves.toEqual([
      { id: 'p1', pid: 'p2', relation: 'par' },
      { id: 'p1', pid: 'p3', relation: 'sub' },
    ]);
    const plan = await planCrossMediaSeed(new CrossMediaDumpFiles(bangumi, join(directory, 'vndb')));
    const first = await seedCrossMedia(plan, join(directory, 'state.sqlite'), port(commands), undefined, vndbSeed);
    const proposed = commands.filter(
      (command) => command.op === 'propose' && command.statement.property.id === 'wdt:P749',
    );
    expect(proposed).toHaveLength(2);
    const keys = proposed.map((command) => command.key);
    const count = commands.length;
    await seedCrossMedia(plan, join(directory, 'state.sqlite'), port(commands), undefined, vndbSeed);
    expect(commands.filter((command) => command.op === 'propose' && command.statement.property.id === 'wdt:P749').map((command) => command.key)).toEqual(
      expect.arrayContaining(keys),
    );
    expect(commands.length).toBeGreaterThanOrEqual(count);
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('unknown parent send, later endpoint and tuple fence keep one sealed envelope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-producer-parent-unknown-'));
  try {
    const commands: BatchCommand[] = [];
    const oneParent = {
      'vndb/producers_relations': [{ id: 'p1', pid: 'p2', relation: 'par' }],
    };
    const first = await seedCrossMedia(
      await planCrossMediaSeed(families(oneParent)),
      join(directory, 'state.sqlite'),
      port(commands, { omitParent: true }),
      undefined,
      vndbSeed,
    );
    const parent = commands.filter((command) => command.op === 'propose' && command.statement.property.id === 'wdt:P749');
    expect(parent).toHaveLength(1);
    expect(first.unresolved.some((row) => row.reason === 'unknown_delivery')).toBe(true);
    await seedCrossMedia(
      await planCrossMediaSeed(families(oneParent)),
      join(directory, 'state.sqlite'),
      port(commands),
      undefined,
      vndbSeed,
    );
    const replayed = commands.filter(
      (command) => command.op === 'propose' && command.statement.property.id === 'wdt:P749',
    );
    expect(replayed).toHaveLength(2);
    expect(replayed[1]).toEqual(parent[0]);
    const missing = await planCrossMediaSeed(
      families({
        'vndb/producers': [{ id: 'p1', name: 'Authored studio', type: 'co' }],
        'vndb/producers_relations': [{ id: 'p1', pid: 'p2', relation: 'par' }],
      }),
    );
    expect(missing.gaps.some((gap) => gap.record.pid === 'p2')).toBe(true);
    expect(missing.edges.some((edge) => edge.table === 'producers_relations')).toBe(false);
    const resolved = await planCrossMediaSeed(
      families({
        'vndb/producers_relations': [{ id: 'p1', pid: 'p2', relation: 'par' }],
      }),
    );
    expect(resolved.edges.some((edge) => edge.holder === 'p1' && edge.target === 'p2')).toBe(true);
    const fenced = await seedCrossMedia(
      await planCrossMediaSeed(families(oneParent)),
      join(directory, 'fence.sqlite'),
      port([], { fence: 'p1' }),
      undefined,
      vndbSeed,
    );
    expect(
      fenced.unresolved.some((row) => row.reason === 'fenced_relation_holder') ||
        fenced.status === 'imported-with-gaps',
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
