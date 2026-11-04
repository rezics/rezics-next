import { readFileSync } from 'node:fs';
import { types as utilTypes } from 'node:util';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Release } from '@rezics/definitions';
import {
  BATCH_LIMIT,
  checkBatchWrite,
  type BatchCommand,
  type BatchReference,
  type BatchStatement,
  type FieldGroup,
} from '@rezics/definitions/bulk';
import { ConversionError, type ConversionInput, type ConvertedRecord, type ConversionDiagnostic } from './index.ts';
import {
  bangumiCharacterNameScalar,
  bangumiCharacterNameLimits,
  parseBangumiCharacterInfoboxNames,
} from './bangumi-character-names.ts';
import {
  canonicalLanguageTag,
  commandKey,
  inLanguageTag,
  latinLanguageTag,
  matchesReleasedStringValue,
  projectVndbReleaseMinimumAge,
  sourceDigest,
  sourceEnvelope,
  sourceWebsiteUrl,
  textDocument,
  type ConversionContext,
} from './support.ts';
import { vndbLimits } from './vndb.ts';
import {
  projectBangumiCharacterMeasurements,
  type BangumiCharacterMeasurementProjection,
} from './bangumi-character-measurements.ts';

export const converter_revision = 'cross-media-entities@9';
export const bangumiCharacterNameCommandLimit =
  2 + bangumiCharacterNameLimits.maxNameFacts + bangumiCharacterNameLimits.maxAlternateNameFacts + 1;
export const vndbReleaseNameLimits = Object.freeze({
  maxTitles: vndbLimits.maxTitles,
  maxClassificationAssociations: 64,
  maxNames: vndbLimits.maxTitleCandidates,
  maxAlternateNames: vndbLimits.maxAliases,
  stringBytes: vndbLimits.stringBytes,
  titleChars: 1500,
  recordBytes: vndbLimits.recordBytes,
  maxCommands: 1 + vndbLimits.maxTitleCandidates + vndbLimits.maxAliases + vndbLimits.maxLinks + 3,
});
/** Dump COPY bigint cell `0`; not a padded barcode and not the JSON API null. */
export const vndbReleaseGtinUnknown = '0';
export type VndbReleaseGtin =
  | { status: 'absent' }
  | { status: 'unknown'; source: string }
  | { status: 'invalid'; source: unknown }
  | { status: 'admitted'; gtin: string };

/** Keep COPY decimal spelling. Safe integers stringify without padding; unsafe numbers stay numbers. */
export function retainVndbReleaseGtin(value: unknown): unknown {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return value;
}

/** Admit only the released GTIN lexical contract. Unknown `0` and invalid cells are withheld. */
export function decodeVndbReleaseGtin(value: unknown): VndbReleaseGtin {
  if (value === undefined || value === null || value === '') return { status: 'absent' };
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return { status: 'invalid', source: value };
  const source = retainVndbReleaseGtin(value);
  if (typeof source !== 'string' || !source.isWellFormed()) return { status: 'invalid', source };
  if (source === vndbReleaseGtinUnknown) return { status: 'unknown', source };
  if (!matchesReleasedStringValue('schema:gtin', source)) return { status: 'invalid', source };
  return { status: 'admitted', gtin: source };
}

export const vndbCharacterNameLimits = Object.freeze({
  maxNames: 64,
  maxAliases: 64,
  stringBytes: 4096,
  maxCodepoints: 1500,
  recordBytes: 65_536,
  maxCommands: 257,
});
const gregorianCalendar = 'http://www.wikidata.org/entity/Q1985727';
const durationSecond = 'http://www.wikidata.org/entity/Q11574';
const centimeter = 'http://www.wikidata.org/entity/Q174728';
const kilogram = 'http://www.wikidata.org/entity/Q11570';
const episodeOrdinalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
/** Finite admitted staff aliases per person; overflow is rejected, never truncated. */
export const vndbStaffNameLimit = 64;
export const vndbStaffNameLimits = Object.freeze({
  maxAliases: vndbStaffNameLimit,
  maxNameChars: 200,
  recordBytes: vndbLimits.recordBytes,
  maxCommands: vndbStaffNameLimit + vndbLimits.maxLinks + 1,
});
const copySmallint = /^(?:0|[1-9][0-9]{0,4})$/u;
const smallintMax = '32767';

export type SourceMapping = {
  status: 'existing' | 'proposed' | 'omitted';
  term?: string;
  inverse?: boolean;
  canonicalByReverse?: Readonly<Record<string, { term: string }>>;
  reason?: string;
  concept?: { id: string; scheme: string; label: string };
};

export type BangumiStaffRoleDefinition = Readonly<{
  uri: string;
  schemeUri: string;
  label: string;
  sourceUri: string;
}>;

type InventoryValue = {
  id?: number | string;
  value?: string;
  mapping?: SourceMapping;
  term?: string;
  inverse?: boolean;
  status?: string;
  reason?: string;
};
type BangumiInventory = { enumerations: { id: string; values: InventoryValue[] }[] };
type VndbInventory = { enumerations: Record<string, InventoryValue[]> };

const FAMILY_TERMS = new Set([
  'wdt:P155',
  'wdt:P179',
  'wdt:P361',
  'wdt:P144',
  'wdt:P1889',
  'schema:exampleOfWork',
  'rezics:crossMediaCounterpart',
  'rezics:sideStoryOf',
  'rezics:spinOffOf',
  'rezics:sameCharacters',
  'rezics:sameSetting',
  'rezics:alternativeSetting',
  'rezics:alternativeVersion',
  'rezics:summaryOf',
  'rezics:expansionCounterpart',
  'rezics:artbookCounterpart',
  'rezics:editionCounterpart',
]);

// Pinned subject_platforms.yml / platform.go.json ids, type, type_cn and alias.
const TV_PLATFORMS = new Set([
  '0',
  '1',
  '2',
  '3',
  '6001',
  '6003',
  '6004',
  'other',
  'misc',
  'jp',
  'en',
  'cn',
  'tv',
  'TV',
  'live',
  'show',
  '其他',
  '日剧',
  '欧美剧',
  '华语剧',
  '电视剧',
  '演出',
  '综艺',
]);
const FILM_PLATFORMS = new Set(['6002', 'movie', 'Movie', '电影']);

let bangumiInventory: BangumiInventory | undefined;
let vndbInventory: VndbInventory | undefined;
const bangumiIndex = new Map<string, Map<string, SourceMapping>>();
const vndbIndex = new Map<string, Map<string, SourceMapping>>();

function loadBangumi(): BangumiInventory {
  bangumiInventory ??= Bun.YAML.parse(
    readFileSync(new URL('../../definitions/sources/bangumi.yaml', import.meta.url), 'utf8'),
  ) as BangumiInventory;
  return bangumiInventory;
}

function loadVndb(): VndbInventory {
  vndbInventory ??= Bun.YAML.parse(
    readFileSync(new URL('../../definitions/sources/vndb.yaml', import.meta.url), 'utf8'),
  ) as VndbInventory;
  return vndbInventory;
}

