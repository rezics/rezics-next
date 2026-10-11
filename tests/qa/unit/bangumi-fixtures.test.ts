import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import {
  BANGUMI_IMAGE_FIELDS,
  BANGUMI_USER_POST_FIELDS,
  bangumiGameFacts,
  type BangumiFactSource,
} from '../../../scripts/datasets/bangumi.ts';
import { gamePlatformConcepts } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { readLockedFixture, type FixtureLock } from '../../../scripts/fixtures/pull.ts';
import {
  assertBangumiArchiveIntegrity,
  bangumi,
  bangumiArchive,
  bangumiFixtureId,
  bangumiPins,
  bangumiReuseBasis,
  digestBangumiArchiveTables,
  type BangumiFixture,
} from '../../fixtures/sources/bangumi.ts';

const root = resolve(import.meta.dir, '../../..');
const lock = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/fixtures.lock.json'), 'utf8'),
) as FixtureLock;
const fixture = readLockedFixture(root, 'bangumi', bangumiFixtureId) as BangumiFixture;

function hasField(value: unknown, fields: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => hasField(item, fields));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => fields.has(key) || hasField(child, fields),
  );
}

test('Bangumi pins use the verified 2026-10-06 archive and retain only the three L21 cases', () => {
  const entry = lock.entries.find(
    (item) => item.source === 'bangumi' && item.id === bangumiFixtureId,
  );
  expect(entry).toBeDefined();
  expect(entry?.requestUrl).toBe(bangumiArchive.url);
  expect(entry?.reuseBasis).toBe(bangumiReuseBasis);
  expect(bangumi.normalize(fixture, bangumiFixtureId)).toEqual(fixture);
  expect(fixture.archive).toEqual({
    ...bangumiArchive,
    date: '2026-10-06',
    size: 444_352_951,
    sha256: '2f4273f1aa5d6932c8aa2c448f91771fe0d07ec69c1ef64b4c5098f0760f8d99',
  });
  expect(fixture.license).toBe('CC BY-SA 3.0');
  expect(fixture.tableDigests).toEqual({
    subject: {
      sha256: 'cff0fb10af2c12a2d0e0ff0761abc125dac1d2603a67c8c16b6b3f991aba77d1',
      bytes: 983_549_083,
    },
    episode: {
      sha256: 'c70a4b0a0b4ee3abb6eaad4214ed02a9fef62394af7f93aa8f9b479cc2897696',
      bytes: 339_062_386,
    },
    'subject-relations': {
      sha256: '88ff5fa3bfd547a0d32e115d4310f321e043f44a1d36125ec46d2006fe76d60c',
      bytes: 75_049_254,
    },
  });
  expect(Object.keys(fixture.pins)).toEqual(['anime', 'manga', 'game']);
});

test('Bangumi ONE PIECE anime pin retains every dated episode and its subject subset', () => {
  const pin = fixture.pins.anime;
  expect(pin.id).toBe(bangumiPins.anime.id);
  expect(pin.title).toBe('ONE PIECE');
  expect(pin.subject).toMatchObject({ id: 975, type: 2, name: 'ONE PIECE', name_cn: '航海王' });
  expect(typeof pin.subject.summary).toBe('string');
  expect((pin.subject.summary as string).length).toBe(705);
  expect(pin.episodes).toHaveLength(1_191);
  expect(new Set(pin.episodes?.map((episode) => episode.id)).size).toBe(1_191);
  expect(pin.episodes?.every((episode) => episode.subject_id === pin.id)).toBe(true);
  expect(pin.counts).toEqual({
    subjectRows: 1,
    episodeRows: 1_191,
    relationRows: 410,
    tags: 11,
    metaTags: 6,
    platforms: 0,
  });
  expect(pin.subject.tags).toHaveLength(11);
  expect(pin.subject.meta_tags).toHaveLength(6);
});

test('Bangumi ONE PIECE manga pin retains its dated volume relations and tags', () => {
  const pin = fixture.pins.manga;
  expect(pin.id).toBe(bangumiPins.manga.id);
  expect(pin.title).toBe('ONE PIECE');
  expect(pin.subject).toMatchObject({ id: 3510, type: 1, name: 'ONE PIECE', name_cn: '航海王' });
  expect(typeof pin.subject.summary).toBe('string');
  expect((pin.subject.summary as string).length).toBe(298);
  expect(pin.relations).toHaveLength(349);
  expect(
    pin.relations.filter((relation) => [1002, 1003].includes(Number(relation.relation_type))),
  ).toHaveLength(234);
  expect(pin.counts).toEqual({
    subjectRows: 1,
    episodeRows: 0,
    relationRows: 349,
    tags: 11,
    metaTags: 9,
    platforms: 0,
  });
});

test('Bangumi Starfield game pin maps its three dated platforms through the game platform scheme', () => {
  const pin = fixture.pins.game;
  expect(pin.id).toBe(bangumiPins.game.id);
  expect(pin.title).toBe('Starfield');
  expect(pin.subject).toMatchObject({ id: 249311, type: 4, name: 'Starfield', name_cn: '星空' });
  expect(typeof pin.subject.summary).toBe('string');
  expect((pin.subject.summary as string).length).toBe(912);
  expect(pin.platforms).toEqual(['PS5', 'Xbox Series X/S', 'PC']);
  expect(pin.counts).toEqual({
    subjectRows: 1,
    episodeRows: 0,
    relationRows: 4,
    tags: 11,
    metaTags: 5,
    platforms: 3,
  });
  const scheme = new Map(gamePlatformConcepts.map((platform) => [platform.token, platform.key]));
  expect(pin.platforms?.every((platform) => scheme.has(platform))).toBe(true);
  expect(bangumiGameFacts(pin.subject as BangumiFactSource).platforms).toEqual([
    'ps5',
    'xbox-series-xs',
    'pc',
  ]);
});

test('Bangumi fixture excludes image and user-post fields while preserving source summaries', () => {
  const excluded = new Set<string>([...BANGUMI_IMAGE_FIELDS, ...BANGUMI_USER_POST_FIELDS]);
  for (const pin of Object.values(fixture.pins)) {
    expect(pin.subject.summary).toBeTruthy();
    expect(hasField(pin, excluded)).toBe(false);
  }
});

test('Bangumi archive verification stops on either a size or SHA-256 mismatch', () => {
  expect(() =>
    assertBangumiArchiveIntegrity({ bytes: bangumiArchive.size - 1, sha256: bangumiArchive.sha256 }),
  ).toThrow('size mismatch');
  expect(() =>
    assertBangumiArchiveIntegrity({ bytes: bangumiArchive.size, sha256: '0'.repeat(64) }),
  ).toThrow('SHA-256 mismatch');
});

test('Bangumi table digests cover full uncompressed table bytes through a streaming ZIP pass', async () => {
  const directory = join(root, '.temp', `bangumi-table-digest-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  try {
    const rows = {
      subject: Buffer.from('{"id":1}\n'),
      episode: Buffer.from('{"id":2}\n'),
      'subject-relations': Buffer.from('{"subject_id":1,"related_subject_id":2}\n'),
    };
    const path = join(directory, 'archive.zip');
    writeFileSync(
      path,
      zipSync(
        Object.fromEntries(
          Object.entries(rows).map(([table, bytes]) => [`${table}.jsonlines`, bytes]),
        ),
      ),
    );
    const digests = await digestBangumiArchiveTables(path);
    for (const [table, bytes] of Object.entries(rows)) {
      expect(digests[table as keyof typeof digests]).toEqual({
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.byteLength,
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
