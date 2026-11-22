import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError, throwAccessUnavailable } from '../access/unavailable.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import { routeOf } from '../route/route.ts';
import { readSubjectPublicStates } from '../semantic/index.ts';
import { seal, unseal, type KeyRing } from '../tokens/seal.ts';
import {
  LAUNCHER_PAGE_SIZE,
  LAUNCHER_TITLE_KEY_BYTES,
  type LauncherPackage,
  type LauncherRelease,
} from './contract.ts';
import packageBrowse from './package-browse.sql';
import packageRead from './package-read.sql';
import packageSearch from './package-search.sql';
import releaseBrowse from './release-browse.sql';
import releaseRead from './release-read.sql';

type Database = Pick<PoolClient, 'query'>;
type PackageRow = {
  id: string;
  kind: string;
  publisher: string;
  title: string;
  summary: string;
  subject_id: string | null;
};
type ReleaseRow = {
  package_id: string;
  id: string;
  version: string;
  compatibility: string;
  artifact_url: string;
  artifact_size: string;
  artifact_sha256: string;
  requirements: string;
};

type ReadConfig = { pool: Pool; tokens: KeyRing };

function packageView(row: PackageRow, visibleSubjects: ReadonlySet<string>): LauncherPackage {
  const { id, kind, publisher, title, summary, subject_id } = row;
  if (kind !== 'overlay-panel' && kind !== 'minecraft-mod') throw new Error('Invalid stored Launcher package kind');
  return {
    id,
    kind,
    publisher,
    title,
    summary,
    ...(subject_id && visibleSubjects.has(subject_id) ? { subjectId: subject_id } : {}),
  };
}

function releaseView(row: ReleaseRow): LauncherRelease {
  return {
    id: row.id,
    packageId: row.package_id,
    version: row.version,
    compatibility: JSON.parse(row.compatibility) as LauncherRelease['compatibility'],
    artifact: { url: row.artifact_url, size: Number(row.artifact_size), sha256: row.artifact_sha256 },
    requires: JSON.parse(row.requirements) as LauncherRelease['requires'],
  };
}

export function launcherSearchKey(title: string): string {
  return title.normalize('NFKC').toLowerCase().trim();
}

/** First string above the prefix range, in PostgreSQL's UTF-8 C collation. */
function prefixUpperBound(prefix: string): string {
  const points = Array.from(prefix);
  while (points.length > 0) {
    const value = points.pop()!.codePointAt(0)!;
    if (value < 0x10ffff) return points.join('') + String.fromCodePoint(value === 0xd7ff ? 0xe000 : value + 1);
  }
  return '\u{10ffff}'.repeat(LAUNCHER_TITLE_KEY_BYTES / 4 + 1);
}

function cursorValues<T extends string[]>(
  tokens: KeyRing,
  scope: string,
  cursor: string | undefined,
  length: T['length'],
): T | undefined {
  if (cursor === undefined) return undefined;
  const decoded = unseal(tokens, scope, cursor);
  if (!Array.isArray(decoded) || decoded.length !== length || decoded.some((item) => typeof item !== 'string'))
    throw new ProblemError('invalid_cursor');
  return decoded as T;
}

function read<T>(config: ReadConfig, deadline: number, callback: (db: Database) => Promise<T>) {
  return withBoundedReadConnection(config.pool, deadline, callback, {
    deadlineError: () => new AccessUnavailableError('deadline'),
    mapError(error) {
      throwAccessUnavailable(error, deadline);
      return error;
    },
  });
}

function concealed() {
  return new ProblemError('not_found', { headers: { 'cache-control': 'no-store' } });
}

async function mapPackages(db: Database, rows: readonly PackageRow[]): Promise<LauncherPackage[]> {
  const ids = [
    ...new Set(rows.flatMap(({ subject_id }) => (subject_id && routeOf(subject_id) !== null ? [subject_id] : []))),
  ];
  const states = ids.length ? await readSubjectPublicStates(db, ids) : [];
  const visible = new Set(states.filter((state) => state.visibility === 'visible').map((state) => state.id));
  return rows.map((row) => packageView(row, visible));
}

export function listLauncherPackages(
  config: ReadConfig,
  query: { kind: LauncherPackage['kind']; q?: string; cursor?: string },
  deadline: number,
) {
  const { kind, cursor } = query;
  const prefix = launcherSearchKey(query.q ?? '');
  const scope = JSON.stringify(['launcher-packages', kind, prefix]);
  const values = cursorValues<[string, string]>(config.tokens, scope, cursor, 2);
  if (Buffer.byteLength(prefix) > LAUNCHER_TITLE_KEY_BYTES) return Promise.resolve({ items: [], nextCursor: null });
  return read(config, deadline, async (db) => {
    const rows = prefix
      ? await packageSearch.run(db, {
          kind,
          after_title: values?.[0] ?? prefix,
          after_id: values?.[1] ?? '',
          upper: prefixUpperBound(prefix),
          limit: LAUNCHER_PAGE_SIZE + 1,
        })
      : await packageBrowse.run(db, { kind, after_id: values?.[1] ?? '', limit: LAUNCHER_PAGE_SIZE + 1 });
    const page = rows.slice(0, LAUNCHER_PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: await mapPackages(db, page),
      nextCursor:
        rows.length > LAUNCHER_PAGE_SIZE && last
          ? seal(config.tokens, scope, ['title_key' in last ? last.title_key : '', last.id])
          : null,
    };
  });
}

export function getLauncherPackage(config: ReadConfig, id: string, deadline: number) {
  return read(config, deadline, async (db) => {
    const row = await packageRead.run(db, { id });
    if (!row) throw concealed();
    return (await mapPackages(db, [row]))[0]!;
  });
}

export async function readLauncherRelease(db: Database, packageId: string, releaseId: string) {
  const row = await releaseRead.run(db, { package_id: packageId, release_id: releaseId });
  return row ? releaseView(row) : null;
}

export function getLauncherRelease(config: ReadConfig, packageId: string, releaseId: string, deadline: number) {
  return read(config, deadline, async (db) => {
    const release = await readLauncherRelease(db, packageId, releaseId);
    if (!release) throw concealed();
    return release;
  });
}

export function listLauncherReleases(
  config: ReadConfig,
  packageId: string,
  cursor: string | undefined,
  deadline: number,
) {
  const scope = JSON.stringify(['launcher-releases', packageId]);
  const values = cursorValues<[string, string]>(config.tokens, scope, cursor, 2);
  return read(config, deadline, async (db) => {
    const rows = await releaseBrowse.run(db, {
      package_id: packageId,
      after_time: values?.[0] ?? 'infinity',
      after_id: values?.[1] ?? '',
      limit: LAUNCHER_PAGE_SIZE + 1,
    });
    const page = rows.slice(0, LAUNCHER_PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map(releaseView),
      nextCursor:
        rows.length > LAUNCHER_PAGE_SIZE && last ? seal(config.tokens, scope, [last.published_at, last.id]) : null,
    };
  });
}
