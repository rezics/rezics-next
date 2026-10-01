import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Columns copied from the VNDB dump. Anything else is outside this slice. */
export const ADMITTED = {
  vn: ['id', 'olang'],
  vn_titles: ['id', 'lang', 'official', 'title', 'latin'],
  releases: ['id', 'olang', 'released', 'official'],
  releases_titles: ['id', 'lang', 'title', 'latin'],
  releases_platforms: ['id', 'platform'],
  releases_vn: ['id', 'vid', 'rtype'],
  releases_producers: ['id', 'pid', 'developer', 'publisher'],
  producers: ['id', 'type', 'lang', 'name', 'latin'],
} as const;

export const SHOWCASE = {
  vn: 'v18334',
  japaneseWindowsComplete: 'r50668',
  englishSwitchComplete: 'r80447',
  englishWindowsTrial: 'r53222',
  unofficial: 'r96811',
} as const;

export const ODBL = 'https://opendatacommons.org/licenses/odbl/1-0/';
export const DBCL = 'https://opendatacommons.org/licenses/dbcl/1-0/';
/** Shown on the visual-novels Zone. Rights and provenance, not a description of a work. */
export const VNDB_ATTRIBUTION =
  'Visual novel records from the VNDB dump, under the ODbL and DbCL. © VNDB contributors.';

const PLATFORM_NAMES: Record<string, string> = {
  win: 'Windows', swi: 'Switch', lin: 'Linux', mac: 'macOS', and: 'Android', ios: 'iOS',
  web: 'Web', dvd: 'DVD', gba: 'Game Boy Advance', n3d: 'Nintendo 3DS', ps3: 'PlayStation 3',
  ps4: 'PlayStation 4', psp: 'PSP', psv: 'PS Vita', xb3: 'Xbox 360', xbo: 'Xbox One',
  xxs: 'Xbox Series',
};
const PLATFORM_PREFERENCE = ['win', 'swi', 'lin', 'mac', 'and', 'ios', 'psv', 'ps4', 'web'];
const COMPLETENESS = ['complete', 'partial', 'trial'] as const;
const COVERAGE_CAP = 8;

export type Completeness = typeof COMPLETENESS[number];
export interface VnRow { id: string; olang: string }
export interface VnTitleRow { id: string; lang: string; official: boolean; title: string | null; latin: string | null }
export interface ReleaseRow { id: string; olang: string; released: string; official: boolean }
export interface ReleaseTitleRow { id: string; lang: string; title: string | null; latin: string | null }
export interface ReleasePlatformRow { id: string; platform: string }
export interface ReleaseVnRow { id: string; vid: string; rtype: string }
export interface ReleaseProducerRow { id: string; pid: string; developer: boolean; publisher: boolean }
export interface ProducerRow { id: string; type: string; lang: string; name: string | null; latin: string | null }
export interface VndbSlice {
  provenance: {
    dump: { url: string; date: string; timestamp: string; sha256: string; size: number };
    showcase: { vn: string; japaneseWindowsComplete: string; englishSwitchComplete: string;
      englishWindowsTrial: string; unofficial: string };
    territory: null;
    notes: string[];
  };
  tables: {
    vn: VnRow[];
    vn_titles: VnTitleRow[];
    releases: ReleaseRow[];
    releases_titles: ReleaseTitleRow[];
    releases_platforms: ReleasePlatformRow[];
    releases_vn: ReleaseVnRow[];
    releases_producers: ReleaseProducerRow[];
    producers: ProducerRow[];
  };
}
export interface PlannedRelease {
  id: string;
  vn: string;
  official: boolean;
  completeness: Completeness;
  platformCode: string;
  platform: string;
  publicationYear: number | null;
  title: { value: string; language: string };
  /** At most eight languages. A null title string still counts as coverage. */
  coverage: { language: string; completeness: Completeness }[];
  developers: string[];
  publishers: string[];
}

