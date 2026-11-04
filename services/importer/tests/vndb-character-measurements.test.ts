import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision, convertCrossMediaEntity } from '@rezics/conversion/cross-media-entities';
import {
  CrossMediaDumpFiles,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const VNDB_CHARS_COLUMNS = [
  'id',
  'image',
  'bloodt',
  'cup_size',
  'sex',
  'spoil_sex',
  'gender',
  'spoil_gender',
  'main',
  'main_spoil',
  's_bust',
  's_waist',
  's_hip',
  'birthday',
  'height',
  'weight',
  'age',
  'description',
] as const;
const centimeter = 'http://www.wikidata.org/entity/Q174728';
const kilogram = 'http://www.wikidata.org/entity/Q11570';
const vndbSeed = { providers: ['vndb'] as const, mediaDeadlineMs: 0 };

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
    'vndb/chars_vns': [
      { id: 'c1', vid: 'v1', rid: null, role: 'main', spoil: '0' },
      { id: 'c2', vid: 'v1', rid: null, role: 'side', spoil: '0' },
    ],
    'vndb/chars': [
      { id: 'c1', name: 'Authored heroine', height: '157', weight: '48' },
      { id: 'c2', name: 'Authored side', height: null, weight: '0' },
    ],
    ...extra,
  };
  return {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

function port(commands: BatchCommand[], fence?: string): CrossMediaPort {
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
    async fence({ externalId }) {
      return externalId === fence
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

function content(command: BatchCommand) {
  return command.op === 'propose' && command.statement.value.type === 'value'
    ? command.statement.value.content
    : undefined;
}

function charsCopy(id: string, height: string, weight: string) {
  const cells: Record<string, string> = {
    id,
    image: '\\N',
    bloodt: '\\N',
    cup_size: '\\N',
    sex: '\\N',
    spoil_sex: '\\N',
    gender: '\\N',
    spoil_gender: '\\N',
    main: '\\N',
    main_spoil: '0',
    s_bust: '\\N',
    s_waist: '\\N',
    s_hip: '\\N',
    birthday: '\\N',
    height,
    weight,
    age: '\\N',
    description: '\\N',
  };
  return VNDB_CHARS_COLUMNS.map((column) => cells[column]!).join('\t');
}

test('operator plans authored COPY character measurements and imports exact supported facts through the seed caller', async () => {
  const plan = await planCrossMediaSeed(families());
  expect(plan.entities.vndb.map((row) => row.key).filter((key) => key.startsWith('c')).sort()).toEqual(['c1', 'c2']);
  expect(plan.entities.vndb.find((row) => row.key === 'c1')?.payload).toMatchObject({
    height: '157',
    weight: '48',
  });
  const commands: BatchCommand[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'vndb-character-measurements-'));
  try {
    const dump = join(directory, 'vndb');
    await mkdir(join(dump, 'db'), { recursive: true });
    await writeFile(join(dump, 'db/chars.header'), `${VNDB_CHARS_COLUMNS.join('\t')}\n`);
    await writeFile(
      join(dump, 'db/chars'),
      `${charsCopy('c1', '157', '48')}\n${charsCopy('c2', '\\N', '0')}\n${charsCopy('c3', '-1', '48.2')}\n`,
    );
    const copyRows = await Array.fromAsync(new CrossMediaDumpFiles(dump, dump).rows('vndb', 'chars'));
    expect(copyRows).toEqual([
      expect.objectContaining({ id: 'c1', height: '157', weight: '48' }),
      expect.objectContaining({ id: 'c2', height: null, weight: '0' }),
      expect.objectContaining({ id: 'c3', height: '-1', weight: '48.2' }),
    ]);
    const copied = convertCrossMediaEntity(
      { external_id: 'c1', record_revision: null, record: { ...copyRows[0], name: 'Authored heroine' } },
      { subjectId: '00000000-0000-4000-8000-000000000001' },
    );
    expect(copied.converter_revision).toBe(converter_revision);
    expect(
      copied.proposals.some(
        (command) =>
          command.op === 'propose' &&
          command.statement.property.id === 'schema:height' &&
          JSON.stringify(content(command)) === JSON.stringify({ amount: '+157', unit: centimeter }),
      ),
    ).toBe(true);
    const first = await seedCrossMedia(plan, join(directory, 'state.sqlite'), port(commands), undefined, vndbSeed);
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    const proposed = commands.filter((command) => command.op === 'propose');
    expect(
      proposed.some(
        (command) =>
          command.statement.property.id === 'schema:height' &&
          JSON.stringify(content(command)) === JSON.stringify({ amount: '+157', unit: centimeter }),
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.statement.property.id === 'schema:weight' &&
          JSON.stringify(content(command)) === JSON.stringify({ amount: '+48', unit: kilogram }),
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) => command.source.external_id === 'c2' && command.statement.property.id === 'schema:height',
      ),
    ).toBe(false);
    const count = commands.length;
    const again = await seedCrossMedia(plan, join(directory, 'state.sqlite'), port(commands), undefined, vndbSeed);
    expect(again.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    expect(commands.length).toBeGreaterThanOrEqual(count);
    const changed = await seedCrossMedia(
      await planCrossMediaSeed(
        families({
          'vndb/chars': [
            { id: 'c1', name: 'Authored heroine', height: '158', weight: '48' },
            { id: 'c2', name: 'Authored side', height: null, weight: '0' },
          ],
        }),
      ),
      join(directory, 'changed.sqlite'),
      port(commands),
      undefined,
      vndbSeed,
    );
    expect(changed.runs.vndb?.counts.changed).toBeGreaterThan(0);
    const fenced: BatchCommand[] = [];
    await seedCrossMedia(plan, join(directory, 'fenced.sqlite'), port(fenced, 'c1'), undefined, vndbSeed);
    expect(
      fenced.some((command) => command.op === 'propose' && command.source.external_id === 'c1'),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
