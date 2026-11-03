import { readFileSync } from 'node:fs';
import { types as utilTypes } from 'node:util';
import {
  checkBatchWrite,
  type BatchCommand,
  type BatchReference,
  type BatchStatement,
  type FieldGroup,
} from '@rezics/definitions/bulk';
import { ConversionError, type ConversionInput, type ConvertedRecord, type ConversionDiagnostic } from './index.ts';
import { commandKey, sourceDigest, sourceEnvelope, type ConversionContext } from './support.ts';

export const converter_revision = 'cross-media-entities@1';

export type SourceMapping = {
  status: 'existing' | 'proposed' | 'omitted';
  term?: string;
  inverse?: boolean;
  reason?: string;
  concept?: { id: string; scheme: string; label: string };
};

type InventoryValue = { id?: number | string; value?: string; mapping?: SourceMapping; term?: string; inverse?: boolean; status?: string; reason?: string };
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

const TV_PLATFORMS = new Set(['1', '2', '3', '6001', 'TV', 'tv']);
const FILM_PLATFORMS = new Set(['6002', 'Movie', 'movie']);

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
  if (entry.mapping) return entry.mapping;
  const status = entry.status === 'omitted' ? 'omitted' : entry.term ? 'existing' : 'omitted';
  return {
    status,
    ...(entry.term ? { term: entry.term } : {}),
    ...(entry.inverse ? { inverse: true } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
  };
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

export function isFamilyRelationTerm(term: string | undefined): boolean {
  return term !== undefined && FAMILY_TERMS.has(term);
}

export function liveActionWorkType(platform: unknown): 'schema:Movie' | 'schema:TVSeries' | undefined {
  if (platform === undefined || platform === null) return undefined;
  const value = String(platform);
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

export function crossMediaEntityKind(sourceKind: 'bangumi' | 'vndb', externalId: string, record: unknown): EntityKind | undefined {
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

function nativeNumber(value: unknown, pointer: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(pointer, 'invalid_identifier');
  return value as number;
}

const profiles: Record<
  EntityKind,
  { type: string; identifier: string; sourceKind: 'bangumi' | 'vndb' }
> = {
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

function project(
  kind: EntityKind,
  input: ConversionInput,
): { normalized: Normalized; type: string; labels: Record<string, string>; identifier: string; ignored?: ConversionDiagnostic } {
  const raw = object(input.record, '');
  const idField = kind.startsWith('vndb') ? 'id' : kind.startsWith('bangumi') && !kind.includes('music') && !kind.includes('live') ? 'id' : 'id';
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
  const name = own(raw, 'name', '/name');
  const title = own(raw, 'title', '/title');
  const label = name !== undefined ? text(name, '/name', 500) : title !== undefined ? text(title, '/title', 500) : expected;
  const chinese = own(raw, 'name_cn', '/name_cn');
  const labels: Record<string, string> = { und: label };
  if (typeof chinese === 'string' && chinese.trim()) labels.zh = text(chinese, '/name_cn', 500, true);
  const profile = profiles[kind];
  let type = profile.type;
  const normalized: Normalized = { id: nativeId, name: label };
  if (chinese !== undefined) normalized.name_cn = labels.zh ?? '';
  if (kind === 'bangumi-person') {
    type = personType(raw);
    normalized.type = own(raw, 'type', '/type');
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
  if (kind === 'bangumi-episode') {
    const sort = own(raw, 'sort', '/sort');
    if (sort !== undefined) normalized.sort = sort;
    const subjectId = own(raw, 'subject_id', '/subject_id');
    if (subjectId !== undefined) normalized.subject_id = subjectId;
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 65_536) fail('', 'invalid_record_byte_limit');
  return { normalized, type, labels, identifier: expected };
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
    options.sourceKind ??
    (/^(?:character|person|episode):|^[1-9]/.test(input.external_id) ? 'bangumi' : 'vndb');
  const kind = crossMediaEntityKind(sourceKind, input.external_id, input.record) ?? fail('/external_id', 'unsupported_type');
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
  const url = sourceKind === 'bangumi' ? bangumiRecordUrl(input.external_id) : vndbRecordUrl(input.external_id, input.record_revision);
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
  const facts: BatchStatement[] = [
    fact(profile.identifier, identifierContent),
    ...Object.entries(projected.labels).map(([language, value]) => fact('schema:name', { language, text: value })),
  ];
  if (kind === 'bangumi-episode' && projected.normalized.sort !== undefined)
    facts.push(fact('schema:episodeNumber', projected.normalized.sort));
  const proposals: BatchCommand[] = [];
  if (context.subjectId === undefined) {
    proposals.push({
      op: 'create',
      key: key('bootstrap', 'facts'),
      source: envelope('facts'),
      subject: { type: projected.type, labels: projected.labels },
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
        key: key(`fact:${index}`, 'facts'),
        source: envelope('facts'),
        subject: context.subjectId,
        statement,
      });
  }
  if (checkBatchWrite({ commands: proposals }).length) fail('', 'invalid_record_proposals');
  return {
    ...metadata,
    source: sourceKind,
    outcome: 'converted',
    proposals,
    diagnostics: [],
    digest,
    normalizedRecord: projected.normalized,
    coverAssets: [],
    mediaImportIntents: [],
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