function asMapping(entry: InventoryValue): SourceMapping {
  if (entry.mapping && typeof entry.mapping === 'object' && !Array.isArray(entry.mapping)) {
    const mapping = entry.mapping;
    if (mapping.status === 'existing' || mapping.status === 'proposed' || mapping.status === 'omitted') return mapping;
  }
  const status =
    entry.status === 'omitted' || entry.status === 'existing' || entry.status === 'proposed'
      ? entry.status
      : typeof entry.mapping === 'string'
        ? 'omitted'
        : entry.term
          ? 'existing'
          : 'omitted';
  return {
    status,
    ...(entry.term ? { term: entry.term } : {}),
    ...(entry.inverse ? { inverse: true } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
  };
}

/** par: current id → pid; sub: pid → current id. Dictionary P355 is not emitted. */
export function vndbProducerParentEnds(
  code: string,
  id: string,
  pid: string,
): { holder: string; target: string } | undefined {
  if (code === 'par') return { holder: id, target: pid };
  if (code === 'sub') return { holder: pid, target: id };
  return undefined;
}

/** Exact YAML enumeration lookup; never copies role or relation tables into callers. */
export function mapSourceEnumeration(
  source: 'bangumi' | 'vndb',
  group: string,
  code: string | number,
): SourceMapping | undefined {
  const key = String(code);
  if (source === 'bangumi') {
    let groupMap = bangumiIndex.get(group);
    if (!groupMap) {
      groupMap = new Map();
      const found = loadBangumi().enumerations.find((entry) => entry.id === group);
      for (const value of found?.values ?? []) groupMap.set(String(value.id), asMapping(value));
      bangumiIndex.set(group, groupMap);
    }
    return groupMap.get(key);
  }
  let groupMap = vndbIndex.get(group);
  if (!groupMap) {
    groupMap = new Map();
    for (const value of loadVndb().enumerations[group] ?? [])
      groupMap.set(String(value.value ?? value.id), asMapping(value));
    vndbIndex.set(group, groupMap);
  }
  return groupMap.get(key);
}

/** Read the exact source concept descriptor nested in the pinned staff-position inventory. */
export function bangumiStaffRoleDefinition(
  subjectType: 1 | 2 | 4,
  code: number,
): BangumiStaffRoleDefinition | undefined {
  const group = loadBangumi().enumerations.find((entry) => entry.id === `staff.${subjectType}`);
  const value = group?.values.find((entry) => entry.id === code);
  const mapping = value?.mapping as
    | {
        qualifiers?: {
          role?: {
            value?: {
              concept?: { id?: unknown; scheme?: unknown; label?: unknown };
              source?: unknown;
            };
          };
        };
      }
    | undefined;
  const role = mapping?.qualifiers?.role?.value;
  const concept = role?.concept;
  if (
    typeof concept?.id !== 'string' ||
    typeof concept.scheme !== 'string' ||
    typeof concept.label !== 'string' ||
    typeof role?.source !== 'string'
  )
    return undefined;
  return {
    uri: concept.id,
    schemeUri: concept.scheme,
    label: concept.label,
    sourceUri: role.source,
  };
}

export function isFamilyRelationTerm(term: string | undefined): boolean {
  return term !== undefined && FAMILY_TERMS.has(term);
}

export function liveActionWorkType(platform: unknown): 'schema:Movie' | 'schema:TVSeries' | undefined {
  if (platform === undefined || platform === null) return undefined;
  const value = String(platform).trim();
  if (!value) return undefined;
  if (FILM_PLATFORMS.has(value)) return 'schema:Movie';
  if (TV_PLATFORMS.has(value)) return 'schema:TVSeries';
  return undefined;
}

export type EntityKind =
  | 'bangumi-character'
  | 'bangumi-person'
  | 'bangumi-episode'
  | 'bangumi-music'
  | 'bangumi-live-action'
  | 'vndb-character'
  | 'vndb-staff'
  | 'vndb-release'
  | 'vndb-producer';

export function crossMediaEntityKind(
  sourceKind: 'bangumi' | 'vndb',
  externalId: string,
  record: unknown,
): EntityKind | undefined {
  if (sourceKind === 'bangumi') {
    if (/^character:[1-9][0-9]*$/.test(externalId)) return 'bangumi-character';
    if (/^person:[1-9][0-9]*$/.test(externalId)) return 'bangumi-person';
    if (/^episode:[1-9][0-9]*$/.test(externalId)) return 'bangumi-episode';
    if (/^[1-9][0-9]*$/.test(externalId) && record && typeof record === 'object') {
      const type = Object.getOwnPropertyDescriptor(record, 'type')?.value;
      if (type === 3) return 'bangumi-music';
      if (type === 6) return 'bangumi-live-action';
    }
    return undefined;
  }
  if (/^c[1-9][0-9]*$/.test(externalId)) return 'vndb-character';
  if (/^s[1-9][0-9]*$/.test(externalId)) return 'vndb-staff';
  if (/^r[1-9][0-9]*$/.test(externalId)) return 'vndb-release';
  if (/^p[1-9][0-9]*$/.test(externalId)) return 'vndb-producer';
  return undefined;
}

export function bangumiRecordUrl(externalId: string): string {
  const character = /^character:([1-9][0-9]*)$/.exec(externalId);
  if (character) return `https://bgm.tv/character/${character[1]}`;
  const person = /^person:([1-9][0-9]*)$/.exec(externalId);
  if (person) return `https://bgm.tv/person/${person[1]}`;
  const episode = /^episode:([1-9][0-9]*)$/.exec(externalId);
  if (episode) return `https://bgm.tv/ep/${episode[1]}`;
  return `https://bgm.tv/subject/${externalId}`;
}

export function vndbRecordUrl(externalId: string, revision?: string | null): string {
  return revision ? `https://vndb.org/${externalId}.${revision}` : `https://vndb.org/${externalId}`;
}

type Normalized = Record<string, unknown>;
export type CrossMediaEntityConversion = ConvertedRecord<BatchCommand> & {
  outcome: 'converted' | 'ignored';
  digest: string;
  normalizedRecord: Normalized;
  sourceMetadata?: {
    recordUrl: string;
    summary?: { language: string; takedownEligible: true };
  };
  coverAssets: readonly [];
  mediaImportIntents: readonly [];
};

const fail = (pointer: string, code = 'invalid_record'): never => {
  throw new ConversionError(code, pointer);
};

function object(value: unknown, pointer: string): object {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) fail(pointer);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(pointer);
  return value as object;
}

function own(value: object, key: string, pointer: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) fail(pointer);
  return descriptor.value;
}

function text(value: unknown, pointer: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || (!empty && !value.trim()))
    fail(pointer);
  return value as string;
}

/** COPY integer cells arrive as decimal text from the dump decoder. */
function copyAid(value: unknown, pointer: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) fail(pointer);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) fail(pointer);
  return value as string;
}

function array(value: unknown, pointer: string): unknown[] {
  if (
    value === null ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    fail(pointer);
  return value as unknown[];
}

function nameText(value: unknown, pointer: string): string {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim()) fail(pointer);
  const result = value as string;
  if ([...result].length > vndbCharacterNameLimits.maxCodepoints) fail(pointer, 'invalid_record');
  if (Buffer.byteLength(result, 'utf8') > vndbCharacterNameLimits.stringBytes) fail(pointer, 'invalid_record');
  return result;
}

function latinCell(value: unknown, pointer: string): string | null {
  if (value === null) return null;
  if (value === '') return '';
  return nameText(value, pointer);
}

function spoilerLevel(value: unknown): number | undefined {
  if (value === 0 || value === 1 || value === 2) return value;
  if (value === '0' || value === '1' || value === '2') return Number(value);
  return undefined;
}

function dumpRows(value: unknown, pointer: string, cap: number): unknown[] {
  if (value === undefined) return [];
  if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail(pointer);
  const array = value as unknown[];
  const length = Object.getOwnPropertyDescriptor(array, 'length')!.value as number;
  if (typeof length !== 'number' || length > cap) fail(pointer, 'invalid_record_row_limit');
  const result = [];
  for (let i = 0; i < length; i++) {
    const child = own(array, String(i), `${pointer}/${i}`);
    if (child === undefined) fail(`${pointer}/${i}`);
    result.push(child);
  }
  return result;
}

type CharacterName = { id: string; lang: string; name: string; latin: string | null };
type CharacterAlias = { id: string; spoil: number | string | null; name: string; latin: string | null };
type LanguageText = { language: string; text: string };
type QualifiedCharacterAlias = LanguageText & { spoilerLevel: number };