export function recordedTag(value: string): string {
  let tag = '';
  try { tag = Intl.getCanonicalLocales(value)[0] ?? ''; }
  catch { /* invalid tag */ }
  if (!tag || tag.length > 35 || tag.toLowerCase() === 'mul') {
    throw new Error(`VNDB language ${value} is not a recorded tag`);
  }
  return tag;
}

export function metadataTag(value: string): string {
  return recordedTag(value).toLowerCase();
}

export function platformName(code: string): string {
  return PLATFORM_NAMES[code] ?? code;
}

/** One release-v2 record has one platform. Prefer Windows, then the listed order. */
export function choosePlatform(codes: readonly string[]): string {
  if (!codes.length) throw new Error('A VNDB release has no platform');
  return [...codes].sort((left, right) => {
    const rank = (code: string) => {
      const index = PLATFORM_PREFERENCE.indexOf(code);
      return index === -1 ? PLATFORM_PREFERENCE.length : index;
    };
    return rank(left) - rank(right) || left.localeCompare(right);
  })[0]!;
}

/** Locked replay named by fixtures.lock.json. The fixture puller requires this path. */
export const VNDB_LOCKED_SEED =
  'tests/fixtures/seeds/vndb/e472c327c7040df744b759a71e65d64ff4c6f2b92a3516ea2bae015f5600c00b.json';

export function loadVndbSlice(root = join(import.meta.dir, '../../..')): VndbSlice {
  const bytes = readFileSync(join(import.meta.dir, 'slice.json'), 'utf8');
  const locked = readFileSync(join(root, VNDB_LOCKED_SEED), 'utf8');
  if (bytes !== locked) throw new Error('VNDB slice.json and the locked seed differ');
  const parsed: unknown = JSON.parse(bytes);
  assertSlice(parsed);
  return parsed;
}

export function seededReleasePlan(slice: VndbSlice): {
  releases: PlannedRelease[];
  englishWindowsComplete: { vn: string; release: string }[];
} {
  const vnOf = new Map<string, string>();
  const completenessOf = new Map<string, Completeness>();
  for (const row of slice.tables.releases_vn) {
    if (vnOf.has(row.id) && vnOf.get(row.id) !== row.vid) {
      throw new Error(`VNDB release ${row.id} covers more than one visual novel`);
    }
    if (!COMPLETENESS.includes(row.rtype as Completeness)) {
      throw new Error(`VNDB release ${row.id} completeness ${row.rtype} is outside the slice`);
    }
    vnOf.set(row.id, row.vid);
    completenessOf.set(row.id, row.rtype as Completeness);
  }
  const titles = group(slice.tables.releases_titles, row => row.id);
  const platforms = group(slice.tables.releases_platforms, row => row.id);
  const producers = group(slice.tables.releases_producers, row => row.id);
  const vnTitles = group(slice.tables.vn_titles, row => row.id);
  const olng = new Map(slice.tables.vn.map(row => [row.id, row.olang]));
  const releases: PlannedRelease[] = [];
  for (const row of slice.tables.releases) {
    const vn = vnOf.get(row.id);
    const completeness = completenessOf.get(row.id);
    if (!vn || !completeness) throw new Error(`VNDB release ${row.id} has no visual novel row`);
    const codes = (platforms.get(row.id) ?? []).map(item => item.platform);
    const platformCode = choosePlatform(codes);
    const languages = capLanguages((titles.get(row.id) ?? []).map(item => item.lang));
    const credit = producers.get(row.id) ?? [];
    if (credit.length > 16) throw new Error(`VNDB release ${row.id} has more than 16 producers`);
    releases.push({
      id: row.id, vn, official: row.official, completeness, platformCode,
      platform: platformName(platformCode), publicationYear: publicationYear(row.released),
      title: releaseTitle(row, titles.get(row.id) ?? [], vnTitles.get(vn) ?? [], olng.get(vn) ?? row.olang),
      coverage: languages.map(language => ({ language, completeness })),
      developers: credit.filter(item => item.developer).map(item => item.pid).sort(),
      publishers: credit.filter(item => item.publisher).map(item => item.pid).sort(),
    });
  }
  releases.sort((left, right) => left.id.localeCompare(right.id));
  return {
    releases,
    englishWindowsComplete: releases.filter(release => release.platform === 'Windows'
      && release.completeness === 'complete'
      && release.coverage.some(entry => entry.language === 'en'))
      .map(release => ({ vn: release.vn, release: release.id })),
  };
}

