import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Unzip, UnzipInflate, type AsyncFlateStreamHandler } from 'fflate';
import {
  BANGUMI_IMAGE_FIELDS,
  BANGUMI_USER_POST_FIELDS,
  bangumiMappedData,
  scanBangumiArchive,
} from '../../../scripts/datasets/bangumi.ts';
import { gamePlatformConcepts } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import type { FixtureRequest, FixtureSource } from './wikidata.ts';

type Row = Record<string, unknown>;
type BangumiTable = 'subject' | 'episode' | 'subject-relations';

export const bangumiArchive = {
  name: 'dump-2026-10-06.210359Z.zip',
  date: '2026-10-06',
  createdAt: '2026-10-06T21:03:59Z',
  url: 'https://github.com/bangumi/Archive/releases/download/archive/dump-2026-10-06.210359Z.zip',
  size: 444_352_951,
  sha256: '2f4273f1aa5d6932c8aa2c448f91771fe0d07ec69c1ef64b4c5098f0760f8d99',
} as const;

export const bangumiFixtureId = 'l21-2026-10-06';
export const bangumiPins = {
  anime: { id: 975, type: 2, title: 'ONE PIECE' },
  manga: { id: 3510, type: 1, title: 'ONE PIECE' },
  game: { id: 249311, type: 4, title: 'Starfield' },
} as const;

const requiredTables: readonly BangumiTable[] = ['subject', 'episode', 'subject-relations'];
const responseAgent = 'REZICSFixtureHarness/1.0 (+https://github.com/rezics/rezics-next)';
const excludedFields = new Set<string>([...BANGUMI_IMAGE_FIELDS, ...BANGUMI_USER_POST_FIELDS]);

export const bangumiReuseBasis =
  'Bangumi Archive data under CC BY-SA 3.0; subject summaries are included, covers and other image fields are excluded. The committed seed contains only the three pinned subjects, their direct subject-relations, and all episodes of the pinned anime. https://github.com/bangumi/Archive https://creativecommons.org/licenses/by-sa/3.0/';

export interface BangumiTableDigest {
  sha256: string;
  bytes: number;
}

export interface BangumiPinnedRecord {
  kind: 'anime' | 'manga' | 'game';
  id: number;
  title: string;
  subject: Row;
  relations: Row[];
  episodes?: Row[];
  platforms?: string[];
  counts: {
    subjectRows: 1;
    episodeRows: number;
    relationRows: number;
    tags: number;
    metaTags: number;
    platforms: number;
  };
}

export interface BangumiFixture {
  archive: typeof bangumiArchive;
  license: 'CC BY-SA 3.0';
  tableDigests: Record<BangumiTable, BangumiTableDigest>;
  pins: Record<keyof typeof bangumiPins, BangumiPinnedRecord>;
}

export function assertBangumiArchiveIntegrity(actual: { bytes: number; sha256: string }): void {
  if (actual.bytes !== bangumiArchive.size) {
    throw new Error(
      `Bangumi archive size mismatch: expected ${bangumiArchive.size}, got ${actual.bytes}`,
    );
  }
  if (actual.sha256 !== bangumiArchive.sha256) {
    throw new Error(
      `Bangumi archive SHA-256 mismatch: expected ${bangumiArchive.sha256}, got ${actual.sha256}`,
    );
  }
}

async function archiveIntegrity(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) {
    hash.update(chunk);
  }
  return { bytes: statSync(path).size, sha256: hash.digest('hex') };
}

async function cachedArchive(
  root: string,
  fetcher: typeof fetch,
): Promise<string> {
  const path = join(root, '.temp', 'fixtures', 'bangumi', bangumiArchive.name);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    assertBangumiArchiveIntegrity(await archiveIntegrity(path));
    return path;
  }

  const temporary = `${path}.${process.pid}.tmp`;
  const response = await fetcher(bangumiArchive.url, {
    headers: { 'User-Agent': responseAgent, Accept: 'application/zip' },
  });
  if (!response.ok) throw new Error(`Bangumi archive fetch: HTTP ${response.status}`);
  if (!response.body) throw new Error('Bangumi archive fetch returned no body');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength !== bangumiArchive.size) {
    throw new Error(
      `Bangumi archive size mismatch: expected ${bangumiArchive.size}, got ${contentLength}`,
    );
  }

  const hash = createHash('sha256');
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > bangumiArchive.size) {
        callback(
          new Error(
            `Bangumi archive size mismatch: expected ${bangumiArchive.size}, received more`,
          ),
        );
        return;
      }
      hash.update(buffer);
      callback(null, buffer);
    },
  });
  try {
    await pipeline(
      Readable.from(response.body as AsyncIterable<Uint8Array>),
      verifier,
      createWriteStream(temporary, { flags: 'w' }),
    );
    assertBangumiArchiveIntegrity({ bytes, sha256: hash.digest('hex') });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return path;
}