function projectCharacterNames(
  raw: object,
  expected: string,
): {
  names: CharacterName[];
  aliases: CharacterAlias[];
  nameFacts: LanguageText[];
  alternateNameFacts: LanguageText[];
  qualifiedAlternateNameFacts: QualifiedCharacterAlias[];
  withheld: ConversionDiagnostic[];
} {
  const namesByLanguage = new Map<string, CharacterName>();
  for (const [index, value] of dumpRows(
    own(raw, 'chars_names', '/chars_names'),
    '/chars_names',
    vndbCharacterNameLimits.maxNames,
  ).entries()) {
    const pointer = `/chars_names/${index}`;
    const entry = object(value, pointer);
    const id = text(own(entry, 'id', `${pointer}/id`), `${pointer}/id`, 32);
    if (id !== expected) fail(`${pointer}/id`, 'invalid_identifier');
    const language =
      canonicalLanguageTag(text(own(entry, 'lang', `${pointer}/lang`), `${pointer}/lang`, 64)) ??
      fail(`${pointer}/lang`, 'invalid_language');
    const name = nameText(own(entry, 'name', `${pointer}/name`), `${pointer}/name`);
    const latin = latinCell(own(entry, 'latin', `${pointer}/latin`), `${pointer}/latin`);
    const candidate = { id, lang: language, name, latin };
    const previous = namesByLanguage.get(language);
    if (previous && JSON.stringify(previous) !== JSON.stringify(candidate)) fail(`${pointer}/lang`, 'conflicting_key');
    namesByLanguage.set(language, candidate);
  }
  const names = [...namesByLanguage.values()].sort(
    (left, right) => compareText(left.lang, right.lang) || compareText(left.name, right.name),
  );
  const nameFacts = names.map(({ lang, name }) => ({ language: lang, text: name }));
  const alternateByTuple = new Map<string, LanguageText>();
  const diagnostics: ConversionDiagnostic[] = [];
  for (const [index, row] of names.entries()) {
    const latin = row.latin;
    if (latin === null || latin === '') continue;
    const language = latinLanguageTag(row.lang);
    if (language === null) {
      diagnostics.push({ pointer: `/chars_names/${index}/latin`, code: 'unadmitted_latin_language' });
      continue;
    }
    const alternate = { language, text: latin };
    alternateByTuple.set(JSON.stringify([alternate.language, alternate.text]), alternate);
  }
  const aliasesByTuple = new Map<string, CharacterAlias>();
  const qualifiedByTuple = new Map<string, QualifiedCharacterAlias>();
  const withheld: ConversionDiagnostic[] = [];
  for (const [index, value] of dumpRows(
    own(raw, 'chars_alias', '/chars_alias'),
    '/chars_alias',
    vndbCharacterNameLimits.maxAliases,
  ).entries()) {
    const pointer = `/chars_alias/${index}`;
    const entry = object(value, pointer);
    const id = text(own(entry, 'id', `${pointer}/id`), `${pointer}/id`, 32);
    if (id !== expected) fail(`${pointer}/id`, 'invalid_identifier');
    const name = nameText(own(entry, 'name', `${pointer}/name`), `${pointer}/name`);
    const latin = latinCell(own(entry, 'latin', `${pointer}/latin`), `${pointer}/latin`);
    const rawSpoil = own(entry, 'spoil', `${pointer}/spoil`);
    const spoil = spoilerLevel(rawSpoil);
    const normalizedSpoil: CharacterAlias['spoil'] =
      spoil !== undefined
        ? spoil
        : rawSpoil === null ||
            typeof rawSpoil === 'string' ||
            (typeof rawSpoil === 'number' && Number.isSafeInteger(rawSpoil))
          ? rawSpoil
          : 'unrepresentable';
    const alias = { id, spoil: normalizedSpoil, name, latin };
    aliasesByTuple.set(JSON.stringify([normalizedSpoil, name, latin]), alias);
    if (spoil === undefined) {
      withheld.push({ pointer: `${pointer}/spoil`, code: 'unrepresentable_qualifier' });
      continue;
    }
    for (const [language, text] of [['und', name], ...(latin && latin !== '' ? [['und-Latn', latin]] : [])] as [
      string,
      string,
    ][]) {
      const tuple = { language, text, spoilerLevel: spoil };
      qualifiedByTuple.set(JSON.stringify([language, text, spoil]), tuple);
    }
  }
  const aliases = [...aliasesByTuple.values()].sort(
    (left, right) =>
      compareText(String(left.spoil), String(right.spoil)) ||
      compareText(left.name, right.name) ||
      compareText(left.latin ?? '', right.latin ?? ''),
  );
  const alternateNameFacts = [...alternateByTuple.values()].sort(
    (left, right) => compareText(left.language, right.language) || compareText(left.text, right.text),
  );
  const qualifiedAlternateNameFacts = [...qualifiedByTuple.values()].sort(
    (left, right) =>
      left.spoilerLevel - right.spoilerLevel ||
      compareText(left.language, right.language) ||
      compareText(left.text, right.text),
  );
  return {
    names,
    aliases,
    nameFacts,
    alternateNameFacts,
    qualifiedAlternateNameFacts,
    withheld: [...diagnostics, ...withheld].sort((left, right) => compareText(left.pointer, right.pointer)),
  };
}

function nativeNumber(value: unknown, pointer: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(pointer, 'invalid_identifier');
  return value as number;
}

function grouped(value: unknown, pointer: string, cap: number, optional = false): unknown[] {
  if (value === undefined && optional) return [];
  if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail(pointer, 'Expected grouped dump rows');
  const array = value as unknown[];
  const length = Object.getOwnPropertyDescriptor(array, 'length')!.value as number;
  if (length > cap) fail(pointer, 'Dump row count exceeds source cap');
  const result = [];
  for (let i = 0; i < length; i++) {
    const child = own(array as object, String(i), `${pointer}/${i}`);
    if (child === undefined) fail(pointer, 'Sparse dump rows are unsupported');
    result.push(child);
  }
  return result;
}

function positiveInteger(value: unknown, pointer: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    fail(pointer, 'Expected a positive dump integer');
  return value as number;
}

function website(value: string, pointer: string): string {
  try {
    return sourceWebsiteUrl(value);
  } catch {
    return fail(pointer, 'Invalid external website URL');
  }
}

function entityLinkTable(kind: EntityKind): 'staff_extlinks' | 'producers_extlinks' | 'releases_extlinks' | undefined {
  if (kind === 'vndb-staff') return 'staff_extlinks';
  if (kind === 'vndb-producer') return 'producers_extlinks';
  if (kind === 'vndb-release') return 'releases_extlinks';
  return undefined;
}

function episodeOrdinal(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rendered = String(value);
    return episodeOrdinalPattern.test(rendered) ? rendered : undefined;
  }
  if (typeof value === 'string' && episodeOrdinalPattern.test(value)) return value;
  return undefined;
}

function gregorianDay(year: number, month: number, day: number): boolean {
  const february = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  const days = [31, february, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

/** Gregorian year/month/day only. Unparseable source text is withheld, never coerced. */
export function episodeAirdate(
  value: unknown,
): { time: string; precision: 9 | 10 | 11; calendarmodel: typeof gregorianCalendar } | undefined {
  if (typeof value !== 'string' || !value.trim()) return;
  const iso = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u.exec(value.trim());
  if (!iso || iso[0] !== value.trim()) return;
  const year = iso[1]!;
  const month = iso[2];
  const day = iso[3];
  if (month !== undefined && (Number(month) < 1 || Number(month) > 12)) return;
  if (day !== undefined && !gregorianDay(Number(year), Number(month!), Number(day))) return;
  return {
    time: `+${year}-${month ?? '00'}-${day ?? '00'}T00:00:00Z`,
    precision: day ? 11 : month ? 10 : 9,
    calendarmodel: gregorianCalendar,
  };
}

/** Explicit second/minute/hour or ISO-8601 playback length. Unitless and clock-style values stay unknown. */
export function episodeDuration(
  value: unknown,
): { amount: string; unit: typeof durationSecond } | 'unknown' | undefined {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' && !value.trim()) return;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return 'unknown';
    return 'unknown';
  }
  if (typeof value !== 'string' || !value.isWellFormed()) return 'unknown';
  const text = value.trim();
  const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/iu.exec(text);
  if (iso && iso[0] === text && (iso[1] || iso[2] || iso[3])) {
    const seconds = Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0);
    return { amount: `+${seconds}`, unit: durationSecond };
  }
  const named = /^(\d+)\s*(h|hours?|m|min|minutes?|s|sec|seconds?)$/iu.exec(text);
  if (named) {
    const count = Number(named[1]);
    const unit = named[2]!.toLowerCase();
    const seconds = unit.startsWith('h') ? count * 3600 : unit.startsWith('m') ? count * 60 : count;
    return { amount: `+${seconds}`, unit: durationSecond };
  }
  return 'unknown';
}

