import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversionError } from '@rezics/conversion';
import { converter_revision, convertCrossMediaEntity, vndbStaffNameLimit } from '@rezics/conversion/cross-media-entities';
import type { BatchCommand } from '@rezics/definitions/bulk';
import {
  CrossMediaDumpFiles,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

function families(
  aliases: Record<string, unknown>[] = [
    { id: 's4', aid: '10', name: 'Preferred Alias', latin: null },
    { id: 's4', aid: '20', name: 'Later Alias', latin: null },
  ],
  extra: Record<string, Record<string, unknown>[]> = {},
): CrossMediaTables {
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
    'vndb/vn_staff': [{ id: 'v1', aid: '20', role: 'scenario', note: 'Writer Alias' }],
    'vndb/staff_alias': aliases,
    'vndb/staff': [{ id: 's4', gender: null, lang: 'ja', main: '10', description: '', prod: null }],
    ...extra,
  };
  return {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

const vndbSeed = { providers: ['vndb'] as const, mediaDeadlineMs: 0, entitiesFirst: true };

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
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      return { subject: { id } } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
}

function staffNames(commands: BatchCommand[]) {
  return commands.flatMap((command) =>
    command.op === 'propose' &&
    command.source.external_id === 's4' &&
    command.statement.property.id === 'schema:name' &&
    command.statement.value.type === 'value'
      ? [command.statement.value.content]
      : [],
  );
}

test('operator plans preferred-not-last aliases and imports every admitted source name', async () => {
  const plan = await planCrossMediaSeed(families());
  const staff = plan.entities.vndb.find((row) => row.key === 's4')!;
  expect(staff.payload).toMatchObject({
    main: '10',
    aliases: [
      { id: 's4', aid: '10', name: 'Preferred Alias' },
      { id: 's4', aid: '20', name: 'Later Alias' },
    ],
  });
  expect(staff.payload).not.toHaveProperty('name');
  const shuffled = await planCrossMediaSeed(
    families([
      { id: 's4', aid: '20', name: 'Later Alias', latin: null },
      { id: 's4', aid: '10', name: 'Preferred Alias', latin: null },
    ]),
  );
  expect(convertCrossMediaEntity({ external_id: 's4', record_revision: null, record: shuffled.entities.vndb.find((row) => row.key === 's4')!.payload }).digest).toBe(
    convertCrossMediaEntity({ external_id: 's4', record_revision: null, record: staff.payload }).digest,
  );
  const outsider = await planCrossMediaSeed(
    families(undefined, {
      'vndb/staff_alias': [
        { id: 's4', aid: '20', name: 'Later Alias', latin: null },
        { id: 's4', aid: '10', name: 'Preferred Alias', latin: null },
        { id: 's9', aid: '30', name: 'Preferred Alias', latin: null },
      ],
      'vndb/staff': [
        { id: 's4', gender: null, lang: 'ja', main: '10', description: '', prod: null },
        { id: 's9', gender: null, lang: 'ja', main: '30', description: '', prod: null },
      ],
    }),
  );
  expect(outsider.entities.vndb.map((row) => row.key)).toEqual(['s4']);
  expect((outsider.entities.vndb[0]!.payload as { aliases: { id: string }[] }).aliases.every((alias) => alias.id === 's4')).toBe(
    true,
  );
  const foreignPreferred = await planCrossMediaSeed(
    families(undefined, {
      'vndb/vn_staff': [
        { id: 'v1', aid: '20', role: 'scenario', note: 'Writer Alias' },
      ],
      'vndb/staff_alias': [
        { id: 's4', aid: '10', name: 'Preferred Alias', latin: null },
        { id: 's4', aid: '20', name: 'Later Alias', latin: null },
        { id: 's9', aid: '30', name: 'Other Person', latin: null },
      ],
      'vndb/staff': [
        { id: 's4', gender: null, lang: 'ja', main: '30', description: '', prod: null },
        { id: 's9', gender: null, lang: 'ja', main: '30', description: '', prod: null },
      ],
    }),
  );
  expect(foreignPreferred.gaps.some((gap) => gap.reason.includes('Preferred staff alias belongs to another owner'))).toBe(
    true,
  );
  expect(
    convertCrossMediaEntity({
      external_id: 's4',
      record_revision: null,
      record: foreignPreferred.entities.vndb.find((row) => row.key === 's4')!.payload,
    }).diagnostics,
  ).toEqual([{ pointer: '/main', code: 'missing_preferred_alias' }]);
  const commands: BatchCommand[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'vndb-staff-names-'));
  try {
    const first = await seedCrossMedia(plan, join(directory, 'state.sqlite'), port(commands), undefined, vndbSeed);
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    expect(
      commands.some(
        (command) => command.op === 'propose' && command.source.external_id === 's4' && command.source.converter_revision === converter_revision,
      ),
    ).toBe(true);
    expect(staffNames(commands)).toEqual(
      expect.arrayContaining([
        { language: 'und', text: 'Preferred Alias' },
        { language: 'und', text: 'Later Alias' },
      ]),
    );
    const keys = commands
      .filter(
        (command) =>
          command.op === 'propose' && command.source.external_id === 's4' && command.statement.property.id === 'schema:name',
      )
      .map((command) => command.key);
    const count = commands.length;
    await seedCrossMedia(plan, join(directory, 'state.sqlite'), port(commands), undefined, vndbSeed);
    expect(commands.length).toBeGreaterThanOrEqual(count);
    expect(
      commands
        .filter(
          (command) =>
            command.op === 'propose' && command.source.external_id === 's4' && command.statement.property.id === 'schema:name',
        )
        .map((command) => command.key),
    ).toEqual(expect.arrayContaining(keys));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('authored COPY headers feed the dump reader and sealed reopen keeps name command keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-staff-names-copy-'));
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
      vn_staff: ['id\taid\trole\teid\tnote', 'v1\t20\tscenario\t\\N\tWriter Alias'],
      staff: ['id\tgender\tlang\tmain\tdescription\tprod', 's4\t\\N\tja\t10\t\t\\N'],
      staff_alias: ['id\taid\tname\tlatin', 's4\t10\tPreferred Alias\t\\N\ns4\t20\tLater Alias\t\\N'],
      producers: ['id', ''],
      producers_relations: ['id\tpid\trelation', ''],
    };
    for (const name of [
      'anime',
      'chars',
      'chars_vns',
      'extlinks',
      'releases',
      'releases_producers',
      'releases_supersedes',
      'releases_titles',
      'releases_vn',
      'staff_extlinks',
      'vn_anime',
      'vn_extlinks',
      'vn_relations',
      'vn_seiyuu',
    ])
      files[name] ??= ['id', ''];
    for (const [name, [header, body]] of Object.entries(files)) {
      await writeFile(join(vndb, `${name}.header`), `${header}\n`);
      await writeFile(join(vndb, name), body ? `${body}\n` : '');
    }
    await expect(Array.fromAsync(new CrossMediaDumpFiles(bangumi, join(directory, 'vndb')).rows('vndb', 'staff_alias'))).resolves.toEqual([
      { id: 's4', aid: '10', name: 'Preferred Alias', latin: null },
      { id: 's4', aid: '20', name: 'Later Alias', latin: null },
    ]);
    await expect(Array.fromAsync(new CrossMediaDumpFiles(bangumi, join(directory, 'vndb')).rows('vndb', 'staff'))).resolves.toEqual([
      { id: 's4', gender: null, lang: 'ja', main: '10', description: '', prod: null },
    ]);
    const plan = await planCrossMediaSeed(new CrossMediaDumpFiles(bangumi, join(directory, 'vndb')));
    const first = await seedCrossMedia(plan, join(directory, 'state.sqlite'), port(commands), undefined, vndbSeed);
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    expect(staffNames(commands)).toEqual(
      expect.arrayContaining([
        { language: 'und', text: 'Preferred Alias' },
        { language: 'und', text: 'Later Alias' },
      ]),
    );
    const keys = commands
      .filter(
        (command) =>
          command.op === 'propose' && command.source.external_id === 's4' && command.statement.property.id === 'schema:name',
      )
      .map((command) => command.key);
    const count = commands.length;
    await seedCrossMedia(plan, join(directory, 'state.sqlite'), port(commands), undefined, vndbSeed);
    expect(commands.length).toBeGreaterThanOrEqual(count);
    expect(
      commands
        .filter(
          (command) =>
            command.op === 'propose' && command.source.external_id === 's4' && command.statement.property.id === 'schema:name',
        )
        .map((command) => command.key),
    ).toEqual(expect.arrayContaining(keys));
    expect(() =>
      convertCrossMediaEntity({
        external_id: 's4',
        record_revision: null,
        record: {
          id: 's4',
          main: '10',
          aliases: Array.from({ length: vndbStaffNameLimit + 1 }, (_, i) => ({
            id: 's4',
            aid: String(i + 1),
            name: `N${i}`,
          })),
        },
      }),
    ).toThrow(ConversionError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