export function digestBangumiArchiveTables(
  path: string,
): Promise<Record<BangumiTable, BangumiTableDigest>> {
  return (async () => {
    const digests = new Map<BangumiTable, BangumiTableDigest>();
    const completed = new Map<BangumiTable, boolean>();
    const seen = new Set<string>();
    let failure: unknown;
    class DiscardInflate {
      static compression = 8;
      ondata: AsyncFlateStreamHandler = () => {};
      push(_bytes: Uint8Array, final: boolean) {
        if (final) this.ondata(null, new Uint8Array(), true);
      }
    }
    const unzip = new Unzip((file) => {
      const table = basename(file.name).replace(/\.jsonlines$/u, '') as BangumiTable;
      if (!requiredTables.includes(table)) {
        unzip.register(DiscardInflate);
        file.ondata = () => {};
        file.start();
        return;
      }
      unzip.register(UnzipInflate);
      if (seen.has(table)) {
        failure = new Error(`Duplicate Bangumi archive table: ${table}`);
        return;
      }
      seen.add(table);
      const hash = createHash('sha256');
      let bytes = 0;
      let finished = false;
      completed.set(table, false);
      file.ondata = (error, chunk, final) => {
        if (failure || finished) return;
        try {
          if (error) throw error;
          hash.update(chunk);
          bytes += chunk.byteLength;
          if (final) {
            digests.set(table, { sha256: hash.digest('hex'), bytes });
            finished = true;
            completed.set(table, true);
          }
        } catch (caught) {
          failure = caught;
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) {
      unzip.push(chunk);
      if (failure) throw failure;
    }
    unzip.push(new Uint8Array(), true);
    if (failure) throw failure;
    for (const table of requiredTables) {
      if (!seen.has(table)) throw new Error(`Bangumi archive lacks table: ${table}`);
      if (completed.get(table) !== true || !digests.has(table)) {
        throw new Error(`Truncated Bangumi archive table: ${table}`);
      }
    }
    return Object.fromEntries(requiredTables.map((table) => [table, digests.get(table)!])) as Record<
      BangumiTable,
      BangumiTableDigest
    >;
  })();
}

function record(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function sourceTextValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(sourceTextValues);
  const row = record(value);
  if (typeof row?.v === 'string') return [row.v];
  if (typeof row?.value === 'string') return [row.value];
  return [];
}

function infoboxValues(infobox: unknown, key: string): unknown[] {
  if (typeof infobox === 'string') {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|\\r?\\n)\\|${escaped}\\s*=([\\s\\S]*?)(?=\\r?\\n\\||$)`, 'g');
    return [...infobox.matchAll(pattern)].map((match) => match[1] ?? '');
  }
  if (!Array.isArray(infobox)) return [];
  return infobox
    .filter((item) => record(item)?.key === key)
    .map((item) => record(item)?.value);
}

export function bangumiPlatformTokens(infobox: unknown): string[] {
  const found: string[] = [];
  for (const value of infoboxValues(infobox, '平台')) {
    for (const raw of sourceTextValues(value)) {
      const cleaned = raw.trim().replace(/^\{([\s\S]*)\}$/u, '$1');
      found.push(
        ...cleaned
          .split(/\r?\n|<br\s*\/?\s*>|[、，,;；]/iu)
          .map((token) => token.trim().replace(/^\[|\]$/gu, '').trim())
          .filter(Boolean),
      );
    }
  }
  return [...new Set(found)];
}

function hasExcludedFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExcludedFields);
  const row = record(value);
  if (!row) return false;
  return Object.entries(row).some(([key, child]) => excludedFields.has(key) || hasExcludedFields(child));
}

function pinCounts(pin: BangumiPinnedRecord): BangumiPinnedRecord['counts'] {
  const tags = Array.isArray(pin.subject.tags) ? pin.subject.tags.length : -1;
  const metaTags = Array.isArray(pin.subject.meta_tags) ? pin.subject.meta_tags.length : -1;
  return {
    subjectRows: 1,
    episodeRows: pin.episodes?.length ?? 0,
    relationRows: pin.relations.length,
    tags,
    metaTags,
    platforms: pin.platforms?.length ?? 0,
  };
}

function validatePin(
  fixture: BangumiFixture,
  kind: keyof typeof bangumiPins,
): void {
  const expected = bangumiPins[kind];
  const pin = fixture.pins[kind];
  const subject = record(pin?.subject);
  if (
    !pin || pin.kind !== kind || pin.id !== expected.id || pin.title !== expected.title ||
    !subject || subject.id !== expected.id || subject.type !== expected.type ||
    subject.name !== expected.title
  ) {
    throw new Error(`Bangumi ${kind} subject does not match the dated archive pin`);
  }
  if (!Array.isArray(pin.relations)) throw new Error(`Bangumi ${kind} pin lacks direct relations`);
  if (typeof subject.summary !== 'string' || !subject.summary.trim()) {
    throw new Error(`Bangumi ${kind} subject is missing its archive summary`);
  }
  if (!Array.isArray(subject.tags) || !Array.isArray(subject.meta_tags)) {
    throw new Error(`Bangumi ${kind} subject is missing its archive tag subset`);
  }
  if (hasExcludedFields(pin)) {
    throw new Error(`Bangumi ${kind} pin contains excluded image or user-post fields`);
  }
  if (pin.relations.some((relation) =>
    relation.subject_id !== expected.id && relation.related_subject_id !== expected.id)) {
    throw new Error(`Bangumi ${kind} pin contains a non-incident subject relation`);
  }
  if (JSON.stringify(pin.counts) !== JSON.stringify(pinCounts(pin))) {
    throw new Error(`Bangumi ${kind} pin counts do not match its retained rows`);
  }
}

export function normalizeBangumiFixture(raw: unknown, id: string): BangumiFixture {
  const fixture = record(raw) as BangumiFixture | null;
  if (id !== bangumiFixtureId || !fixture) throw new Error(`Malformed Bangumi fixture ${id}`);
  if (
    fixture.license !== 'CC BY-SA 3.0' ||
    JSON.stringify(fixture.archive) !== JSON.stringify(bangumiArchive)
  ) {
    throw new Error('Bangumi fixture does not match its dated archive and licence pin');
  }
  if (!fixture.tableDigests || Object.keys(fixture.tableDigests).sort().join(',') !== [...requiredTables].sort().join(',')) {
    throw new Error('Bangumi fixture lacks the dated archive table digests');
  }
  for (const table of requiredTables) {
    const digest = fixture.tableDigests[table];
    if (!digest || !/^[a-f0-9]{64}$/u.test(digest.sha256) || !Number.isSafeInteger(digest.bytes) || digest.bytes < 1) {
      throw new Error(`Bangumi fixture has an invalid ${table} table digest`);
    }
  }
  if (!fixture.pins || Object.keys(fixture.pins).sort().join(',') !== 'anime,game,manga') {
    throw new Error('Bangumi fixture must contain exactly the three L21 pins');
  }
  for (const kind of Object.keys(bangumiPins) as (keyof typeof bangumiPins)[]) {
    validatePin(fixture, kind);
  }
  const anime = fixture.pins.anime;
  if (
    !Array.isArray(anime.episodes) || anime.episodes.length < 1_000 ||
    anime.episodes.some((episode) => episode.subject_id !== bangumiPins.anime.id)
  ) {
    throw new Error('Bangumi anime pin must retain every archived episode row');
  }
  const mangaVolumeRelations = fixture.pins.manga.relations.filter((relation) =>
    [1002, 1003].includes(Number(relation.relation_type)));
  if (mangaVolumeRelations.length === 0) {
    throw new Error('Bangumi manga pin lacks an archive volume relation');
  }
  const platforms = fixture.pins.game.platforms;
  const platformTokens = bangumiPlatformTokens(fixture.pins.game.subject.infobox);
  const knownPlatforms: ReadonlySet<string> = new Set(
    gamePlatformConcepts.map((platform) => platform.token),
  );
  if (
    !platforms || platforms.length < 3 || JSON.stringify(platforms) !== JSON.stringify(platformTokens) ||
    platforms.some((platform) => !knownPlatforms.has(platform))
  ) {
    throw new Error('Bangumi game platforms do not all map through the platform scheme');
  }
  return fixture;
}

async function extractPins(path: string): Promise<Pick<BangumiFixture, 'pins'>> {
  const selectedIds: ReadonlySet<number> = new Set(
    Object.values(bangumiPins).map((pin) => pin.id),
  );
  const subjects = new Map<number, Row>();
  const episodes: Row[] = [];
  const relations: Row[] = [];
  await scanBangumiArchive(path, new Set(requiredTables), (table, row) => {
    if (table === 'subject') {
      if (typeof row.id === 'number' && selectedIds.has(row.id)) {
        if (subjects.has(row.id)) throw new Error(`Duplicate Bangumi pinned subject: ${row.id}`);
        subjects.set(row.id, row);
      }
    } else if (table === 'episode') {
      if (row.subject_id === bangumiPins.anime.id) episodes.push(row);
    } else if (
      selectedIds.has(Number(row.subject_id)) || selectedIds.has(Number(row.related_subject_id))
    ) {
      relations.push(row);
    }
  });

  const pinnedSubject = (kind: keyof typeof bangumiPins): Row => {
    const expected = bangumiPins[kind];
    const subject = subjects.get(expected.id);
    if (!subject) throw new Error(`Bangumi archive lacks pinned ${kind} subject ${expected.id}`);
    return bangumiMappedData(subject);
  };
  const relationRows = (id: number) =>
    relations.filter((relation) => relation.subject_id === id || relation.related_subject_id === id)
      .map((relation) => bangumiMappedData(relation));
  const makePin = (
    kind: keyof typeof bangumiPins,
    episodeRows: Row[] = [],
  ): BangumiPinnedRecord => {
    const expected = bangumiPins[kind];
    const subject = pinnedSubject(kind);
    const pin: BangumiPinnedRecord = {
      kind,
      id: expected.id,
      title: String(subject.name ?? ''),
      subject,
      relations: relationRows(expected.id),
      ...(kind === 'anime' ? { episodes: episodeRows.map((episode) => bangumiMappedData(episode)) } : {}),
      ...(kind === 'game' ? { platforms: bangumiPlatformTokens(subject.infobox) } : {}),
      counts: {
        subjectRows: 1,
        episodeRows: episodeRows.length,
        relationRows: relationRows(expected.id).length,
        tags: Array.isArray(subject.tags) ? subject.tags.length : -1,
        metaTags: Array.isArray(subject.meta_tags) ? subject.meta_tags.length : -1,
        platforms: kind === 'game' ? bangumiPlatformTokens(subject.infobox).length : 0,
      },
    };
    return pin;
  };

  return {
    pins: {
      anime: makePin('anime', episodes),
      manga: makePin('manga'),
      game: makePin('game'),
    },
  };
}

async function acquireBangumiFixture(
  root: string,
  request: FixtureRequest,
  fetcher: typeof fetch,
): Promise<unknown> {
  if (request.id !== bangumiFixtureId || request.url !== bangumiArchive.url) {
    throw new Error(`Unsupported Bangumi archive pin ${request.id}`);
  }
  const path = await cachedArchive(root, fetcher);
  const pins = await extractPins(path);
  const tableDigests = await digestBangumiArchiveTables(path);
  return {
    archive: bangumiArchive,
    license: 'CC BY-SA 3.0',
    tableDigests,
    ...pins,
  };
}

type AcquiringBangumiSource = FixtureSource & {
  capture(root: string, request: FixtureRequest, fetcher: typeof fetch): Promise<unknown>;
};

export const bangumi: AcquiringBangumiSource = {
  name: 'bangumi',
  minimumIntervalMs: 1000,
  requests: [{ id: bangumiFixtureId, url: bangumiArchive.url }],
  reuseBasis: bangumiReuseBasis,
  normalize: normalizeBangumiFixture,
  capture: acquireBangumiFixture,
};