/** COPY smallint cells only. Height unknown is `0`; weight unknown is null; exact `0` is never measured. */
export function vndbCharacterQuantity(
  value: unknown,
  property: 'schema:height' | 'schema:weight',
  release: Pick<Release, 'types' | 'properties'> = bundledRelease,
): { amount: string; unit: string } | 'unknown' | 'invalid' | 'unadmitted' {
  if (value === undefined || value === null) return 'unknown';
  if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > 5) return 'invalid';
  if (!copySmallint.test(value) || (value.length === 5 && value > smallintMax)) return 'invalid';
  if (value === '0') return 'unknown';
  const unit = property === 'schema:height' ? centimeter : kilogram;
  const definition = release.properties[property];
  const holder = release.types['wd:Q95074'];
  if (
    definition?.datatype !== 'quantity' ||
    !holder?.properties.includes(property) ||
    !definition.units?.includes(unit)
  )
    return 'unadmitted';
  if (definition.minimum !== undefined && Number(value) < definition.minimum) return 'invalid';
  if (definition.maximum !== undefined && Number(value) > definition.maximum) return 'invalid';
  return { amount: `+${value}`, unit };
}

const profiles: Record<EntityKind, { type: string; identifier: string; sourceKind: 'bangumi' | 'vndb' }> = {
  'bangumi-character': { type: 'wd:Q95074', identifier: 'wdt:P6296', sourceKind: 'bangumi' },
  'bangumi-person': { type: 'schema:Person', identifier: 'wdt:P6298', sourceKind: 'bangumi' },
  'bangumi-episode': { type: 'schema:Episode', identifier: 'schema:url', sourceKind: 'bangumi' },
  'bangumi-music': { type: 'schema:MusicAlbum', identifier: 'wdt:P5732', sourceKind: 'bangumi' },
  'bangumi-live-action': { type: 'schema:TVSeries', identifier: 'wdt:P5732', sourceKind: 'bangumi' },
  'vndb-character': { type: 'wd:Q95074', identifier: 'wdt:P3180', sourceKind: 'vndb' },
  'vndb-staff': { type: 'schema:Person', identifier: 'wdt:P3180', sourceKind: 'vndb' },
  'vndb-release': { type: 'wd:Q20631656', identifier: 'wdt:P3180', sourceKind: 'vndb' },
  'vndb-producer': { type: 'schema:Organization', identifier: 'wdt:P3180', sourceKind: 'vndb' },
};

function personType(record: object): string {
  const type = own(record, 'type', '/type');
  const mapping = mapSourceEnumeration('bangumi', 'person.type', type as number);
  if (mapping?.status === 'omitted') fail('/type', 'unsupported_type');
  return mapping?.term === 'schema:Organization' ? 'schema:Organization' : 'schema:Person';
}

function producerType(record: object): string {
  const type = own(record, 'type', '/type');
  if (type === undefined) return 'schema:Organization';
  const mapping = mapSourceEnumeration('vndb', 'producer_type', String(type));
  return mapping?.term === 'schema:Person' ? 'schema:Person' : 'schema:Organization';
}

type Projected = {
  normalized: Normalized;
  type: string;
  labels: Record<string, string>;
  aliases?: Record<string, string[]>;
  names?: { language: string; text: string }[];
  alternateNames?: { language: string; text: string }[];
  qualifiedAlternateNames?: QualifiedCharacterAlias[];
  identifier: string;
  nameFacts?: { language: string; text: string }[];
  maxCommands?: number;
  minimumAge?: { amount: string; unit: 'http://www.wikidata.org/entity/Q577' };
  characterMeasurements?: BangumiCharacterMeasurementProjection;
  ignored?: ConversionDiagnostic;
  diagnostics?: ConversionDiagnostic[];
};

function releasedCharacterQuantity(
  property: 'schema:height' | 'schema:weight',
  quantity: { amount: string; unit: string },
): boolean {
  const character = bundledRelease.types['wd:Q95074'];
  const definition = bundledRelease.properties[property];
  const amountPattern = (definition?.value as { properties?: { amount?: { pattern?: unknown } } } | undefined)
    ?.properties?.amount?.pattern;
  return (
    character?.properties.includes(property) === true &&
    definition?.datatype === 'quantity' &&
    definition.units?.includes(quantity.unit) === true &&
    typeof amountPattern === 'string' &&
    new RegExp(amountPattern, 'u').test(quantity.amount)
  );
}

function projectStaffNames(
  raw: object,
  expected: string,
): {
  labels: Record<string, string>;
  nameFacts?: { language: string; text: string }[];
  normalized: Normalized;
  diagnostics: ConversionDiagnostic[];
} {
  const aliasesValue = own(raw, 'aliases', '/aliases');
  const mainValue = own(raw, 'main', '/main');
  const diagnostics: ConversionDiagnostic[] = [];
  if (aliasesValue === undefined) {
    const name = own(raw, 'name', '/name');
    const label = name !== undefined ? text(name, '/name', 500) : expected;
    return {
      labels: { und: label },
      ...(name !== undefined ? { nameFacts: [{ language: 'und', text: label }] } : {}),
      normalized: { id: expected, name: label },
      diagnostics,
    };
  }
  const rows = array(aliasesValue, '/aliases');
  const length = Object.getOwnPropertyDescriptor(rows, 'length')!.value as number;
  if (length > vndbStaffNameLimits.maxAliases) fail('/aliases', 'invalid_record_alias_limit');
  const seen = new Map<string, string>();
  const aliases: { id: string; aid: string; name: string }[] = [];
  for (let index = 0; index < length; index++) {
    const pointer = `/aliases/${index}`;
    const item = own(rows, String(index), pointer);
    if (item === undefined) fail(pointer, 'invalid_record');
    const row = object(item, pointer);
    const owner = own(row, 'id', `${pointer}/id`);
    if (owner !== expected) fail(`${pointer}/id`, 'invalid_identifier');
    const aid = copyAid(own(row, 'aid', `${pointer}/aid`), `${pointer}/aid`);
    const aliasName = own(row, 'name', `${pointer}/name`);
    if (
      typeof aliasName !== 'string' ||
      !aliasName.isWellFormed() ||
      !aliasName.trim() ||
      [...aliasName].length > vndbStaffNameLimits.maxNameChars
    )
      fail(`${pointer}/name`);
    const admittedName = aliasName as string;
    if (seen.has(aid)) fail(`${pointer}/aid`, 'duplicate_alias_key');
    seen.set(aid, admittedName);
    aliases.push({ id: expected, aid, name: admittedName });
  }
  aliases.sort((left, right) => Number(left.aid) - Number(right.aid) || compareText(left.name, right.name));
  let preferred: string | undefined;
  let main: string | null = null;
  if (mainValue !== undefined && mainValue !== null && mainValue !== '0') {
    main = copyAid(mainValue, '/main');
    preferred = aliases.find((alias) => alias.aid === main)?.name;
    if (preferred === undefined) diagnostics.push({ pointer: '/main', code: 'missing_preferred_alias' });
  } else {
    main = mainValue === '0' ? '0' : null;
    diagnostics.push({ pointer: '/main', code: 'missing_preferred_alias' });
  }
  const additional = [...new Set(aliases.map((alias) => alias.name))]
    .filter((name) => name !== preferred)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const ordered = preferred === undefined ? additional : [preferred, ...additional];
  return {
    labels: { und: preferred ?? expected },
    nameFacts: ordered.map((value) => ({ language: 'und', text: value })),
    normalized: { id: expected, name: preferred ?? expected, main, aliases },
    diagnostics,
  };
}

function copyFlag(value: unknown, pointer: string): boolean {
  if (value === true || value === 't') return true;
  if (value === false || value === 'f') return false;
  return fail(pointer);
}

function releaseTitleText(value: unknown, pointer: string): string {
  if (typeof value !== 'string') return fail(pointer);
  if (
    !value.isWellFormed() ||
    !value.trim() ||
    [...value].length > vndbReleaseNameLimits.titleChars ||
    Buffer.byteLength(value, 'utf8') > vndbReleaseNameLimits.stringBytes
  )
    return fail(pointer);
  return value;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Raw `releases.olang` stays in the digest; canonical emission happens later. */
function attachReleaseLanguage(raw: object, normalized: Normalized, diagnostics: ConversionDiagnostic[]): void {
  const value = own(raw, 'olang', '/olang');
  if (value === undefined) return;
  if (value === null) {
    normalized.olang = null;
    return;
  }
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    Buffer.byteLength(value, 'utf8') > vndbReleaseNameLimits.stringBytes
  ) {
    diagnostics.push({ pointer: '/olang', code: 'unadmitted_language' });
    return;
  }
  normalized.olang = value;
}