function publicationYear(released: string): number | null {
  if (!/^\d{8}$/.test(released)) return null;
  const year = Number(released.slice(0, 4));
  const month = Number(released.slice(4, 6));
  const day = Number(released.slice(6, 8));
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return year;
}

function capLanguages(languages: readonly string[]): string[] {
  const tags = [...new Set(languages.map(recordedTag))];
  const rank = (tag: string) => tag === 'en' ? 0 : tag === 'ja' ? 1 : 2;
  return tags.sort((left, right) => rank(left) - rank(right) || left.localeCompare(right)).slice(0, COVERAGE_CAP);
}

function releaseTitle(release: ReleaseRow, titles: readonly ReleaseTitleRow[],
  vnTitles: readonly VnTitleRow[], vnOlang: string): { value: string; language: string } {
  const pick = (lang: string) => titles.find(row => row.lang === lang && row.title);
  const chosen = pick(release.olang) ?? pick('en') ?? pick('ja') ?? titles.find(row => row.title);
  if (chosen?.title) return { value: chosen.title, language: recordedTag(chosen.lang) };
  const fallback = vnTitles.find(row => row.lang === vnOlang && row.title) ?? vnTitles.find(row => row.title);
  if (!fallback?.title) throw new Error(`VNDB release ${release.id} has no title`);
  return { value: fallback.title, language: recordedTag(fallback.lang) };
}

function group<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = grouped.get(id);
    if (list) list.push(row);
    else grouped.set(id, [row]);
  }
  return grouped;
}

function assertSlice(value: unknown): asserts value is VndbSlice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VNDB slice is not an object');
  const document = value as Record<string, unknown>;
  if (Object.keys(document).sort().join() !== 'provenance,tables') {
    throw new Error('VNDB slice must keep provenance outside the admitted tables');
  }
  const tables = document.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) throw new Error('VNDB slice tables are missing');
  const tableRecord = tables as Record<string, unknown>;
  const names = Object.keys(ADMITTED);
  if (Object.keys(tableRecord).sort().join() !== [...names].sort().join()) {
    throw new Error('VNDB slice tables do not match the admitted set');
  }
  for (const name of names) {
    const rows = tableRecord[name];
    const columns = new Set<string>(ADMITTED[name as keyof typeof ADMITTED]);
    if (!Array.isArray(rows)) throw new Error(`VNDB table ${name} is not a list`);
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`VNDB table ${name} has a nested row`);
      const keys = Object.keys(row);
      if (keys.length !== columns.size || keys.some(key => !columns.has(key))) {
        throw new Error(`VNDB table ${name} has a field outside ${[...columns].join(', ')}`);
      }
      for (const [key, cell] of Object.entries(row)) {
        if (typeof cell === 'boolean' || cell === null) continue;
        if (typeof cell !== 'string' || cell.length > 300
          || [...cell].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
          throw new Error(`VNDB table ${name}.${key} is not an admitted value`);
        }
      }
    }
  }
  const slice = value as VndbSlice;
  if (slice.tables.vn.length < 40 || slice.tables.vn.length > 60) {
    throw new Error('VNDB slice must contain about 50 visual novels');
  }
  if (VNDB_ATTRIBUTION.length > 120) throw new Error('VNDB attribution is longer than a Zone module title');
}