function proposeReleaseLanguage(
  raw: unknown,
  fact: (property: string, content: unknown) => BatchStatement,
): {
  statement?: BatchStatement;
  diagnostic?: ConversionDiagnostic;
} {
  if (typeof raw !== 'string') return {};
  const mapping = mapSourceEnumeration('vndb', 'language', raw);
  const language = mapping?.term === 'schema:inLanguage' ? inLanguageTag(raw) : null;
  if (language) return { statement: fact('schema:inLanguage', language) };
  return { diagnostic: { pointer: '/olang', code: 'unadmitted_language' } };
}

function projectReleaseTitles(
  raw: object,
  releaseId: string,
): {
  titles: {
    id: string;
    lang: string;
    mtl: boolean;
    title: string;
    latin: string | null;
  }[];
  names: { language: string; text: string }[];
  alternateNames: { language: string; text: string }[];
  labels: Record<string, string>;
  aliases: Record<string, string[]>;
  diagnostics: ConversionDiagnostic[];
} {
  const value = own(raw, 'releases_titles', '/releases_titles');
  if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail('/releases_titles');
  const rows = value as object;
  const length = Object.getOwnPropertyDescriptor(rows, 'length')!.value as number;
  if (length > vndbReleaseNameLimits.maxTitles) fail('/releases_titles', 'invalid_record_row_limit');
  const titles: {
    id: string;
    lang: string;
    mtl: boolean;
    title: string;
    latin: string | null;
  }[] = [];
  const diagnostics: ConversionDiagnostic[] = [];
  const names: { language: string; text: string }[] = [];
  const alternateNames: { language: string; text: string }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < length; i++) {
    const pointer = `/releases_titles/${i}`;
    const entry = own(rows, String(i), pointer);
    if (entry === undefined) return fail(pointer);
    const row = object(entry, pointer);
    const id = own(row, 'id', `${pointer}/id`);
    if (typeof id !== 'string' || id !== releaseId) return fail(`${pointer}/id`, 'invalid_identifier');
    const rawLanguage = own(row, 'lang', `${pointer}/lang`);
    if (typeof rawLanguage !== 'string') return fail(`${pointer}/lang`);
    const lang = canonicalLanguageTag(rawLanguage);
    const title = releaseTitleText(own(row, 'title', `${pointer}/title`), `${pointer}/title`);
    const mtl = copyFlag(own(row, 'mtl', `${pointer}/mtl`), `${pointer}/mtl`);
    const latin = own(row, 'latin', `${pointer}/latin`);
    const association = JSON.stringify([lang ?? rawLanguage, title, latin]);
    if (seen.has(association)) fail(pointer, 'duplicate_association');
    seen.add(association);
    let admittedLatin: string | null;
    let romanizedText: string | undefined;
    if (latin === null) admittedLatin = null;
    else if (typeof latin !== 'string') return fail(`${pointer}/latin`);
    else if (latin === '') {
      admittedLatin = '';
      diagnostics.push({ pointer: `${pointer}/latin`, code: 'unadmitted_empty_latin' });
    } else if (!latin.isWellFormed() || !latin.trim()) {
      admittedLatin = latin;
      diagnostics.push({ pointer: `${pointer}/latin`, code: 'unadmitted_latin' });
    } else {
      try {
        admittedLatin = releaseTitleText(latin, `${pointer}/latin`);
        romanizedText = admittedLatin;
      } catch {
        admittedLatin = latin;
        diagnostics.push({ pointer: `${pointer}/latin`, code: 'unadmitted_latin' });
      }
    }
    titles.push({ id: releaseId, lang: lang ?? rawLanguage, mtl, title, latin: admittedLatin });
    if (lang === null) {
      diagnostics.push({ pointer: `${pointer}/lang`, code: 'unadmitted_language' });
      continue;
    }
    names.push({ language: lang, text: title });
    if (romanizedText) {
      const romanized = latinLanguageTag(lang);
      if (romanized === null) diagnostics.push({ pointer: `${pointer}/latin`, code: 'unadmitted_latin_language' });
      else alternateNames.push({ language: romanized, text: romanizedText });
    }
  }
  if (names.length > vndbReleaseNameLimits.maxNames) fail('/releases_titles', 'invalid_record_name_limit');
  if (alternateNames.length > vndbReleaseNameLimits.maxAlternateNames)
    fail('/releases_titles', 'invalid_record_alias_limit');
  names.sort((a, b) => compareText(a.language, b.language) || compareText(a.text, b.text));
  alternateNames.sort((a, b) => compareText(a.language, b.language) || compareText(a.text, b.text));
  const uniqueNames = new Map<string, { language: string; text: string }>();
  for (const name of names) uniqueNames.set(JSON.stringify([name.language, name.text]), name);
  const labels: Record<string, string> = Object.create(null);
  const aliases: Record<string, string[]> = Object.create(null);
  for (const name of uniqueNames.values()) {
    if (labels[name.language] === undefined) labels[name.language] = name.text;
    else if (labels[name.language] !== name.text) (aliases[name.language] ??= []).push(name.text);
  }
  for (const name of alternateNames) {
    if (labels[name.language] === name.text) continue;
    const listed = aliases[name.language] ?? [];
    if (!listed.includes(name.text)) (aliases[name.language] ??= []).push(name.text);
  }
  if (!Object.keys(labels).length) fail('/releases_titles', 'invalid_record_title');
  titles.sort(
    (a, b) =>
      compareText(a.lang, b.lang) ||
      compareText(a.title, b.title) ||
      compareText(a.latin ?? '', b.latin ?? '') ||
      Number(a.mtl) - Number(b.mtl),
  );
  return { titles, names: [...uniqueNames.values()], alternateNames, labels, aliases, diagnostics };
}

function projectEntityLinks(kind: EntityKind, raw: object, owner: string, normalized: Normalized): void {
  const joinTable = entityLinkTable(kind);
  if (!joinTable) return;
  const joins = grouped(own(raw, joinTable, `/${joinTable}`), `/${joinTable}`, vndbLimits.maxLinks, true).map(
    (value, i) => {
      const p = `/${joinTable}/${i}`;
      const entry = object(value, p);
      const id = text(own(entry, 'id', `${p}/id`), `${p}/id`, 32);
      if (id !== owner) fail(`${p}/id`, 'External link child ID does not match entity id');
      return { id, link: positiveInteger(own(entry, 'link', `${p}/link`), `${p}/link`) };
    },
  );
  const external = grouped(own(raw, 'extlinks', '/extlinks'), '/extlinks', vndbLimits.maxLinks, true).map(
    (value, i) => {
      const p = `/extlinks/${i}`;
      const entry = object(value, p);
      const key = positiveInteger(own(entry, 'id', `${p}/id`), `${p}/id`);
      const site = text(own(entry, 'site', `${p}/site`), `${p}/site`, 32);
      const valueText = text(own(entry, 'value', `${p}/value`), `${p}/value`, 4096);
      return { id: key, site, value: site === 'website' ? website(valueText, `${p}/value`) : valueText };
    },
  );
  const byId = new Set(external.map((entry) => entry.id));
  const used = new Set(joins.map((entry) => entry.link));
  if (
    byId.size !== external.length ||
    used.size !== joins.length ||
    used.size !== byId.size ||
    joins.some((link) => !byId.has(link.link))
  )
    fail(`/${joinTable}`, 'External link group has mismatched or duplicate IDs');
  normalized[joinTable] = joins;
  normalized.extlinks = external;
}

function attachReleaseGtin(raw: object, normalized: Normalized): void {
  const gtin = own(raw, 'gtin', '/gtin');
  if (gtin !== undefined) normalized.gtin = retainVndbReleaseGtin(gtin);
}

function projectReleaseAssociations(
  raw: object,
  releaseId: string,
  property: 'releases_platforms' | 'releases_media',
  field: 'platform' | 'medium',
): { id: string; platform?: string; medium?: string }[] | undefined {
  const pointer = `/${property}`;
  const value = own(raw, property, pointer);
  if (value === undefined) return;
  if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail(pointer);
  const rows = value as object;
  const length = Object.getOwnPropertyDescriptor(rows, 'length')!.value as number;
  if (length > vndbReleaseNameLimits.maxClassificationAssociations) fail(pointer, 'invalid_record_row_limit');
  const byCode = new Map<string, { id: string; platform?: string; medium?: string }>();
  for (let index = 0; index < length; index += 1) {
    const rowPointer = `${pointer}/${index}`;
    const row = object(own(rows, String(index), rowPointer), rowPointer);
    const id = own(row, 'id', `${rowPointer}/id`);
    if (id !== releaseId) fail(`${rowPointer}/id`, 'invalid_identifier');
    const code = text(own(row, field, `${rowPointer}/${field}`), `${rowPointer}/${field}`, 64);
    if (!/^[a-z][a-z0-9]{0,15}$/u.test(code)) fail(`${rowPointer}/${field}`, 'invalid_source_value');
    byCode.set(code, field === 'platform' ? { id: releaseId, platform: code } : { id: releaseId, medium: code });
  }
  return [...byCode.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, association]) => association);
}

function project(kind: EntityKind, input: ConversionInput): Projected {
  const raw = object(input.record, '');
  const idField = kind.startsWith('vndb')
    ? 'id'
    : kind.startsWith('bangumi') && !kind.includes('music') && !kind.includes('live')
      ? 'id'
      : 'id';
  const nativeId = own(raw, idField, '/id');
  const expected =
    kind === 'bangumi-character'
      ? input.external_id.slice('character:'.length)
      : kind === 'bangumi-person'
        ? input.external_id.slice('person:'.length)
        : kind === 'bangumi-episode'
          ? input.external_id.slice('episode:'.length)
          : input.external_id;
  if (kind.startsWith('bangumi')) {
    const id = nativeNumber(nativeId, '/id');
    if (String(id) !== expected) fail('/id', 'invalid_identifier');
  } else if (typeof nativeId !== 'string' || nativeId !== expected) fail('/id', 'invalid_identifier');
  const profile = profiles[kind];
  let type = profile.type;
  if (kind === 'vndb-release' && own(raw, 'releases_titles', '/releases_titles') !== undefined) {
    const projectedTitles = projectReleaseTitles(raw, expected);
    const normalized: Normalized = { id: nativeId, releases_titles: projectedTitles.titles };
    const released = own(raw, 'released', '/released');
    if (released !== undefined) normalized.released = released;
    projectEntityLinks(kind, raw, expected, normalized);
    attachReleaseLanguage(raw, normalized, projectedTitles.diagnostics);
    attachReleaseGtin(raw, normalized);
    const hasMinimumAge = Object.hasOwn(raw, 'minage');
    const rawMinimumAge = hasMinimumAge ? own(raw, 'minage', '/minage') : undefined;
    const minimumAge = projectVndbReleaseMinimumAge(rawMinimumAge, hasMinimumAge);
    if (rawMinimumAge === null || minimumAge.sourceValue !== undefined) normalized.minage = minimumAge.sourceValue;
    const platforms = projectReleaseAssociations(raw, expected, 'releases_platforms', 'platform');
    const media = projectReleaseAssociations(raw, expected, 'releases_media', 'medium');
    if (platforms !== undefined) normalized.releases_platforms = platforms;
    if (media !== undefined) normalized.releases_media = media;
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > vndbReleaseNameLimits.recordBytes)
      fail('', 'invalid_record_byte_limit');
    const aliases = Object.keys(projectedTitles.aliases).length ? projectedTitles.aliases : undefined;
    return {
      normalized,
      type,
      labels: projectedTitles.labels,
      ...(aliases ? { aliases } : {}),
      names: projectedTitles.names,
      alternateNames: projectedTitles.alternateNames,
      identifier: expected,
      maxCommands: vndbReleaseNameLimits.maxCommands,
      ...(minimumAge.quantity ? { minimumAge: minimumAge.quantity } : {}),
      diagnostics: [
        ...projectedTitles.diagnostics,
        ...(minimumAge.diagnostic ? [{ pointer: '/minage', code: minimumAge.diagnostic }] : []),
      ],
    };
  }
  if (kind === 'vndb-staff') {
    const names = projectStaffNames(raw, expected);
    if (own(raw, 'staff_extlinks', '/staff_extlinks') !== undefined || own(raw, 'extlinks', '/extlinks') !== undefined)
      projectEntityLinks(kind, raw, expected, names.normalized);
    if (Buffer.byteLength(JSON.stringify(names.normalized), 'utf8') > vndbStaffNameLimits.recordBytes)
      fail('', 'invalid_record_byte_limit');
    return {
      normalized: names.normalized,
      type: profile.type,
      labels: names.labels,
      identifier: expected,
      ...(names.nameFacts ? { nameFacts: names.nameFacts } : {}),
      maxCommands: vndbStaffNameLimits.maxCommands,
      diagnostics: names.diagnostics,
    };
  }

  if (
    kind === 'vndb-character' &&
    (own(raw, 'chars_names', '/chars_names') !== undefined || own(raw, 'chars_alias', '/chars_alias') !== undefined)
  ) {
    const characterNames = projectCharacterNames(raw, expected);
    const rawName = own(raw, 'name', '/name');
    const scalarName = rawName === undefined ? undefined : text(rawName, '/name', 500);
    const names = [...characterNames.nameFacts];
    if (scalarName !== undefined) names.push({ language: 'und', text: scalarName });
    if (names.length === 0) names.push({ language: 'und', text: expected });
    names.sort((left, right) => compareText(left.language, right.language) || compareText(left.text, right.text));
    const uniqueNames = new Map<string, LanguageText>();
    for (const name of names) uniqueNames.set(JSON.stringify([name.language, name.text]), name);
    const nameFacts = [...uniqueNames.values()];
    const bootstrapNames = [...nameFacts, ...characterNames.alternateNameFacts].sort(
      (left, right) => compareText(left.language, right.language) || compareText(left.text, right.text),
    );
    const labels: Record<string, string> = Object.create(null);
    const aliases: Record<string, string[]> = Object.create(null);
    for (const name of bootstrapNames) {
      if (labels[name.language] === undefined) labels[name.language] = name.text;
      else if (labels[name.language] !== name.text) (aliases[name.language] ??= []).push(name.text);
    }
    const normalized: Normalized = {
      id: nativeId,
      name: scalarName ?? expected,
      chars_names: characterNames.names,
      chars_alias: characterNames.aliases,
    };
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > vndbCharacterNameLimits.recordBytes)
      fail('', 'invalid_record_byte_limit');
    return {
      normalized,
      type,
      labels,
      ...(Object.keys(aliases).length ? { aliases } : {}),
      names: nameFacts,
      alternateNames: characterNames.alternateNameFacts,
      qualifiedAlternateNames: characterNames.qualifiedAlternateNameFacts,
      identifier: expected,
      maxCommands: vndbCharacterNameLimits.maxCommands,
      diagnostics: characterNames.withheld,
    };
  }
  if (kind === 'bangumi-character') {
    const nameInput = bangumiCharacterNameScalar(own(raw, 'name', '/name'));
    const chineseInput = bangumiCharacterNameScalar(own(raw, 'name_cn', '/name_cn'));
    const infoboxNames = parseBangumiCharacterInfoboxNames(own(raw, 'infobox', '/infobox'));
    const nameFacts: { language: string; text: string }[] = [];
    const alternateNames = [...infoboxNames.alternateNames];
    const labels: Record<string, string> = Object.create(null);
    const aliases: Record<string, string[]> = Object.create(null);
    const diagnostics: ConversionDiagnostic[] = [];

    if (nameInput.status === 'admitted') nameFacts.push({ language: 'und', text: nameInput.text });
    else if (nameInput.status === 'invalid') diagnostics.push({ pointer: '/name', code: 'invalid_source_name' });
    if (chineseInput.status === 'admitted') nameFacts.push({ language: 'zh', text: chineseInput.text });
    else if (chineseInput.status === 'invalid')
      diagnostics.push({ pointer: '/name_cn', code: 'invalid_source_name' });
    nameFacts.push(...infoboxNames.names);
    diagnostics.push(...infoboxNames.diagnostics);

    for (const nameFact of nameFacts) {
      if (labels[nameFact.language] === undefined) labels[nameFact.language] = nameFact.text;
      else if (labels[nameFact.language] !== nameFact.text)
        (aliases[nameFact.language] ??= []).push(nameFact.text);
    }
    for (const alias of alternateNames) {
      if (labels[alias.language] === alias.text) continue;
      if (!(aliases[alias.language] ??= []).includes(alias.text)) aliases[alias.language]!.push(alias.text);
    }

    const normalized: Normalized = {
      id: nativeId,
      ...(nameInput.status === 'admitted' ? { name: nameInput.text } : {}),
      ...(chineseInput.status === 'admitted' ? { name_cn: chineseInput.text } : {}),
      ...(nameInput.status === 'invalid' ? { name_source: nameInput } : {}),
      ...(chineseInput.status === 'invalid' ? { name_cn_source: chineseInput } : {}),
      infobox_source: infoboxNames.source,
    };
    const characterKind = own(raw, 'type', '/type');
    if (characterKind !== undefined) normalized.type = characterKind;
    const summary = own(raw, 'summary', '/summary');
    if (summary !== undefined) normalized.summary = text(summary, '/summary', 32_768, true);
    projectEntityLinks(kind, raw, expected, normalized);
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 65_536) fail('', 'invalid_record_byte_limit');
    return {
      normalized,
      type,
      labels,
      ...(Object.keys(aliases).length ? { aliases } : {}),
      names: nameFacts,
      alternateNames,
      identifier: expected,
      maxCommands: bangumiCharacterNameCommandLimit,
      ...(diagnostics.length ? { diagnostics: diagnostics.slice(0, bangumiCharacterNameLimits.maxDiagnostics) } : {}),
    };
  }
  const name = own(raw, 'name', '/name');
  const title = own(raw, 'title', '/title');
  const label =
    name !== undefined ? text(name, '/name', 500) : title !== undefined ? text(title, '/title', 500) : expected;
  const chinese = own(raw, 'name_cn', '/name_cn');
  const labels: Record<string, string> = { und: label };
  if (typeof chinese === 'string' && chinese.trim()) labels.zh = text(chinese, '/name_cn', 500, true);
  const normalized: Normalized = { id: nativeId, name: label };
  let minimumAge: Projected['minimumAge'];
  const diagnostics: ConversionDiagnostic[] = [];
  let characterMeasurements: BangumiCharacterMeasurementProjection | undefined;
  if (chinese !== undefined) normalized.name_cn = labels.zh ?? '';
  if (kind === 'bangumi-character') {
    const characterKind = own(raw, 'type', '/type');
    if (characterKind !== undefined) normalized.type = characterKind;
    const summary = own(raw, 'summary', '/summary');
    if (summary !== undefined) normalized.summary = text(summary, '/summary', 32_768, true);
    characterMeasurements = projectBangumiCharacterMeasurements(own(raw, 'infobox', '/infobox'));
    if (characterMeasurements.evidence.length)
      normalized.characterPhysicalProfile = { fields: characterMeasurements.evidence };
    diagnostics.push(...characterMeasurements.diagnostics);
  }
  if (kind === 'bangumi-person') {
    type = personType(raw);
    normalized.type = own(raw, 'type', '/type');
    const summary = own(raw, 'summary', '/summary');
    if (summary !== undefined) normalized.summary = text(summary, '/summary', 32_768, true);
  }
  if (kind === 'vndb-producer') {
    type = producerType(raw);
    if (own(raw, 'type', '/type') !== undefined) normalized.type = own(raw, 'type', '/type');
  }
  if (kind === 'bangumi-music') {
    const subjectType = own(raw, 'type', '/type');
    if (subjectType !== 3) fail('/type', 'unsupported_type');
    normalized.type = 3;
  }
  if (kind === 'bangumi-live-action') {
    const subjectType = own(raw, 'type', '/type');
    if (subjectType !== 6) fail('/type', 'unsupported_type');
    normalized.type = 6;
    const platform = own(raw, 'platform', '/platform');
    if (platform !== undefined) normalized.platform = platform;
    const live = liveActionWorkType(platform);
    if (!live)
      return {
        normalized,
        type,
        labels,
        identifier: expected,
        ignored: { pointer: '/platform', code: 'unsupported_live_action_platform' },
      };
    type = live;
  }
  if (kind === 'vndb-release') {
    const released = own(raw, 'released', '/released');
    if (released !== undefined) normalized.released = released;
    attachReleaseLanguage(raw, normalized, diagnostics);
    attachReleaseGtin(raw, normalized);
    const hasMinimumAge = Object.hasOwn(raw, 'minage');
    const rawMinimumAge = hasMinimumAge ? own(raw, 'minage', '/minage') : undefined;
    const projection = projectVndbReleaseMinimumAge(rawMinimumAge, hasMinimumAge);
    if (rawMinimumAge === null || projection.sourceValue !== undefined) normalized.minage = projection.sourceValue;
    minimumAge = projection.quantity;
    if (projection.diagnostic) diagnostics.push({ pointer: '/minage', code: projection.diagnostic });
    const platforms = projectReleaseAssociations(raw, expected, 'releases_platforms', 'platform');
    const media = projectReleaseAssociations(raw, expected, 'releases_media', 'medium');
    if (platforms !== undefined) normalized.releases_platforms = platforms;
    if (media !== undefined) normalized.releases_media = media;
  }
  if (kind === 'vndb-character') {
    for (const field of ['height', 'weight'] as const) {
      const value = own(raw, field, `/${field}`);
      if (value !== undefined) normalized[field] = value;
    }
  }
  if (kind === 'bangumi-episode') {
    const sort = own(raw, 'sort', '/sort');
    if (sort !== undefined) normalized.sort = sort;
    const subjectId = own(raw, 'subject_id', '/subject_id');
    if (subjectId !== undefined) normalized.subject_id = subjectId;
    const episodeType = own(raw, 'type', '/type');
    if (episodeType !== undefined) normalized.type = episodeType;
    const airdate = own(raw, 'airdate', '/airdate');
    if (airdate !== undefined) normalized.airdate = airdate;
    const duration = own(raw, 'duration', '/duration');
    if (duration !== undefined) normalized.duration = duration;
    const description = own(raw, 'description', '/description');
    if (description !== undefined) normalized.description = description;
  }
  projectEntityLinks(kind, raw, expected, normalized);
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 65_536) fail('', 'invalid_record_byte_limit');
  return {
    normalized,
    type,
    labels,
    identifier: expected,
    ...(minimumAge ? { minimumAge } : {}),
    ...(characterMeasurements ? { characterMeasurements } : {}),
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}

export function convertCrossMediaEntity(
  input: ConversionInput,
  context: ConversionContext = {},
  options: { readonly converterRevision?: string; readonly sourceKind?: 'bangumi' | 'vndb' } = {},
): CrossMediaEntityConversion {
  try {
    return convert(input, context, options);
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    return fail('', 'invalid_record_or_context');
  }
}

function convert(
  input: ConversionInput,
  context: ConversionContext,
  options: { readonly converterRevision?: string; readonly sourceKind?: 'bangumi' | 'vndb' },
): CrossMediaEntityConversion {
  const sourceKind =
    options.sourceKind ?? (/^(?:character|person|episode):|^[1-9]/.test(input.external_id) ? 'bangumi' : 'vndb');
  const kind =
    crossMediaEntityKind(sourceKind, input.external_id, input.record) ?? fail('/external_id', 'unsupported_type');
  const projected = project(kind, input);
  const digest = sourceDigest(projected.normalized);
  const revision = options.converterRevision ?? converter_revision;
  const sourceId = context.source === undefined ? sourceKind : context.source;
  const metadata = {
    source: sourceId,
    external_id: input.external_id,
    record_revision: input.record_revision ?? 'unversioned',
    converter_revision: revision,
    digest,
  };
  const envelope = (group: FieldGroup) => sourceEnvelope(metadata, group);
  if (projected.ignored) {
    envelope('facts');
    return {
      ...metadata,
      source: sourceKind,
      outcome: 'ignored',
      proposals: [],
      diagnostics: [projected.ignored],
      digest,
      normalizedRecord: projected.normalized,
      coverAssets: [],
      mediaImportIntents: [],
    };
  }
  const url =
    sourceKind === 'bangumi'
      ? bangumiRecordUrl(input.external_id)
      : vndbRecordUrl(input.external_id, input.record_revision);
  const references = (): BatchReference[] => [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: url } }] },
  ];
  const key = (field: string, group: FieldGroup) =>
    commandKey([
      sourceId,
      input.external_id,
      metadata.record_revision,
      digest,
      revision,
      group,
      field,
      context.subjectId ?? 'bootstrap',
    ]);
  const fact = (property: string, content: unknown): BatchStatement => ({
    property: { id: property },
    value: { type: 'value', content },
    references: references(),
  });
  const profile = profiles[kind];
  const identifierContent = kind === 'bangumi-episode' ? url : projected.identifier;
  const names =
    projected.names ??
    projected.nameFacts ??
    Object.entries(projected.labels).map(([language, value]) => ({ language, text: value }));
  const facts: BatchStatement[] = [
    fact(profile.identifier, identifierContent),
    ...names.map((name) => fact('schema:name', name)),
    ...(projected.alternateNames ?? []).map((name) => fact('schema:alternateName', name)),

    ...(kind === 'vndb-release' && projected.minimumAge ? [fact('wdt:P2899', projected.minimumAge)] : []),

    ...(projected.qualifiedAlternateNames ?? []).map((name) => ({
      ...fact('schema:alternateName', { language: name.language, text: name.text }),
      qualifiers: [
        {
          property: { id: 'rezics:spoilerLevel' },
          value: { type: 'value' as const, content: name.spoilerLevel },
        },
      ],
    })),
  ];
  const diagnostics: ConversionDiagnostic[] = [...(projected.diagnostics ?? [])];
  const measurementCommandKeys = new Map<number, string>();
  for (const measurement of projected.characterMeasurements?.measurements ?? []) {
    if (!releasedCharacterQuantity(measurement.property, measurement.quantity)) {
      diagnostics.push({ pointer: measurement.pointer, code: 'unadmitted_character_quantity' });
      continue;
    }
    measurementCommandKeys.set(facts.length, `physical:${measurement.field}:${measurement.pointer}`);
    facts.push(fact(measurement.property, measurement.quantity));
  }
  const extlinks = projected.normalized.extlinks;
  if (Array.isArray(extlinks)) {
    for (const [i, link] of extlinks.entries()) {
      const row = link as { site?: unknown; value?: unknown };
      if (row.site === 'website' && typeof row.value === 'string') facts.push(fact('schema:url', row.value));
      else
        diagnostics.push({
          pointer: `/extlinks/${i}/site`,
          code: 'Unsupported external link site; retained as source metadata only',
        });
    }
  }
  if (kind === 'vndb-release') {
    const language = proposeReleaseLanguage(projected.normalized.olang, fact);
    if (language.statement) facts.push(language.statement);
    if (language.diagnostic) diagnostics.push(language.diagnostic);
    const decoded = decodeVndbReleaseGtin(projected.normalized.gtin);
    if (decoded.status === 'admitted') facts.push(fact('schema:gtin', decoded.gtin));
    else if (decoded.status === 'unknown') diagnostics.push({ pointer: '/gtin', code: 'unknown_source_value' });
    else if (decoded.status === 'invalid') diagnostics.push({ pointer: '/gtin', code: 'invalid_source_value' });
  }
  let descriptionText: string | undefined;
  if (kind === 'bangumi-episode') {
    const ordinal = episodeOrdinal(projected.normalized.sort);
    if (ordinal) facts.push(fact('schema:episodeNumber', ordinal));
    else if (projected.normalized.sort !== undefined)
      diagnostics.push({ pointer: '/sort', code: 'invalid_source_value' });
    const published = episodeAirdate(projected.normalized.airdate);
    if (published) facts.push(fact('schema:datePublished', published));
    else if (typeof projected.normalized.airdate === 'string' && projected.normalized.airdate.trim())
      diagnostics.push({ pointer: '/airdate', code: 'invalid_source_value' });
    const duration = episodeDuration(projected.normalized.duration);
    if (duration === 'unknown') diagnostics.push({ pointer: '/duration', code: 'unknown_duration_unit' });
    else if (duration) facts.push(fact('schema:duration', duration));
    const description = projected.normalized.description;
    if (typeof description === 'string' && description.trim()) {
      try {
        descriptionText = text(description, '/description', 32_768, true);
      } catch {
        fail('/description', 'invalid_record_summary_document_limit');
      }
    }
  }
  if (kind === 'vndb-character') {
    for (const [field, property] of [
      ['height', 'schema:height'],
      ['weight', 'schema:weight'],
    ] as const) {
      const result = vndbCharacterQuantity(projected.normalized[field], property);
      if (result === 'unknown') continue;
      if (result === 'invalid' || result === 'unadmitted') {
        diagnostics.push({
          pointer: `/${field}`,
          code: result === 'unadmitted' ? 'unadmitted_quantity' : 'invalid_source_value',
        });
        continue;
      }
      facts.push(fact(property, result));
    }
  }
  const proposals: BatchCommand[] = [];
  const summaryText =
    descriptionText ??
    (sourceKind === 'bangumi' &&
    (kind === 'bangumi-character' || kind === 'bangumi-person') &&
    typeof projected.normalized.summary === 'string'
      ? projected.normalized.summary
      : undefined);
  const summaryPath = descriptionText === undefined ? '/summary' : '/description';
  if (context.subjectId === undefined) {
    proposals.push({
      op: 'create',
      key: key('bootstrap', 'facts'),
      source: envelope('facts'),
      subject: {
        type: projected.type,
        labels: projected.labels,
        ...(projected.aliases && Object.keys(projected.aliases).length ? { aliases: projected.aliases } : {}),
      },
    });
  } else {
    if (
      typeof context.subjectId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(context.subjectId)
    )
      fail('', 'invalid_reference_context');
    for (const [index, statement] of facts.entries())
      proposals.push({
        op: 'propose',
        key: key(measurementCommandKeys.get(index) ?? `fact:${index}`, 'facts'),
        source: envelope('facts'),
        subject: context.subjectId,
        statement,
      });
    if (summaryText) {
      let document;
      try {
        document = textDocument(summaryText);
      } catch {
        fail(summaryPath, 'invalid_record_summary_document_limit');
      }
      proposals.push({
        op: 'propose',
        key: key('summary', 'summary'),
        source: envelope('summary'),
        subject: context.subjectId,
        statement: fact('schema:abstract', { language: 'und', document }),
        rights: {
          license: 'CC-BY-SA-3.0',
          obligations: ['cc:Attribution', 'cc:ShareAlike'],
          attribution: `Bangumi contributors (${url})`,
        },
      });
    }
  }
  if (proposals.length > (projected.maxCommands ?? vndbReleaseNameLimits.maxCommands))
    fail('', 'invalid_record_proposals');
  for (let offset = 0; offset < proposals.length; offset += BATCH_LIMIT)
    if (checkBatchWrite({ commands: proposals.slice(offset, offset + BATCH_LIMIT) }).length)
      fail('', 'invalid_record_proposals');
  return {
    ...metadata,
    source: sourceKind,
    outcome: 'converted',
    proposals,
    diagnostics,
    digest,
    normalizedRecord: projected.normalized,
    coverAssets: [],
    mediaImportIntents: [],
    sourceMetadata: {
      recordUrl: url,
      ...(summaryText ? { summary: { language: 'und', takedownEligible: true as const } } : {}),
    },
  };
}

export function relationStatement(input: {
  property: string;
  target: string;
  url: string;
  qualifiers?: { property: string; content: unknown }[];
}): BatchStatement {
  return {
    property: { id: input.property },
    value: { type: 'value', content: input.target },
    ...(input.qualifiers?.length
      ? {
          qualifiers: input.qualifiers.map((qualifier) => ({
            property: { id: qualifier.property },
            value: { type: 'value' as const, content: qualifier.content },
          })),
        }
      : {}),
    references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: input.url } }] }],
  };
}
