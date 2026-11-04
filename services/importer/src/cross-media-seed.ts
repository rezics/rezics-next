import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import { vndbLimits } from '@rezics/conversion/vndb';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { SourceVocabularyGap } from '@rezics/conversion';
import {
  bangumiRecordUrl,
  converter_revision as entityRevision,
  isFamilyRelationTerm,
  liveActionWorkType,
  mapSourceEnumeration,
  type SourceMapping,
  vndbCharacterNameLimits,
  vndbProducerParentEnds,
  vndbRecordUrl,
  vndbStaffNameLimit,
  vndbStaffNameLimits,
} from '@rezics/conversion/cross-media-entities';
import type { SourceVocabularyBindings } from '@rezics/conversion/source-vocabulary';
import { subjectSlug } from '@rezics/definitions/slug';
import { sourceDigest } from '../../../packages/conversion/src/support.ts';
import { createAccountTokenProvider, VNDB_IMPORTER_SCOPES } from './credentials.ts';
import { CrossMediaGraph, graphEdgeKey, type GraphEdgeDraft } from './cross-media-bindings.ts';
import {
  attachShowcaseWorkLinks,
  resolveShowcaseWorkLinkHandoffs,
  type CurrentWorkRead,
  type SelectedVndbWorkDictionaryRow,
  type SelectedVndbWorkJoin,
  type ShowcaseWorkLink,
  type ShowcaseWorkLinkHandoff,
} from './showcase-work-links.ts';
import {
  deliverBangumiCreatorCredits,
  type BangumiCreatorCreditDraft,
  type BangumiCreatorCreditGap,
} from './bangumi-creator-credits.ts';
import {
  combineVocabularyRequests,
  prepareShowcaseVndbCredits,
  type VndbCreditVocabularyReferences,
  type VndbCreditVocabularyRequirement,
} from './showcase-vndb-credits.ts';
import { createImportTransport, type ReviewedSubjectRead } from './import-client.ts';
import { createPublicBulkClient } from './public-bulk-client.ts';
import { captureShowcaseCommands, publishShowcase, ShowcaseJournal } from './showcase-publication.ts';
import { createImporter, type ImporterOptions, type ImportRunResult } from './importer.ts';
import { createSourceRegistration } from './source-registry.ts';
import { runBangumiCharacterFidelity } from './bangumi-character-fidelity.ts';
import { VNDB_PUBLIC_TAG_COLUMNS } from './vndb-tables.ts';
import {
  composeVocabularyAdmissions,
  discoverShowcaseBangumiEpisodes,
  readShowcaseEpisodeTypeBindings,
  showcaseEpisodeAdmissionDiagnostics,
  showcaseEpisodeVocabularyAdmission,
  type ShowcaseEpisodeDiagnostic,
} from './showcase-bangumi-episodes.ts';
import { createShowcaseBangumiGenreLookup, prepareShowcaseBangumiGenres } from './showcase-bangumi-genres.ts';
import type { BangumiGenrePublication } from './showcase-bangumi-genres.ts';
import type { ReviewedCataloguePort } from './reviewed-catalogue.ts';

type Provider = 'bangumi' | 'vndb';
type Row = Record<string, unknown>;
export type Franchise = 'steins-gate' | 'clannad' | 'fate';
const patterns: Record<Franchise, RegExp> = {
  'steins-gate': /^(?:STEINS[;；]GATE|シュタインズ[・･]ゲート|命运石之门)(?:$|[\s:：0])/i,
  clannad: /^CLANNAD(?:$|[\s:：])/i,
  fate: /^(?:Fate\s*[/／]|フェイト\s*[/／])/i,
};
export const crossMediaAliases = { bangumi: 'bangumi_cross_media', vndb: 'vndb_cross_media' } as const;
const FAMILY_CAP = 256;
const RELATION_CAP = 4096;

/** Membership uses titles only, never synopsis mentions, credits or a shared actor. */
export function crossMediaFranchise(...names: unknown[]): Franchise | undefined {
  return (Object.keys(patterns) as Franchise[]).find((family) =>
    names.some((name) => typeof name === 'string' && patterns[family].test(name.trim())),
  );
}

export interface CrossMediaTables {
  rows(provider: Provider, table: string): AsyncIterable<Row>;
}
export type SelectedVndbCharacterNameRows = {
  names: Map<string, Row[]>;
  aliases: Map<string, Row[]>;
  overflow: Map<string, { table: 'chars_names' | 'chars_alias'; row: Row; reason: string }>;
};

/** Join only elected VNDB character IDs and retain stable, bounded COPY-column rows. */
export async function collectSelectedVndbCharacterNameRows(
  input: CrossMediaTables,
  selected: ReadonlySet<string>,
): Promise<SelectedVndbCharacterNameRows> {
  const names = new Map<string, Row[]>();
  const aliases = new Map<string, Row[]>();
  const overflow = new Map<string, { table: 'chars_names' | 'chars_alias'; row: Row; reason: string }>();
  const byteCounts = new Map<string, number>();
  const limits = new Map<string, number>();
  for (const table of ['chars_names', 'chars_alias'] as const) {
    const destination = table === 'chars_names' ? names : aliases;
    const limit = table === 'chars_names' ? vndbCharacterNameLimits.maxNames : vndbCharacterNameLimits.maxAliases;
    for await (const sourceRow of input.rows('vndb', table)) {
      if (typeof sourceRow.id !== 'string' || !selected.has(sourceRow.id)) continue;
      const row =
        table === 'chars_names'
          ? { id: sourceRow.id, lang: sourceRow.lang, name: sourceRow.name, latin: sourceRow.latin }
          : { id: sourceRow.id, spoil: sourceRow.spoil, name: sourceRow.name, latin: sourceRow.latin };
      const key = JSON.stringify(row);
      const rows = destination.get(sourceRow.id) ?? [];
      if (rows.some((existing) => JSON.stringify(existing) === key)) continue;
      if (overflow.has(sourceRow.id)) continue;
      const fields = table === 'chars_names' ? ['lang', 'name', 'latin'] : ['spoil', 'name', 'latin'];
      const oversize = fields.some((field) => {
        const value = row[field as keyof typeof row];
        return typeof value === 'string' && Buffer.byteLength(value, 'utf8') > vndbCharacterNameLimits.stringBytes;
      });
      const rowBytes = Buffer.byteLength(key, 'utf8');
      const nextBytes = (byteCounts.get(sourceRow.id) ?? 0) + rowBytes;
      const nextCount = (limits.get(sourceRow.id) ?? 0) + 1;
      if (
        oversize ||
        rows.length >= limit ||
        nextCount > limit * 2 ||
        nextBytes > vndbCharacterNameLimits.recordBytes
      ) {
        overflow.set(sourceRow.id, {
          table,
          row,
          reason: oversize ? 'value_limit' : rows.length >= limit || nextCount > limit * 2 ? 'row_limit' : 'byte_limit',
        });
        continue;
      }
      rows.push(row);
      destination.set(sourceRow.id, rows);
      byteCounts.set(sourceRow.id, nextBytes);
      limits.set(sourceRow.id, nextCount);
    }
  }
  const ids = new Set([...names.keys(), ...aliases.keys()]);
  for (const id of ids) {
    for (const row of names.get(id) ?? []) {
      const language = String(row.lang ?? '');
      const name = String(row.name ?? '');
      const previous = names.get(id)!.find((candidate) => candidate !== row && candidate.lang === language);
      if (previous && (previous.name !== name || previous.latin !== row.latin)) {
        overflow.set(id, { table: 'chars_names', row, reason: 'conflicting_key' });
        break;
      }
    }
    for (const row of aliases.get(id) ?? []) {
      const previous = aliases.get(id)!.find((candidate) => candidate !== row && candidate.name === row.name);
      if (previous && (previous.spoil !== row.spoil || previous.latin !== row.latin)) {
        overflow.set(id, { table: 'chars_alias', row, reason: 'conflicting_key' });
        break;
      }
    }
    const nameRows = names.get(id) ?? [];
    const aliasRows = aliases.get(id) ?? [];
    for (const [table, rows] of [
      ['chars_names', nameRows],
      ['chars_alias', aliasRows],
    ] as const) {
      rows.sort((left, right) => {
        const a = JSON.stringify(left);
        const b = JSON.stringify(right);
        return a < b ? -1 : a > b ? 1 : 0;
      });
      if (Buffer.byteLength(JSON.stringify(rows), 'utf8') > vndbCharacterNameLimits.recordBytes)
        overflow.set(id, { table, row: rows[0] ?? { id }, reason: 'byte_limit' });
    }
    if (
      Buffer.byteLength(JSON.stringify({ chars_names: nameRows, chars_alias: aliasRows }), 'utf8') >
      vndbCharacterNameLimits.recordBytes
    )
      overflow.set(id, {
        table: 'chars_names',
        row: nameRows[0] ?? aliasRows[0] ?? { id },
        reason: 'byte_limit',
      });
  }
  return { names, aliases, overflow };
}
export type CrossMediaGap = {
  source: Provider;
  /** Exact provider key when the source row has a usable identity. */
  externalId?: string;
  /** Exact dump columns, including qualifications, ordering and original endpoint IDs. */
  fields: string[];
  record: Row;
  reason: string;
  code?: string;
  endpoint?: string;
  property?: string;
  requiredProfile?: string;
};
export type CrossMediaMember = {
  source: Provider;
  key: string;
  kind: 'work' | 'character' | 'person' | 'episode' | 'release' | 'organization';
  membership: 'family' | 'referenced';
  franchise?: Franchise;
};
export type BangumiCharacterAppearance = {
  subjectId: string;
  characterId: number;
  sourceIndex: number;
  roleCode: number | string;
  order?: number | string | null;
};
export type CrossMediaReleaseFacts = {
  works: Map<string, { devstatus: number | undefined }>;
  releases: Map<string, { released: unknown; links: { vid: string; completeness: string }[] }>;
};
export type CrossMediaPlan = {
  records: Record<Provider, SourceRecord[]>;
  entities: Record<Provider, SourceRecord[]>;
  edges: GraphEdgeDraft[];
  workLinks: ShowcaseWorkLink[];
  credits: BangumiCreatorCreditDraft[];
  franchises: Record<Franchise, { bangumi: string[]; vndb: string[] }>;
  members: CrossMediaMember[];
  characterAppearances?: BangumiCharacterAppearance[];
  gaps: CrossMediaGap[];
  relationScope: string[];
  relationSnapshotDigest: string;
  relationSnapshotComplete: boolean;
  /** Selected-family VNDB release dates/states for the common showcase publisher. */
  releaseFacts?: CrossMediaReleaseFacts;
};
const VNDB_EXPECTED_HEADERS: Readonly<Record<string, string>> = {
  producers_relations: 'id\tpid\trelation',
  releases_media: 'id\tmedium\tqty',
  releases_platforms: 'id\tplatform',
};
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}

/** Production seed origins require HTTPS; local development may use loopback HTTP. */
export function normalizeCrossMediaSeedOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  ensure(
    (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash,
    'Seed API and Auth require HTTPS origins or loopback HTTP origins',
  );
  return url.origin;
}
function text(row: Row, field: string): string {
  const value = row[field];
  ensure(typeof value === 'string' && value.length > 0, `Missing source field: ${field}`);
  return value;
}
function number(row: Row, field: string): number {
  const value = row[field];
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, `Invalid Bangumi ${field}`);
  return value;
}
const RELEASE_TITLE_CAP = 64;
function compareCopyText(a: unknown, b: unknown): number {
  const left = a == null ? '' : String(a);
  const right = b == null ? '' : String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Bind title rows whose exact release ID is selected. Input order never ranks labels. */
export function collectSelectedReleaseTitles(
  id: string,
  rows: readonly Row[],
): { titles: Row[]; overflow: Row[]; duplicates: Row[] } {
  const seen = new Set<string>();
  const unique: Row[] = [];
  const duplicates: Row[] = [];
  for (const row of rows) {
    if (row.id !== id) continue;
    const key = JSON.stringify([row.lang, row.title, row.latin]);
    if (seen.has(key)) {
      duplicates.push(row);
      continue;
    }
    seen.add(key);
    unique.push(row);
  }
  unique.sort(
    (a, b) => compareCopyText(a.lang, b.lang) || compareCopyText(a.title, b.title) || compareCopyText(a.latin, b.latin),
  );
  return {
    titles: unique.slice(0, RELEASE_TITLE_CAP),
    overflow: unique.slice(RELEASE_TITLE_CAP),
    duplicates,
  };
}
function positiveLink(row: Row, field: string): number {
  const value = row[field];
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new TypeError(`Invalid dump integer: ${field}`);
}
function parsePositiveLink(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}
function fieldsOf(table: string, record: Row): string[] {
  return Object.keys(record)
    .sort()
    .map((field) => `${table}.${field}`);
}
function emptyFranchises(): Record<Franchise, { bangumi: string[]; vndb: string[] }> {
  return {
    'steins-gate': { bangumi: [], vndb: [] },
    clannad: { bangumi: [], vndb: [] },
    fate: { bangumi: [], vndb: [] },
  };
}

export function emptyCrossMediaPlan(): CrossMediaPlan {
  return {
    records: { bangumi: [], vndb: [] },
    entities: { bangumi: [], vndb: [] },
    edges: [],
    workLinks: [],
    credits: [],
    franchises: emptyFranchises(),
    members: [],
    characterAppearances: [],
    gaps: [],
    relationScope: [],
    relationSnapshotDigest: sourceDigest([]),
    relationSnapshotComplete: true,
  };
}

function bangumiRelation(type: number, code: unknown): SourceMapping | undefined {
  return mapSourceEnumeration('bangumi', `relation.${type}`, code as number);
}

function countFamily<K>(franchiseOf: Map<K, Franchise>, family: Franchise): number {
  let count = 0;
  for (const value of franchiseOf.values()) if (value === family) count++;
  return count;
}

function vndbProducerProfile(row: Row): string {
  const type = row.type;
  if (type === undefined || type === null) return 'schema:Organization';
  const mapping = mapSourceEnumeration('vndb', 'producer_type', String(type));
  return mapping?.term === 'schema:Person' ? 'schema:Person' : 'schema:Organization';
}

function parentReaches(from: string, to: string, edges: Map<string, Set<string>>): boolean {
  const seen = new Set<string>();
  const pending = [from];
  while (pending.length) {
    const next = pending.pop()!;
    if (next === to) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const parent of edges.get(next) ?? []) pending.push(parent);
  }
  return false;
}

/** Select a finite family catalogue; unsupported native rows remain explicit source gaps.
 * Ported selection/incident-edge shape: legacy-final:scripts/datasets/{bangumi,vndb}.ts.
 * Title matching locates records only; identities bind only through cited provider URLs.
 */
export async function planCrossMediaSeed(input: CrossMediaTables): Promise<CrossMediaPlan> {
  const plan = emptyCrossMediaPlan();
  plan.characterAppearances ??= [];
  const gap = (
    source: Provider,
    table: string,
    record: Row,
    reason: string,
    details: Pick<CrossMediaGap, 'code' | 'endpoint' | 'property' | 'requiredProfile'> = {},
  ) => {
    plan.gaps.push({ source, fields: fieldsOf(table, record), record, reason, ...details });
  };
  const edge = (draft: GraphEdgeDraft) => plan.edges.push(draft);
  const member = (entry: CrossMediaMember) => {
    if (!plan.members.some((row) => row.source === entry.source && row.key === entry.key)) plan.members.push(entry);
  };
  const tagged = (franchise: Franchise | undefined): { franchise: Franchise } | {} => (franchise ? { franchise } : {});

  const types = new Map<number, number>();
  const titled = new Map<number, Franchise>();
  for await (const row of input.rows('bangumi', 'subject')) {
    const id = number(row, 'id');
    ensure(!types.has(id), 'Duplicate selected Bangumi subject');
    types.set(id, row.type as number);
    const family = crossMediaFranchise(row.name, row.name_cn);
    if (family) titled.set(id, family);
  }
  const familyIds = new Map<number, Franchise>(titled);
  const referencedWorks = new Map<number, Franchise>();
  let grew = true;
  while (grew) {
    grew = false;
    for await (const row of input.rows('bangumi', 'subject-relations')) {
      const sid = number(row, 'subject_id');
      const rid = number(row, 'related_subject_id');
      const known = familyIds.get(sid) ?? familyIds.get(rid);
      if (!known) continue;
      const holderType = types.get(sid);
      if (holderType === undefined) {
        gap('bangumi', 'subject-relations', row, 'Missing target record for this source relation');
        continue;
      }
      const mapping = bangumiRelation(holderType, row.relation_type);
      if (!mapping?.term || mapping.status === 'omitted' || !isFamilyRelationTerm(mapping.term)) continue;
      const other = familyIds.has(sid) ? rid : sid;
      const otherFamily = familyIds.get(other);
      if (otherFamily && otherFamily !== known) {
        referencedWorks.set(other, known);
        continue;
      }
      if (!familyIds.has(other) && types.has(other) && countFamily(familyIds, known) < FAMILY_CAP) {
        familyIds.set(other, known);
        grew = true;
      } else if (!types.has(other)) {
        gap('bangumi', 'subject-relations', row, 'Missing target record for this source relation');
      }
    }
  }

  const subjects = new Map<number, Row>();
  const anime = new Set<Franchise>();
  for await (const row of input.rows('bangumi', 'subject')) {
    const id = number(row, 'id');
    if (!familyIds.has(id) && !referencedWorks.has(id)) continue;
    subjects.set(id, row);
  }
  for (const [id, family] of familyIds) {
    const row = subjects.get(id);
    if (!row) {
      gap('bangumi', 'subject', { id }, 'Missing target record for this source relation');
      continue;
    }
    const type = row.type as number;
    if (type === 2 && titled.has(id)) anime.add(family);
    plan.franchises[family].bangumi.push(String(id));
    member({ source: 'bangumi', key: String(id), kind: 'work', membership: 'family', franchise: family });
    if (type === 3) {
      plan.entities.bangumi.push({ source: 'bangumi', key: String(id), revision: null, payload: row });
      continue;
    }
    if (type === 6) {
      if (!liveActionWorkType(row.platform)) {
        gap('bangumi', 'subject', row, 'Live-action platform is not a pinned film or TV code');
        continue;
      }
      plan.entities.bangumi.push({ source: 'bangumi', key: String(id), revision: null, payload: row });
      continue;
    }
    if (![1, 2, 4].includes(type)) {
      gap('bangumi', 'subject', row, 'Source work type is outside the registered Bangumi conversion scope');
      continue;
    }
    plan.records.bangumi.push({ source: 'bangumi', key: String(id), revision: null, payload: row });
  }
  const selectedAnime = new Map<number, Franchise>();
  for (const [id, family] of familyIds) if (types.get(id) === 2) selectedAnime.set(id, family);
  for (const [id, family] of referencedWorks) {
    if (familyIds.has(id) || !subjects.has(id)) continue;
    member({ source: 'bangumi', key: String(id), kind: 'work', membership: 'referenced', franchise: family });
    const row = subjects.get(id)!;
    if ([1, 2, 4].includes(row.type as number))
      plan.records.bangumi.push({ source: 'bangumi', key: String(id), revision: null, payload: row });
  }

  const relationRows: Row[] = [];
  let relationOverflow = false;
  for await (const row of input.rows('bangumi', 'subject-relations')) {
    const sid = number(row, 'subject_id');
    const rid = number(row, 'related_subject_id');
    if (!familyIds.has(sid) && !familyIds.has(rid) && !referencedWorks.has(sid) && !referencedWorks.has(rid)) continue;
    if (relationRows.length < RELATION_CAP) relationRows.push(row);
    else relationOverflow = true;
  }
  if (relationOverflow)
    gap('bangumi', 'subject-relations', { limit: RELATION_CAP }, 'Selected source relation limit exceeded');
  relationRows.sort(
    (left, right) =>
      number(left, 'subject_id') - number(right, 'subject_id') ||
      number(left, 'related_subject_id') - number(right, 'related_subject_id') ||
      Number(left.relation_type) - Number(right.relation_type),
  );
  plan.relationScope = [
    ...new Set([
      ...[...familyIds.keys(), ...referencedWorks.keys()].map(String),
      ...relationRows.flatMap((row) => [String(number(row, 'subject_id')), String(number(row, 'related_subject_id'))]),
    ]),
  ].sort();
  plan.relationSnapshotDigest = sourceDigest(relationRows);
  plan.relationSnapshotComplete = !relationOverflow;

  const pairs = new Map<string, Row[]>();
  for (const row of relationRows) {
    const sid = number(row, 'subject_id');
    const rid = number(row, 'related_subject_id');
    const key = sid < rid ? `${sid}:${rid}` : `${rid}:${sid}`;
    pairs.set(key, [...(pairs.get(key) ?? []), row]);
  }
  const canonicalEdges = new Map<string, GraphEdgeDraft>();
  for (const rows of pairs.values()) {
    for (const row of rows) {
      const sid = number(row, 'subject_id');
      const rid = number(row, 'related_subject_id');
      if (!familyIds.has(sid) && !familyIds.has(rid) && !referencedWorks.has(sid) && !referencedWorks.has(rid))
        continue;
      const family = types.get(sid);
      const code = row.relation_type;
      const mapping = family === undefined ? undefined : bangumiRelation(family, code);
      if (!mapping) {
        gap('bangumi', 'subject-relations', row, 'Unknown Bangumi relation code', {
          ...(typeof code === 'number' || typeof code === 'string' ? { code: String(code) } : {}),
          property: `relation.${family ?? 'unknown'}`,
        });
        continue;
      }
      if (mapping.status === 'omitted' || !mapping.term) {
        gap('bangumi', 'subject-relations', row, mapping.reason ?? 'Bangumi relation is not admitted', {
          ...(typeof code === 'number' || typeof code === 'string' ? { code: String(code) } : {}),
          property: `relation.${family ?? 'unknown'}`,
        });
        continue;
      }
      if (![1, 2, 4, 6].includes(family!)) {
        gap('bangumi', 'subject-relations', row, 'Bangumi relation family is outside the reviewed mapper scope');
        continue;
      }
      if (typeof code !== 'number' || !Number.isSafeInteger(code)) {
        gap('bangumi', 'subject-relations', row, 'Invalid Bangumi relation code');
        continue;
      }
      const reciprocalRows = rows.filter(
        (candidate) =>
          candidate.subject_id === rid &&
          candidate.related_subject_id === sid &&
          typeof candidate.relation_type === 'number' &&
          Number.isSafeInteger(candidate.relation_type),
      );
      const reciprocalCodes = [...new Set(reciprocalRows.map((candidate) => candidate.relation_type as number))];
      if (reciprocalCodes.length > 1) {
        gap('bangumi', 'subject-relations', row, 'Ambiguous reciprocal Bangumi relation rows');
        continue;
      }
      const reciprocalCode = reciprocalCodes[0];
      const term =
        (reciprocalCode === undefined ? undefined : mapping.canonicalByReverse?.[String(reciprocalCode)]?.term) ??
        mapping.term;
      let holder = mapping.inverse ? rid : sid;
      let target = mapping.inverse ? sid : rid;
      if (bundledRelease.properties[term]?.relation?.symmetric && String(target) < String(holder))
        [holder, target] = [target, holder];
      const holderKey = String(holder);
      const targetKey = String(target);
      const path = `/subject-relations/${sid}/${rid}`;
      const evidenceRows = [row, ...reciprocalRows];
      const evidence = evidenceRows.map((evidenceRow) => ({
        path: `/subject-relations/${evidenceRow.subject_id}/${evidenceRow.related_subject_id}`,
        code: evidenceRow.relation_type as number,
        sourceSubject: String(evidenceRow.subject_id),
        sourceEndpoint: String(evidenceRow.related_subject_id),
        digest: sourceDigest(evidenceRow),
      }));
      const mappingRevision = `bangumi-relation-${family}@2:${code}:${reciprocalCode ?? 'one-sided'}`;
      const key = `${holderKey}\u0000${term}\u0000${targetKey}`;
      const prior = canonicalEdges.get(key);
      if (prior?.relation) {
        const combined = [...prior.relation.evidence, ...evidence].filter(
          (item, index, all) =>
            all.findIndex((other) => other.path === item.path && other.code === item.code) === index,
        );
        prior.relation.evidence = combined;
        prior.fields = [...new Set([...prior.fields, ...fieldsOf('subject-relations', row)])].sort();
        prior.relation.mappingRevision = [prior.relation.mappingRevision, mappingRevision].sort().join('+');
        continue;
      }
      const draft: GraphEdgeDraft = {
        source: 'bangumi',
        alias: crossMediaAliases.bangumi,
        table: 'subject-relations',
        holder: holderKey,
        target: targetKey,
        property: term,
        url: bangumiRecordUrl(holderKey),
        membership: isFamilyRelationTerm(term) ? 'family' : 'referenced',
        record: row,
        fields: [...new Set(evidenceRows.flatMap((evidenceRow) => fieldsOf('subject-relations', evidenceRow)))].sort(),
        relation: {
          family: family as 1 | 2 | 4 | 6,
          code,
          ...(reciprocalCode === undefined ? {} : { reciprocalCode }),
          path,
          sourceSubject: String(sid),
          sourceEndpoint: String(rid),
          mappingRevision,
          evidence,
        },
      };
      canonicalEdges.set(key, draft);
    }
  }
  for (const draft of canonicalEdges.values()) edge(draft);

  const characters = new Set<number>();
  const persons = new Set<number>();
  const familyWorks = new Set(familyIds.keys());
  const importedWorks = new Set([...plan.records.bangumi, ...plan.entities.bangumi].map((row) => row.key));
  const selectedBangumiWorks = importedWorks;
  const admittedAppearanceIndices = new Set<number>();
  const appearanceCounts = new Map<number, number>();
  let selectionIndex = 0;
  for await (const row of input.rows('bangumi', 'subject-characters')) {
    const sourceIndex = selectionIndex++;
    const subjectId = number(row, 'subject_id');
    if (familyWorks.has(subjectId)) characters.add(number(row, 'character_id'));
    if (!selectedBangumiWorks.has(String(subjectId))) continue;
    const characterId = number(row, 'character_id');
    const count = (appearanceCounts.get(subjectId) ?? 0) + 1;
    appearanceCounts.set(subjectId, count);
    if (count > 64) {
      gap('bangumi', 'subject-characters', row, 'Per-work character appearance mapping limit exceeded');
      continue;
    }
    characters.add(characterId);
    admittedAppearanceIndices.add(sourceIndex);
  }
  for await (const row of input.rows('bangumi', 'subject-persons')) {
    if (!familyWorks.has(number(row, 'subject_id'))) continue;
    persons.add(number(row, 'person_id'));
  }
  for await (const row of input.rows('bangumi', 'person-characters')) {
    if (!familyWorks.has(number(row, 'subject_id')) && !characters.has(number(row, 'character_id'))) continue;
    persons.add(number(row, 'person_id'));
    characters.add(number(row, 'character_id'));
  }
  let appearanceIndex = 0;
  for await (const row of input.rows('bangumi', 'subject-characters')) {
    const sourceIndex = appearanceIndex++;
    const subjectId = number(row, 'subject_id');
    const characterId = number(row, 'character_id');
    if (
      !admittedAppearanceIndices.has(sourceIndex) ||
      !selectedBangumiWorks.has(String(subjectId)) ||
      !characters.has(characterId)
    )
      continue;
    const work = String(subjectId);
    const character = `character:${characterId}`;
    member({
      source: 'bangumi',
      key: character,
      kind: 'character',
      membership: familyWorks.has(number(row, 'subject_id')) ? 'family' : 'referenced',
      ...tagged(familyIds.get(number(row, 'subject_id'))),
    });
    const roleCode = row.type;
    if (typeof roleCode !== 'number' && typeof roleCode !== 'string') {
      gap('bangumi', 'subject-characters', row, 'Appearance role code is not a supported scalar');
      continue;
    }
    (plan.characterAppearances ??= []).push({
      subjectId: work,
      characterId,
      sourceIndex,
      roleCode,
      ...(row.order === undefined
        ? {}
        : {
            order:
              typeof row.order === 'number' || typeof row.order === 'string' || row.order === null ? row.order : -1,
          }),
    });
  }
  for await (const row of input.rows('bangumi', 'subject-persons')) {
    if (!familyWorks.has(number(row, 'subject_id'))) continue;
    const work = String(number(row, 'subject_id'));
    const personId = number(row, 'person_id');
    const person = `person:${personId}`;
    const workType = types.get(number(row, 'subject_id'));
    const mapping = mapSourceEnumeration('bangumi', `staff.${workType}`, row.position as number);
    member({
      source: 'bangumi',
      key: person,
      kind: 'person',
      membership: 'referenced',
      ...tagged(familyIds.get(number(row, 'subject_id'))),
    });
    if (!mapping?.term || mapping.status === 'omitted') {
      gap(
        'bangumi',
        'subject-persons',
        row,
        mapping?.reason ?? 'No registered native converter for this source relation or entity',
      );
    }
    if (!importedWorks.has(work)) continue;
    plan.credits.push({
      kind: 'staff',
      work,
      workType: workType ?? 0,
      person,
      roleCode: row.position as number,
      path: `/subject-persons/${work}/${personId}/position`,
      record: row,
    });
  }
  for await (const row of input.rows('bangumi', 'person-characters')) {
    if (!familyWorks.has(number(row, 'subject_id')) && !characters.has(number(row, 'character_id'))) continue;
    const work = String(number(row, 'subject_id'));
    const personId = number(row, 'person_id');
    const characterId = number(row, 'character_id');
    const person = `person:${personId}`;
    const character = `character:${characterId}`;
    member({
      source: 'bangumi',
      key: person,
      kind: 'person',
      membership: 'referenced',
      ...tagged(familyIds.get(number(row, 'subject_id'))),
    });
    member({
      source: 'bangumi',
      key: character,
      kind: 'character',
      membership: 'referenced',
      ...tagged(familyIds.get(number(row, 'subject_id'))),
    });
    if (!importedWorks.has(work)) {
      gap(
        'bangumi',
        'person-characters',
        row,
        'Voice credit work is outside the elected family; appearance retained as a referenced endpoint',
      );
      continue;
    }
    plan.credits.push({
      kind: 'voice-credit',
      work,
      workType: types.get(number(row, 'subject_id')) ?? 0,
      person,
      character,
      path: `/person-characters/${work}/${personId}/${characterId}`,
      record: row,
    });
  }
  const corePersons = new Set(persons),
    coreCharacters = new Set(characters);
  for await (const row of input.rows('bangumi', 'person-relations')) {
    ensure(row.person_type === 'prsn' || row.person_type === 'crt', 'Unknown Bangumi person_type');
    const core = row.person_type === 'prsn' ? corePersons : coreCharacters;
    if (!core.has(row.person_id as number) && !core.has(row.related_person_id as number)) continue;
    gap('bangumi', 'person-relations', row, 'No registered native converter for this source relation or entity');
    const all = row.person_type === 'prsn' ? persons : characters;
    if (typeof row.person_id === 'number') all.add(row.person_id);
    if (typeof row.related_person_id === 'number') all.add(row.related_person_id);
  }
  for await (const row of input.rows('bangumi', 'character'))
    if (characters.has(number(row, 'id'))) {
      plan.entities.bangumi.push({
        source: 'bangumi',
        key: `character:${row.id}`,
        revision: null,
        payload: row,
      });
      member({ source: 'bangumi', key: `character:${row.id}`, kind: 'character', membership: 'referenced' });
    }
  for await (const row of input.rows('bangumi', 'person'))
    if (persons.has(number(row, 'id'))) {
      plan.entities.bangumi.push({ source: 'bangumi', key: `person:${row.id}`, revision: null, payload: row });
      member({ source: 'bangumi', key: `person:${row.id}`, kind: 'person', membership: 'referenced' });
    }
  const episodes = await discoverShowcaseBangumiEpisodes({
    tables: input,
    selectedAnime,
    alias: crossMediaAliases.bangumi,
  });
  plan.entities.bangumi.push(...episodes.entities);
  for (const episode of episodes.members) member(episode);
  plan.edges.push(...episodes.edges);
  plan.gaps.push(...episodes.gaps);

  const vnIds = new Set<string>();
  const vnFamily = new Map<string, Franchise>();
  for await (const row of input.rows('vndb', 'vn_titles')) {
    const family = crossMediaFranchise(row.title, row.latin);
    if (!family) continue;
    const id = text(row, 'id');
    ensure(/^v[1-9][0-9]*$/.test(id), 'Invalid VNDB work identity');
    if (!vnFamily.has(id) && countFamily(vnFamily, family) >= FAMILY_CAP) {
      gap('vndb', 'vn_titles', { id }, 'Selected VNDB family exceeds the bounded work limit');
      continue;
    }
    vnIds.add(id);
    vnFamily.set(id, family);
    if (!plan.franchises[family].vndb.includes(id)) plan.franchises[family].vndb.push(id);
  }
  let vnGrew = true;
  while (vnGrew) {
    vnGrew = false;
    for await (const row of input.rows('vndb', 'vn_relations')) {
      const id = text(row, 'id');
      const vid = text(row, 'vid');
      const known = vnFamily.get(id) ?? vnFamily.get(vid);
      if (!known) continue;
      const mapping = mapSourceEnumeration('vndb', 'vn_relation', text(row, 'relation'));
      if (!mapping?.term || mapping.status === 'omitted' || !isFamilyRelationTerm(mapping.term)) continue;
      const other = vnFamily.has(id) ? vid : id;
      if (!vnFamily.has(other) && countFamily(vnFamily, known) < FAMILY_CAP) {
        vnFamily.set(other, known);
        vnIds.add(other);
        if (!plan.franchises[known].vndb.includes(other)) plan.franchises[known].vndb.push(other);
        vnGrew = true;
      }
    }
  }
  const titles = new Map<string, Row[]>(),
    vns = new Map<string, Row>(),
    revisions = new Map<string, Row>();
  for await (const row of input.rows('vndb', 'vn_titles')) {
    const id = text(row, 'id');
    if (!vnIds.has(id)) continue;
    ensure(row.official === 't' || row.official === 'f', 'Invalid VNDB official title flag');
    const title = { ...row, official: row.official === 't' };
    titles.set(id, [...(titles.get(id) ?? []), title]);
  }
  for await (const row of input.rows('vndb', 'vn')) {
    const id = text(row, 'id');
    if (!vnIds.has(id)) continue;
    ensure(!vns.has(id), 'Duplicate selected VNDB work');
    vns.set(id, row);
  }
  for await (const row of input.rows('vndb', 'entry_meta')) {
    const id = text(row, 'id');
    if (!vnIds.has(id)) continue;
    ensure(!revisions.has(id), 'Duplicate selected VNDB revision');
    ensure(/^[1-9][0-9]*$/.test(text(row, 'revision')), 'Invalid VNDB revision');
    revisions.set(id, { id, revision: Number(row.revision), lastmod: row.lastmod });
  }
  for (const id of vnIds) {
    const row = vns.get(id),
      entry_meta = revisions.get(id);
    ensure(row && entry_meta && titles.has(id), `Missing selected VNDB record: ${id}`);
    const vn: Row = { id, olang: row.olang, ...(row.alias === null ? {} : { alias: row.alias }) };
    if (row.c_votecount !== undefined || row.c_average !== undefined) {
      ensure(
        typeof row.c_votecount === 'string' && /^(?:0|[1-9][0-9]*)$/.test(row.c_votecount),
        'Invalid VNDB vote count',
      );
      ensure(
        row.c_average === null || (typeof row.c_average === 'string' && /^(?:0|[1-9][0-9]*)$/.test(row.c_average)),
        'Invalid VNDB average',
      );
      vn.c_votecount = Number(row.c_votecount);
      vn.c_average = row.c_average === null ? null : Number(row.c_average);
    }
    plan.records.vndb.push({
      source: 'vndb',
      key: id,
      revision: String(entry_meta.revision),
      payload: { vn, entry_meta, vn_titles: titles.get(id)! },
    });
    member({ source: 'vndb', key: id, kind: 'work', membership: 'family', ...tagged(vnFamily.get(id)) });
  }
  for await (const row of input.rows('vndb', 'vn_relations')) {
    const id = text(row, 'id');
    const vid = text(row, 'vid');
    if (!vnIds.has(id) && !vnIds.has(vid)) continue;
    const mapping = mapSourceEnumeration('vndb', 'vn_relation', text(row, 'relation'));
    if (!mapping?.term || mapping.status === 'omitted') {
      gap(
        'vndb',
        'vn_relations',
        row,
        mapping?.reason ?? 'No registered native converter for this source relation or entity',
      );
      continue;
    }
    const holder = mapping.inverse ? vid : id;
    const target = mapping.inverse ? id : vid;
    if (!vnIds.has(target)) {
      gap('vndb', 'vn_relations', row, 'Missing target record for this source relation');
      continue;
    }
    edge({
      source: 'vndb',
      alias: crossMediaAliases.vndb,
      table: 'vn_relations',
      holder,
      target,
      property: mapping.term,
      url: vndbRecordUrl(holder),
      membership: isFamilyRelationTerm(mapping.term) ? 'family' : 'referenced',
      record: row,
      fields: fieldsOf('vn_relations', row),
    });
  }
  const releases = new Set<string>(),
    chars = new Set<string>(),
    aliases = new Set<string>();
  for await (const row of input.rows('vndb', 'releases_vn'))
    if (vnIds.has(text(row, 'vid'))) releases.add(text(row, 'id'));
  for await (const row of input.rows('vndb', 'releases_vn')) {
    if (!releases.has(text(row, 'id'))) continue;
    edge({
      source: 'vndb',
      alias: crossMediaAliases.vndb,
      table: 'releases_vn',
      holder: text(row, 'id'),
      target: text(row, 'vid'),
      property: 'schema:exampleOfWork',
      url: vndbRecordUrl(text(row, 'id')),
      membership: 'referenced',
      record: row,
      fields: fieldsOf('releases_vn', row),
    });
    member({
      source: 'vndb',
      key: text(row, 'id'),
      kind: 'release',
      membership: 'referenced',
      ...tagged(vnFamily.get(text(row, 'vid'))),
    });
  }
  for await (const row of input.rows('vndb', 'vn_staff')) {
    if (!vnIds.has(text(row, 'id'))) continue;
    aliases.add(text(row, 'aid'));
    const mapping = mapSourceEnumeration('vndb', 'credit_type', text(row, 'role'));
    if (!mapping?.term) {
      gap(
        'vndb',
        'vn_staff',
        row,
        mapping?.reason ?? 'No registered native converter for this source relation or entity',
      );
      continue;
    }
    // The family coordinator replaces this coarse edge when its exact current role Concept maps.
    edge({
      source: 'vndb',
      alias: crossMediaAliases.vndb,
      table: 'vn_staff',
      holder: text(row, 'id'),
      target: `staff-alias:${text(row, 'aid')}`,
      property: mapping.term,
      url: vndbRecordUrl(text(row, 'id')),
      membership: 'referenced',
      record: row,
      fields: fieldsOf('vn_staff', row),
    });
  }
  for await (const row of input.rows('vndb', 'vn_seiyuu')) {
    if (!vnIds.has(text(row, 'id'))) continue;
    aliases.add(text(row, 'aid'));
    chars.add(text(row, 'cid'));
    const qualifiers: { property: string; content: unknown }[] = [{ property: 'wdt:P453', content: text(row, 'cid') }];
    if (typeof row.note === 'string' && row.note) qualifiers.push({ property: 'wdt:P1932', content: row.note });
    edge({
      source: 'vndb',
      alias: crossMediaAliases.vndb,
      table: 'vn_seiyuu',
      holder: text(row, 'id'),
      target: `staff-alias:${text(row, 'aid')}`,
      property: 'wdt:P725',
      url: vndbRecordUrl(text(row, 'id')),
      membership: 'referenced',
      record: row,
      fields: fieldsOf('vn_seiyuu', row),
      qualifiers,
    });
  }
  const selectedVndbCharacterIds = new Set<string>();
  for await (const row of input.rows('vndb', 'chars_vns')) {
    if (!vnIds.has(text(row, 'vid'))) continue;
    const id = text(row, 'id');
    chars.add(id);
    selectedVndbCharacterIds.add(id);
  }
  for await (const row of input.rows('vndb', 'chars_vns')) {
    if (!chars.has(text(row, 'id'))) continue;
    if (!vnIds.has(text(row, 'vid'))) {
      gap('vndb', 'chars_vns', row, 'Missing target record for this source relation');
      continue;
    }
    const role = mapSourceEnumeration('vndb', 'char_role', text(row, 'role'));
    if (role?.status === 'omitted') gap('vndb', 'chars_vns', row, role.reason ?? 'Unsupported character role');
    else if (role?.term === 'wdt:P3831')
      gap('vndb', 'chars_vns', row, 'Appearance role concept has no resolved native Concept binding');
    edge({
      source: 'vndb',
      alias: crossMediaAliases.vndb,
      table: 'chars_vns',
      holder: text(row, 'vid'),
      target: text(row, 'id'),
      property: 'schema:character',
      url: vndbRecordUrl(text(row, 'vid')),
      membership: 'referenced',
      record: row,
      fields: fieldsOf('chars_vns', row),
    });
    member({
      source: 'vndb',
      key: text(row, 'id'),
      kind: 'character',
      membership: 'referenced',
      ...tagged(vnFamily.get(text(row, 'vid'))),
    });
  }
  const aliasToStaff = new Map<string, string>();
  for await (const row of input.rows('vndb', 'staff_alias')) {
    const aid = text(row, 'aid');
    if (aliases.has(aid)) aliasToStaff.set(aid, text(row, 'id'));
  }
  const staff = new Set(aliasToStaff.values());
  const staffRows = new Set<string>();
  const staffRowById = new Map<string, Row>();
  const preferredAliasOwners = new Map<string, Set<string>>();
  for await (const row of input.rows('vndb', 'staff')) {
    const id = text(row, 'id');
    if (!staff.has(id)) continue;
    staffRows.add(id);
    staffRowById.set(id, row);
    const main = row.main;
    if (typeof main !== 'string' || !/^[1-9][0-9]*$/.test(main) || !Number.isSafeInteger(Number(main))) continue;
    const owners = preferredAliasOwners.get(main) ?? new Set<string>();
    owners.add(id);
    preferredAliasOwners.set(main, owners);
  }
  const aliasNames = new Map<string, string>();
  const staffAliasLists = new Map<string, { id: string; aid: string; name: string }[]>();
  const aliasAidOwners = new Map<string, string>();
  const staffAliasRejected = new Set<string>();
  const staffAliasOverflowReported = new Set<string>();
  const preferredOwnerGaps = new Set<string>();
  for await (const row of input.rows('vndb', 'staff_alias')) {
    const sid = text(row, 'id');
    const aid = row.aid;
    if (typeof aid === 'string') {
      for (const selectedOwner of preferredAliasOwners.get(aid) ?? []) {
        const gapKey = `${selectedOwner}\u0000${aid}`;
        if (selectedOwner !== sid && !preferredOwnerGaps.has(gapKey)) {
          const staffRow = staffRowById.get(selectedOwner);
          if (staffRow) gap('vndb', 'staff', staffRow, 'Preferred staff alias belongs to another owner');
          preferredOwnerGaps.add(gapKey);
        }
      }
    }
    if (!staff.has(sid)) continue;
    if (typeof row.name === 'string' && row.name) aliasNames.set(text(row, 'aid'), row.name);
    const aliasName = row.name;
    if (typeof aid !== 'string' || !/^[1-9][0-9]*$/.test(aid) || !Number.isSafeInteger(Number(aid))) {
      gap('vndb', 'staff_alias', row, 'Invalid VNDB staff alias identity');
      continue;
    }
    if (
      typeof aliasName !== 'string' ||
      !aliasName.isWellFormed() ||
      !aliasName.trim() ||
      [...aliasName].length > vndbStaffNameLimits.maxNameChars
    ) {
      gap('vndb', 'staff_alias', row, 'Staff alias name is not admitted as a native name fact');
      continue;
    }
    const owner = aliasAidOwners.get(aid);
    if (owner !== undefined && owner !== sid) {
      gap('vndb', 'staff_alias', row, 'Staff alias key belongs to another owner');
      staffAliasLists.set(
        owner,
        (staffAliasLists.get(owner) ?? []).filter((item) => item.aid !== aid),
      );
      aliasAidOwners.delete(aid);
      continue;
    }
    const list = staffAliasLists.get(sid) ?? [];
    if (list.some((item) => item.aid === aid)) {
      gap('vndb', 'staff_alias', row, 'Duplicate staff alias key');
      staffAliasLists.set(
        sid,
        list.filter((item) => item.aid !== aid),
      );
      aliasAidOwners.delete(aid);
      continue;
    }
    if (list.length >= vndbStaffNameLimit) {
      staffAliasRejected.add(sid);
      if (!staffAliasOverflowReported.has(sid)) {
        gap('vndb', 'staff_alias', row, 'Staff alias membership exceeds the bounded import cap');
        staffAliasOverflowReported.add(sid);
      }
      continue;
    }
    aliasAidOwners.set(aid, sid);
    list.push({ id: sid, aid, name: aliasName });
    staffAliasLists.set(sid, list);
  }
  const withheldCredits = new Set<GraphEdgeDraft>();
  for (const draft of plan.edges) {
    if (draft.source !== 'vndb' || !draft.target.startsWith('staff-alias:')) continue;
    const aid = draft.target.slice('staff-alias:'.length);
    const sid = aliasToStaff.get(aid);
    if (!sid) {
      gap('vndb', draft.table, draft.record, 'Missing target record for this source relation');
      withheldCredits.add(draft);
      continue;
    }
    if (!/^s[1-9][0-9]*$/.test(sid) || !staffRows.has(sid)) {
      gap('vndb', draft.table, draft.record, 'Staff kind is not a person identity');
      withheldCredits.add(draft);
      continue;
    }
    draft.target = sid;
    const note = draft.record.note;
    const hasCreditedAs = draft.qualifiers?.some((qualifier) => qualifier.property === 'wdt:P1932');
    if (note !== undefined && note !== null && note !== '') {
      if (typeof note !== 'string' || !note.isWellFormed() || !note.trim() || note.length > 1500) {
        gap('vndb', draft.table, draft.record, 'Credited spelling is not admitted as a native qualifier');
        withheldCredits.add(draft);
        continue;
      }
      if (!hasCreditedAs) draft.qualifiers = [...(draft.qualifiers ?? []), { property: 'wdt:P1932', content: note }];
    } else {
      const aliasName = aliasNames.get(aid);
      if (aliasName && !hasCreditedAs && aliasName.isWellFormed() && aliasName.trim() && aliasName.length <= 1500)
        draft.qualifiers = [...(draft.qualifiers ?? []), { property: 'wdt:P1932', content: aliasName }];
    }
    member({ source: 'vndb', key: sid, kind: 'person', membership: 'referenced' });
  }
  if (withheldCredits.size) plan.edges = plan.edges.filter((draft) => !withheldCredits.has(draft));
  const characterNameRows = await collectSelectedVndbCharacterNameRows(input, selectedVndbCharacterIds);
  for (const [id, issue] of characterNameRows.overflow)
    gap('vndb', issue.table, issue.row, `Selected character name payload rejected: ${issue.reason}`, {
      code: issue.reason,
    });
  for await (const row of input.rows('vndb', 'chars')) {
    const id = text(row, 'id');
    if (!chars.has(id)) continue;
    if (typeof row.main === 'string' && /^c[1-9][0-9]*$/.test(row.main)) {
      chars.add(row.main);
      member({ source: 'vndb', key: row.main, kind: 'character', membership: 'referenced' });
      gap(
        'vndb',
        'chars',
        { id: row.id, main: row.main },
        'chars.main is a referenced character endpoint; the source relation is not a standalone profile field',
      );
    }
    if (selectedVndbCharacterIds.has(id) && characterNameRows.overflow.has(id)) continue;
    const payload = selectedVndbCharacterIds.has(id)
      ? {
          ...row,
          chars_names: characterNameRows.names.get(id) ?? [],
          chars_alias: characterNameRows.aliases.get(id) ?? [],
        }
      : row;
    plan.entities.vndb.push({ source: 'vndb', key: id, revision: null, payload });
  }
  for (const [id, row] of staffRowById) {
    if (staffAliasRejected.has(id)) continue;
    plan.entities.vndb.push({
      source: 'vndb',
      key: id,
      revision: null,
      payload: { ...row, aliases: staffAliasLists.get(id) ?? [] },
    });
  }
  const releaseTitleRows: Row[] = [];
  for await (const row of input.rows('vndb', 'releases_titles')) {
    if (typeof row.id !== 'string' || !releases.has(row.id)) continue;
    releaseTitleRows.push(row);
  }
  for await (const row of input.rows('vndb', 'releases'))
    if (releases.has(text(row, 'id'))) {
      const bound = collectSelectedReleaseTitles(text(row, 'id'), releaseTitleRows);
      for (const extra of bound.overflow)
        gap('vndb', 'releases_titles', extra, 'Release titles exceed the bounded import cap');
      for (const extra of bound.duplicates)
        gap('vndb', 'releases_titles', extra, 'Duplicate selected VNDB release title');
      if (!bound.titles.length)
        gap('vndb', 'releases_titles', { id: text(row, 'id') }, 'Missing selected VNDB release title');
      plan.entities.vndb.push({
        source: 'vndb',
        key: text(row, 'id'),
        revision: null,
        payload: bound.titles.length ? { ...row, releases_titles: bound.titles } : row,
      });
    }
  for await (const row of input.rows('vndb', 'vn_anime'))
    if (vnIds.has(text(row, 'id')))
      gap('vndb', 'vn_anime', row, 'VNDB anime.aid is an AniDB identifier, not a Bangumi or native subject identity');
  const producers = new Set<string>(),
    animeIds = new Set<string>();
  const workJoins = new Map<string, SelectedVndbWorkJoin[]>();
  const invalidWorkOwners = new Set<string>();
  for await (const row of input.rows('vndb', 'releases_producers')) {
    if (!releases.has(text(row, 'id'))) continue;
    producers.add(text(row, 'pid'));
    const developer = row.developer === 't' || row.developer === true;
    const publisher = row.publisher === 't' || row.publisher === true;
    if (developer)
      edge({
        source: 'vndb',
        alias: crossMediaAliases.vndb,
        table: 'releases_producers',
        holder: text(row, 'id'),
        target: text(row, 'pid'),
        property: 'wdt:P178',
        url: vndbRecordUrl(text(row, 'id')),
        membership: 'referenced',
        record: row,
        fields: fieldsOf('releases_producers', row),
      });
    if (publisher)
      edge({
        source: 'vndb',
        alias: crossMediaAliases.vndb,
        table: 'releases_producers',
        holder: text(row, 'id'),
        target: text(row, 'pid'),
        property: 'schema:publisher',
        url: vndbRecordUrl(text(row, 'id')),
        membership: 'referenced',
        record: row,
        fields: fieldsOf('releases_producers', row),
      });
    if (!developer && !publisher)
      gap('vndb', 'releases_producers', row, 'Release producer role flags do not select a native credit');
  }
  for await (const row of input.rows('vndb', 'releases_supersedes')) {
    if (!releases.has(text(row, 'id'))) continue;
    releases.add(text(row, 'rid') as string);
    member({ source: 'vndb', key: text(row, 'rid'), kind: 'release', membership: 'referenced' });
    gap(
      'vndb',
      'releases_supersedes',
      row,
      'Release-to-release supersession is not representable on the shared follows term',
    );
  }
  for await (const row of input.rows('vndb', 'vn_extlinks')) {
    const owner = text(row, 'id');
    if (!vnIds.has(owner)) continue;
    if (invalidWorkOwners.has(owner)) continue;
    const link = parsePositiveLink(row.link);
    if (link === undefined) {
      invalidWorkOwners.add(owner);
      gap('vndb', 'vn_extlinks', { id: owner, link: null }, 'Invalid selected VNDB work external-link identifier');
      continue;
    }
    const joins = workJoins.get(owner) ?? [];
    if (joins.some((entry) => entry.join.link === link)) {
      invalidWorkOwners.add(owner);
      workJoins.delete(owner);
      gap('vndb', 'vn_extlinks', { id: owner, link }, 'Duplicate selected VNDB work external link join');
      continue;
    }
    if (joins.length >= vndbLimits.maxLinks) {
      invalidWorkOwners.add(owner);
      workJoins.delete(owner);
      gap('vndb', 'vn_extlinks', { id: owner, link }, 'Selected VNDB work external links exceed the converter limit');
      continue;
    }
    joins.push({ join: { id: owner, link }, raw: { id: row.id, link: row.link } });
    workJoins.set(owner, joins);
  }
  for (const owner of invalidWorkOwners) workJoins.delete(owner);
  const workLinkIds = new Set<number>();
  for (const joins of workJoins.values()) for (const entry of joins) workLinkIds.add(entry.join.link);
  for await (const row of input.rows('vndb', 'staff'))
    if (staff.has(text(row, 'id')) && typeof row.prod === 'string') producers.add(row.prod);
  const producerRows = new Map<string, Row>();
  for await (const row of input.rows('vndb', 'producers')) {
    const id = text(row, 'id');
    ensure(/^p[1-9][0-9]*$/.test(id), 'Invalid VNDB producer identity');
    ensure(!producerRows.has(id), 'Duplicate selected VNDB producer');
    producerRows.set(id, row);
  }
  let producerGrew = true;
  while (producerGrew) {
    producerGrew = false;
    for await (const row of input.rows('vndb', 'producers_relations')) {
      const id = text(row, 'id');
      const pid = text(row, 'pid');
      const mapping = mapSourceEnumeration('vndb', 'producer_relation', text(row, 'relation'));
      if (mapping?.status !== 'existing' || mapping.term !== 'wdt:P749') continue;
      if (!producers.has(id) && !producers.has(pid)) continue;
      for (const endpoint of [id, pid]) {
        if (producers.has(endpoint)) continue;
        if (producers.size >= FAMILY_CAP) {
          gap('vndb', 'producers_relations', row, 'Selected source relation limit exceeded', {
            endpoint,
            property: 'wdt:P749',
          });
          continue;
        }
        producers.add(endpoint);
        producerGrew = true;
      }
    }
  }
  for await (const row of input.rows('vndb', 'vn_anime'))
    if (vnIds.has(text(row, 'id'))) animeIds.add(text(row, 'aid'));
  for (const id of producers) {
    const row = producerRows.get(id);
    if (!row) continue;
    plan.entities.vndb.push({ source: 'vndb', key: id, revision: null, payload: row });
    member({
      source: 'vndb',
      key: id,
      kind: vndbProducerProfile(row) === 'schema:Person' ? 'person' : 'organization',
      membership: 'referenced',
    });
  }
  const parentAdj = new Map<string, Set<string>>();
  let parentOverflow = false;
  let parentCount = 0;
  for await (const row of input.rows('vndb', 'producers_relations')) {
    const id = text(row, 'id');
    const pid = text(row, 'pid');
    if (!producers.has(id) && !producers.has(pid)) continue;
    const code = text(row, 'relation');
    const mapping = mapSourceEnumeration('vndb', 'producer_relation', code);
    if (parentCount >= RELATION_CAP) {
      parentOverflow = true;
      continue;
    }
    parentCount += 1;
    if (mapping?.status !== 'existing' || mapping.term !== 'wdt:P749' || (code !== 'par' && code !== 'sub')) {
      gap(
        'vndb',
        'producers_relations',
        row,
        mapping?.reason ?? 'No registered native converter for this source relation or entity',
        { code, property: 'producers_relations.relation' },
      );
      continue;
    }
    const ends = vndbProducerParentEnds(code, id, pid);
    if (!ends) continue;
    if (!producerRows.has(ends.holder) || !producerRows.has(ends.target)) {
      const missing = producerRows.has(ends.holder) ? ends.target : ends.holder;
      gap('vndb', 'producers_relations', row, 'Missing target record for this source relation', {
        code,
        endpoint: missing,
        property: 'wdt:P749',
      });
      continue;
    }
    const holderType = vndbProducerProfile(producerRows.get(ends.holder)!);
    const targetType = vndbProducerProfile(producerRows.get(ends.target)!);
    if (holderType !== 'schema:Organization' || targetType !== 'schema:Organization') {
      gap('vndb', 'producers_relations', row, 'Producer kind is not an organization identity', {
        code,
        endpoint: holderType !== 'schema:Organization' ? ends.holder : ends.target,
        property: 'wdt:P749',
        requiredProfile: holderType !== 'schema:Organization' ? holderType : targetType,
      });
      continue;
    }
    if (ends.holder === ends.target || parentReaches(ends.target, ends.holder, parentAdj)) {
      gap('vndb', 'producers_relations', row, 'Parent organization relation is cyclic', {
        code,
        endpoint: ends.target,
        property: 'wdt:P749',
      });
      continue;
    }
    const adjacent = parentAdj.get(ends.holder) ?? new Set<string>();
    adjacent.add(ends.target);
    parentAdj.set(ends.holder, adjacent);
    const path = `/producers_relations/${id}/${pid}`;
    const evidence = [
      {
        path,
        code,
        sourceSubject: id,
        sourceEndpoint: pid,
        digest: sourceDigest(row),
      },
    ];
    edge({
      source: 'vndb',
      alias: crossMediaAliases.vndb,
      table: 'producers_relations',
      holder: ends.holder,
      target: ends.target,
      property: 'wdt:P749',
      url: vndbRecordUrl(ends.holder),
      membership: 'referenced',
      record: row,
      fields: fieldsOf('producers_relations', row),
      producerParent: {
        code,
        path,
        sourceSubject: id,
        sourceEndpoint: pid,
        mappingRevision: `producer-parent@1:${code}`,
        evidence,
      },
    });
  }
  if (parentOverflow)
    gap('vndb', 'producers_relations', { limit: RELATION_CAP }, 'Selected source relation limit exceeded', {
      property: 'wdt:P749',
    });

  const entityJoins = new Map<string, { table: string; joins: { id: string; link: number }[] }>();
  const dictionaryIds = new Set<number>(workLinkIds);
  const entityJoinKeys = new Set<string>();
  let entityJoinCount = 0;
  const collectJoins = async (
    table: 'staff_extlinks' | 'producers_extlinks' | 'releases_extlinks',
    owners: Set<string>,
  ) => {
    for await (const row of input.rows('vndb', table)) {
      const owner = text(row, 'id');
      if (!owners.has(owner)) continue;
      const link = positiveLink(row, 'link');
      const associationKey = `${table}\u0000${owner}\u0000${link}`;
      if (entityJoinKeys.has(associationKey)) throw new TypeError('Duplicate selected external link join');
      entityJoinKeys.add(associationKey);
      entityJoinCount += 1;
      if (entityJoinCount > FAMILY_CAP * 3 * 32) throw new TypeError('Selected external link row limit exceeded');
      let entry = entityJoins.get(owner);
      if (!entry) {
        entry = { table, joins: [] };
        entityJoins.set(owner, entry);
      } else if (entry.table !== table) throw new TypeError('Selected VNDB owner keys overlap across entity tables');
      entry.joins.push({ id: owner, link });
      dictionaryIds.add(link);
      if (entry.joins.length > 32) throw new TypeError('Dump row count exceeds source cap');
    }
  };
  await collectJoins('staff_extlinks', staff);
  await collectJoins('producers_extlinks', producers);
  await collectJoins('releases_extlinks', releases);
  const dictionary = new Map<number, { id: number; site: string; value: string; raw: Row }>();
  const duplicateDictionaryIds = new Set<number>();
  for await (const row of input.rows('vndb', 'anime'))
    if (animeIds.has(text(row, 'id')))
      gap('vndb', 'anime', row, 'VNDB anime.aid is an AniDB identifier, not a Bangumi or native subject identity');
  for await (const row of input.rows('vndb', 'extlinks')) {
    const id = parsePositiveLink(row.id);
    if (id === undefined) continue;
    if (!dictionaryIds.has(id)) continue;
    if (duplicateDictionaryIds.has(id)) continue;
    if (dictionary.has(id)) {
      dictionary.delete(id);
      duplicateDictionaryIds.add(id);
      gap('vndb', 'extlinks', { id }, 'Duplicate selected VNDB external-link dictionary row');
      continue;
    }
    const site = text(row, 'site');
    const value = text(row, 'value');
    dictionary.set(id, { id, site, value, raw: row });
    if (site !== 'website')
      gap(
        'vndb',
        'extlinks',
        {
          id,
          site: typeof row.site === 'string' && /^[a-z][a-z0-9_-]{0,31}$/iu.test(row.site) ? row.site : '<invalid>',
        },
        'Unsupported external link site; retained as source metadata only',
      );
  }
  const workDictionary = new Map<number, SelectedVndbWorkDictionaryRow>();
  for (const [id, row] of dictionary)
    workDictionary.set(id, { value: { id, site: row.site, value: row.value }, raw: row.raw });
  const workProjection = attachShowcaseWorkLinks({
    alias: crossMediaAliases.vndb,
    records: plan.records.vndb,
    joins: workJoins,
    dictionary: workDictionary,
  });
  plan.records.vndb = workProjection.records;
  plan.workLinks = workProjection.links;
  plan.edges.push(...workProjection.edges);
  for (const missing of workProjection.gaps) gap('vndb', 'vn_extlinks', missing.record, missing.reason);
  for (const entity of plan.entities.vndb) {
    const entry = entityJoins.get(entity.key);
    if (!entry) continue;
    const missing = entry.joins.filter((join) => !dictionary.has(join.link));
    if (missing.length) {
      for (const join of missing)
        gap(
          'vndb',
          entry.table,
          { id: join.id, link: join.link },
          'Missing selected VNDB external-link dictionary row',
        );
      continue;
    }
    const extlinks = entry.joins.map((join) => {
      const row = dictionary.get(join.link);
      ensure(row, 'Selected VNDB external-link dictionary row disappeared during projection');
      return { id: row.id, site: row.site, value: row.value };
    });
    entity.payload = { ...(entity.payload as object), [entry.table]: entry.joins, extlinks };
  }

  for (const family of Object.keys(patterns) as Franchise[])
    ensure(anime.has(family) && plan.franchises[family].vndb.length, `Missing anime/VN pair for ${family}`);
  for (const provider of ['bangumi', 'vndb'] as const) {
    const registration = createSourceRegistration(provider, {
      source: crossMediaAliases[provider],
      converterRevision: entityRevision,
    });
    for (const row of [...plan.records[provider], ...plan.entities[provider]])
      registration.convert(
        { external_id: row.key, record_revision: row.revision, record: row.payload },
        { source: registration.source },
      );
    plan.records[provider].sort((a, b) => a.key.localeCompare(b.key));
    plan.entities[provider].sort((a, b) => a.key.localeCompare(b.key));
  }
  for (const family of Object.values(plan.franchises)) {
    family.bangumi.sort();
    family.vndb.sort();
  }
  return plan;
}

/** PostgreSQL COPY text escaping, ported from legacy-final:scripts/datasets/vndb.ts. */
export function decodeCrossMediaCopy(value: string): string | null {
  if (value === '\\N') return null;
  return value.replace(/\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)/g, (_match, code: string) => {
    const escapes: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
    if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8));
    if (code.startsWith('x')) return String.fromCharCode(parseInt(code.slice(1), 16));
    return escapes[code] ?? code;
  });
}

/** Extracted official dump tables only. No remote acquisition, SQL execution or platform database access. */
export class CrossMediaDumpFiles implements CrossMediaTables {
  readonly digests = new Map<string, string>();
  constructor(
    private readonly bangumi: string,
    private readonly vndb: string,
  ) {}
  async *rows(provider: Provider, table: string): AsyncGenerator<Row> {
    ensure(/^[a-z][a-z_-]*$/.test(table), 'Invalid dump table name');
    const file = provider === 'bangumi' ? join(this.bangumi, `${table}.jsonlines`) : join(this.vndb, 'db', table);
    const requiredLinkTable = provider === 'vndb' && (table === 'vn_extlinks' || table === 'extlinks');
    let header: Buffer | null = null;
    if (provider === 'vndb') {
      try {
        header = await readFile(`${file}.header`);
      } catch (error) {
        if (requiredLinkTable && (error as { code?: unknown }).code === 'ENOENT')
          throw new TypeError('Required VNDB external-link table header is missing: ' + table);
        throw error;
      }
    }
    const columns = header ? header.toString('utf8').trimEnd().split('\t') : null;
    if (columns) {
      ensure(columns.length > 0 && new Set(columns).size === columns.length, 'Invalid VNDB header');
      if (table === 'vn_extlinks') ensure(columns.join('\t') === 'id\tlink', 'Invalid VNDB vn_extlinks header');
      if (table === 'extlinks') ensure(columns.join('\t') === 'id\tsite\tvalue', 'Invalid VNDB extlinks header');
      if (table === 'producers_relations')
        ensure(columns.join('\t') === 'id\tpid\trelation', 'Invalid VNDB producers_relations header');
      if (table === 'tags' || table === 'tags_parents' || table === 'tags_vn')
        ensure(columns.join('\t') === VNDB_PUBLIC_TAG_COLUMNS[table].join('\t'), `Invalid VNDB ${table} header`);
      if (table === 'chars_alias')
        ensure(columns.join('\t') === 'id\tspoil\tname\tlatin', 'Invalid VNDB chars_alias header');
      if (table === 'chars_names')
        ensure(columns.join('\t') === 'id\tlang\tname\tlatin', 'Invalid VNDB chars_names header');
      const expectedHeader = VNDB_EXPECTED_HEADERS[table];
      if (expectedHeader) ensure(columns.join('\t') === expectedHeader, `Invalid VNDB ${table} header`);
      const headerKey = `${provider}/${table}.header`,
        hash = createHash('sha256').update(header!).digest('hex');
      ensure(!this.digests.has(headerKey) || this.digests.get(headerKey) === hash, 'Dump changed during selection');
      this.digests.set(headerKey, hash);
    }
    const stream = createReadStream(file);
    const digest = createHash('sha256');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    async function* lines() {
      let pending = '';
      for await (const chunk of stream) {
        digest.update(chunk);
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n')) !== -1) {
          ensure(Buffer.byteLength(pending.slice(0, end)) <= 1024 * 1024, 'Dump row exceeds seed input limit');
          yield pending.slice(0, end).replace(/\r$/, '');
          pending = pending.slice(end + 1);
        }
        ensure(Buffer.byteLength(pending) <= 1024 * 1024, 'Dump row exceeds seed input limit');
      }
      pending += decoder.decode();
      if (pending) yield pending;
    }
    try {
      for await (const line of lines()) {
        if (!line) continue;
        ensure(Buffer.byteLength(line) <= 1024 * 1024, 'Dump row exceeds seed input limit');
        if (columns) {
          const cells = line.split('\t');
          ensure(cells.length === columns.length, `Invalid VNDB column count: ${table}`);
          yield Object.fromEntries(columns.map((column, i) => [column, decodeCrossMediaCopy(cells[i]!)]));
        } else {
          const row: unknown = JSON.parse(line);
          ensure(row && typeof row === 'object' && !Array.isArray(row), 'Invalid Bangumi row');
          yield row as Row;
        }
      }
    } catch (error) {
      if (requiredLinkTable && (error as { code?: unknown }).code === 'ENOENT')
        throw new TypeError('Required VNDB external-link table is missing: ' + table);
      if (requiredLinkTable && error instanceof TypeError)
        throw new TypeError('Invalid VNDB external-link table: ' + table, { cause: error });
      throw error;
    } finally {
      stream.destroy();
    }
    const key = `${provider}/${table}`,
      hash = digest.digest('hex');
    ensure(!this.digests.has(key) || this.digests.get(key) === hash, 'Dump changed during selection');
    this.digests.set(key, hash);
  }
}

export type CrossMediaPort = Pick<
  ReturnType<typeof createImportTransport>,
  | 'batch'
  | 'setSourceRecordMetadata'
  | 'fence'
  | 'writeSourceStatistic'
  | 'clearSourceStatistic'
  | 'readReviewedSubject'
>;
export type CrossMediaReading = {
  source: Provider;
  externalId: string;
  subject: ReviewedSubjectRead;
  route: string;
  selection: 'selected' | 'proposed';
};
export type CrossMediaSeedResult = {
  status: 'imported' | 'imported-with-gaps';
  franchises: CrossMediaPlan['franchises'];
  members: CrossMediaMember[];
  runs: Partial<Record<Provider, ImportRunResult>> & { bangumiCharacterFidelity?: ImportRunResult };
  readings: CrossMediaReading[];
  workLinks: ShowcaseWorkLinkHandoff[];
  gaps: CrossMediaGap[];
  creditGaps: BangumiCreatorCreditGap[];
  vndbCreditDiagnostics: SourceVocabularyGap[];
  vndbCreditVocabularyRequirements: VndbCreditVocabularyRequirement[];
  characterDiagnostics: SourceVocabularyGap[];
  episodeDiagnostics: ShowcaseEpisodeDiagnostic[];
  unresolved: { holder: string; target: string; property: string; reason: string }[];
  bangumiGenrePublication?: BangumiGenrePublication;
};

function subjectRoute(read: ReviewedSubjectRead): string {
  const subject = (read as { subject?: { id?: string; labels?: Record<string, string> } }).subject;
  const id = subject?.id;
  const labels = subject?.labels ?? {};
  const label = labels.und ?? labels.en ?? labels.ja ?? labels.zh ?? Object.values(labels)[0] ?? 'subject';
  return id ? `/subjects/${id}/${subjectSlug(label)}` : '/subjects';
}

function currentWorkRead(read: ReviewedSubjectRead): CurrentWorkRead | undefined {
  const subjectId = (read as { subject?: { id?: unknown } }).subject?.id;
  if (
    typeof subjectId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(subjectId)
  )
    return undefined;
  return { subjectId, route: subjectRoute(read) };
}

export type CrossMediaSeedExtras = {
  vocabularyAdmission?: ImporterOptions['vocabularyAdmission'];
  vocabularyAdmissions?: readonly NonNullable<ImporterOptions['vocabularyAdmission']>[];
  /** Native IDs returned by the common explicit reviewed-catalogue publisher. */
  episodeCatalogueSubjects?: Readonly<Record<string, string>>;
  entitiesFirst?: boolean;
  recordConcurrency?: ImporterOptions['recordConcurrency'];
  sourceVocabulary?: SourceVocabularyBindings;
  vndbCreditReferences?: VndbCreditVocabularyReferences;
  providers?: readonly Provider[];
  mediaDeadlineMs?: ImporterOptions['mediaDeadlineMs'];
  onConversionOutput?: ImporterOptions['onConversionOutput'];
  /** The ordinary CLI supplies its existing authenticated read port. */
  bangumiGenrePort?: ReviewedCataloguePort;
};

export async function seedCrossMedia(
  plan: CrossMediaPlan,
  path: string,
  port: CrossMediaPort,
  destination?: { origin: string },
  extras?: CrossMediaSeedExtras,
  characterBindings?: SourceVocabularyBindings,
) {
  const providers = extras?.providers ?? (['bangumi', 'vndb'] as const);
  const vndbCredits = providers.includes('vndb')
    ? await prepareShowcaseVndbCredits(plan, port, extras?.vndbCreditReferences)
    : undefined;
  const existingAdmission =
    extras?.vocabularyAdmission || vndbCredits
      ? {
          request(context: Parameters<NonNullable<NonNullable<ImporterOptions['vocabularyAdmission']>['request']>>[0]) {
            return combineVocabularyRequests([
              extras?.vocabularyAdmission?.request?.(context),
              vndbCredits?.vocabularyAdmission.request?.(context),
            ]);
          },
        }
      : undefined;
  const episodeBindings = extras?.episodeCatalogueSubjects
    ? await readShowcaseEpisodeTypeBindings(port, extras.episodeCatalogueSubjects)
    : undefined;
  const episodeDiagnostics = episodeBindings
    ? showcaseEpisodeAdmissionDiagnostics(plan.entities.bangumi, episodeBindings)
    : [];
  const vocabularyAdmission = composeVocabularyAdmissions(
    existingAdmission,
    ...(extras?.vocabularyAdmissions ?? []),
    ...(episodeBindings ? [showcaseEpisodeVocabularyAdmission(episodeBindings)] : []),
  );
  let importer!: ReturnType<typeof createImporter>;
  let genreAdapter: ReturnType<typeof createShowcaseBangumiGenreLookup> | undefined;
  const identifierLookup = extras?.bangumiGenrePort
    ? {
        async resolve(input: Parameters<NonNullable<ImporterOptions['identifierLookup']>['resolve']>[0]) {
          genreAdapter ??= createShowcaseBangumiGenreLookup(
            crossMediaAliases.bangumi,
            importer.session.bindings,
            extras.bangumiGenrePort!,
          );
          return genreAdapter.lookup.resolve(input);
        },
      }
    : undefined;
  importer = createImporter({
    path,
    ...(destination ? { destination } : {}),
    ...(identifierLookup ? { identifierLookup } : {}),
    ...(vocabularyAdmission ? { vocabularyAdmission } : {}),
    ...(vndbCredits
      ? { recordConcurrency: 1 }
      : extras?.recordConcurrency === undefined
        ? {}
        : { recordConcurrency: extras.recordConcurrency }),
    ...(extras?.mediaDeadlineMs === undefined ? {} : { mediaDeadlineMs: extras.mediaDeadlineMs }),
    ...(extras?.onConversionOutput === undefined ? {} : { onConversionOutput: extras.onConversionOutput }),
    transport: {
      batchWrite: (request) => port.batch(request),
      setSourceRecordMetadata: (request, signal) => port.setSourceRecordMetadata(request, signal),
      readFence: (tuple) =>
        port.fence({ source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group }),
      writeSourceStatistic: (request, signal) => port.writeSourceStatistic(request, signal),
      clearSourceStatistic: (request, signal) => port.clearSourceStatistic(request, signal),
    },
  });
  const runs: CrossMediaSeedResult['runs'] = {};
  const readings: CrossMediaReading[] = [];
  try {
    const nativeTypes = new Map<string, string>();
    for (const provider of providers) {
      if (!plan.records[provider].length && !plan.entities[provider].length) continue;
      const registration = createSourceRegistration(provider, {
        source: crossMediaAliases[provider],
        converterRevision: entityRevision,
      });
      for (const record of [...plan.records[provider], ...plan.entities[provider]]) {
        const conversion = registration.convert(
          {
            external_id: record.key,
            record_revision: record.revision ?? 'unversioned',
            record: record.payload,
          },
          { source: registration.source },
        );
        const bootstrap = conversion.proposals.find((command) => command.op === 'create');
        if (bootstrap?.op === 'create')
          nativeTypes.set(`${crossMediaAliases[provider]}\u0000${record.key}`, bootstrap.subject.type);
      }
      async function* records() {
        if (extras?.entitiesFirst || (provider === 'vndb' && vndbCredits !== undefined)) {
          yield* plan.entities[provider];
          yield* plan.records[provider];
        } else {
          yield* plan.records[provider];
          yield* plan.entities[provider];
        }
      }
      const run = await importer.runRecords(registration, records());
      ensure(run.status === 'committed', `Cross-media ${provider} import failed: ${run.status}`);
      runs[provider] = run;
    }
    const hasBangumiInput = plan.records.bangumi.length > 0 || plan.entities.bangumi.length > 0;
    const fidelity =
      providers.includes('bangumi') && hasBangumiInput
        ? await runBangumiCharacterFidelity({
            importer,
            port,
            sourceAlias: crossMediaAliases.bangumi,
            records: [...plan.records.bangumi, ...plan.entities.bangumi],
            appearances: plan.characterAppearances ?? [],
            ...(characterBindings === undefined ? {} : { bindings: characterBindings }),
          })
        : undefined;
    if (fidelity) {
      ensure(fidelity.run.status === 'committed', `Bangumi character fidelity import failed: ${fidelity.run.status}`);
      runs.bangumiCharacterFidelity = fidelity.run;
    }
    const graph = new CrossMediaGraph(importer.session.store.database);
    const graphEdges = vndbCredits?.deliveryEdges(plan.edges) ?? plan.edges;
    graph.remember(graphEdges);
    const delivered = await graph.deliver({
      claim: (owner) => importer.session.bindings.claim(owner),
      nativeType: (externalId, alias) => nativeTypes.get(`${alias ?? crossMediaAliases.bangumi}\u0000${externalId}`),
      fence: (input) => port.fence(input),
      batch: (request) => port.batch(request),
      journal: {
        prepare: (command) => {
          const owner = { source: command.source.source, external_id: command.source.external_id };
          const prefix = `${owner.source}:${owner.external_id}:`;
          const keyed = command.key.startsWith(prefix) ? command : { ...command, key: `${prefix}${command.key}` };
          return importer.session.bindings.prepare(owner, sourceDigest([keyed]), { commands: [keyed] });
        },
        acknowledge: (command, result) => {
          const owner = { source: command.source.source, external_id: command.source.external_id };
          importer.session.bindings.acknowledge(owner, command.key, { results: [result] });
        },
      },
      relationSnapshot: {
        currentKeys: graphEdges.filter((edge) => edge.relation).map(graphEdgeKey),
        scope: plan.relationScope,
        digest: plan.relationSnapshotDigest,
        complete: plan.relationSnapshotComplete,
      },
    });
    const bangumiRegistration = createSourceRegistration('bangumi', {
      source: crossMediaAliases.bangumi,
      converterRevision: entityRevision,
    });
    const credits = await deliverBangumiCreatorCredits({
      alias: crossMediaAliases.bangumi,
      converterRevision: entityRevision,
      drafts: plan.credits,
      bindings: extras?.sourceVocabulary ?? { releaseDigest: bundledDigest, schemes: [], concepts: [] },
      claim: (owner) => importer.session.bindings.claim(owner),
      batch: (request) => port.batch(request),
      fence: (tuple) => port.fence(tuple),
      read: (subjectId) => port.readReviewedSubject(subjectId),
      metadataFor: (work) => {
        const record = [...plan.records.bangumi, ...plan.entities.bangumi].find((row) => row.key === work);
        ensure(record, `Missing selected Bangumi work for credit ${work}`);
        const conversion = bangumiRegistration.convert(
          { external_id: record.key, record_revision: record.revision, record: record.payload },
          { source: crossMediaAliases.bangumi },
        );
        return {
          digest: conversion.digest,
          recordRevision: record.revision,
          recordUrl: bangumiRecordUrl(work),
        };
      },
    });
    const selected = [...plan.records.bangumi, ...plan.entities.bangumi, ...plan.records.vndb, ...plan.entities.vndb];
    const lookupKeys = new Map<string, { provider: Provider; externalId: string; selected: boolean }>();
    for (const record of selected) {
      const provider: Provider = record.source === 'vndb' ? 'vndb' : 'bangumi';
      const key = provider + '\u0000' + record.key;
      lookupKeys.set(key, { provider, externalId: record.key, selected: true });
    }
    for (const link of plan.workLinks) {
      if (link.bangumiExternalId === undefined) continue;
      const key = 'bangumi\u0000' + link.bangumiExternalId;
      if (!lookupKeys.has(key))
        lookupKeys.set(key, { provider: 'bangumi', externalId: link.bangumiExternalId, selected: false });
    }
    const currentReads = new Map<string, CurrentWorkRead>();
    const subjectsById = new Map<string, ReviewedSubjectRead>();
    for (const [key, lookup] of lookupKeys) {
      const alias = crossMediaAliases[lookup.provider];
      const claim = importer.session.bindings.claim({ source: alias, external_id: lookup.externalId });
      if (claim?.state !== 'bound') continue;
      let subject = subjectsById.get(claim.subject);
      if (!subject) {
        subject = await port.readReviewedSubject(claim.subject);
        subjectsById.set(claim.subject, subject);
      }
      const current = currentWorkRead(subject);
      if (current) currentReads.set(key, current);
      if (lookup.selected)
        readings.push({
          source: lookup.provider,
          externalId: lookup.externalId,
          subject,
          route: subjectRoute(subject),
          selection: 'selected',
        });
    }
    const workLinks = resolveShowcaseWorkLinkHandoffs(plan.workLinks, currentReads);
    const bangumiGenrePublication =
      genreAdapter && providers.includes('bangumi')
        ? await prepareShowcaseBangumiGenres({
            sourceAlias: crossMediaAliases.bangumi,
            records: plan.records.bangumi,
            bindings: importer.session.bindings,
            port: extras!.bangumiGenrePort!,
            lookupDiagnostics: genreAdapter.diagnostics(),
          })
        : undefined;
    const unresolved = delivered.unresolved.map((edge) => ({
      holder: edge.holder,
      target: edge.target,
      property: edge.property,
      reason: edge.reason,
    }));
    return {
      status:
        plan.gaps.length ||
        delivered.gaps.length ||
        unresolved.length ||
        credits.gaps.length ||
        credits.fenced.length ||
        (vndbCredits?.diagnostics.length ?? 0) ||
        (fidelity?.gaps.length ?? 0) ||
        episodeDiagnostics.length
          ? ('imported-with-gaps' as const)
          : ('imported' as const),
      franchises: plan.franchises,
      members: plan.members,
      runs,
      readings,
      workLinks,
      gaps: [
        ...plan.gaps,
        ...delivered.gaps.map((gap) => ({
          source: (gap.table === 'producers_relations' ? 'vndb' : 'bangumi') as Provider,
          fields: fieldsOf(gap.table ?? 'subject-relations', gap.record),
          record: gap.record,
          reason: gap.reason,
          ...(gap.code === undefined ? {} : { code: gap.code }),
          ...(gap.endpoint === undefined ? {} : { endpoint: gap.endpoint }),
          ...(gap.property === undefined ? {} : { property: gap.property }),
          ...(gap.requiredProfile === undefined ? {} : { requiredProfile: gap.requiredProfile }),
        })),
      ],
      creditGaps: credits.gaps,
      vndbCreditDiagnostics: vndbCredits?.diagnostics ?? [],
      vndbCreditVocabularyRequirements: vndbCredits?.requirements ?? [],
      characterDiagnostics: fidelity?.gaps ?? [],
      episodeDiagnostics,
      unresolved,
      ...(bangumiGenrePublication ? { bangumiGenrePublication } : {}),
    };
  } finally {
    await importer.close();
  }
}

export type CrossMediaSeedCliOptions = {
  episodeCatalogueSubjects?: Readonly<Record<string, string>>;
};

export async function runCrossMediaSeedCli(
  argv: readonly string[],
  options: CrossMediaSeedCliOptions = {},
): Promise<void> {
  const optionalFlags = [
    '--bangumi-character-bindings',
    '--vndb-public-tag-bindings',
    '--showcase-state',
    '--vndb-credit-bindings',
  ];
  const requiredFlags = [
    '--bangumi',
    '--vndb',
    '--state',
    '--result',
    '--api',
    '--auth',
    '--account-key',
    '--account',
    '--client',
  ];
  const flags = [...requiredFlags, ...optionalFlags];
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(
      `Usage: bun scripts/datasets/cross-media-seed.ts ${requiredFlags
        .map((flag) => `${flag} <value>`)
        .join(
          ' ',
        )} [--bangumi-character-bindings <json>] [--vndb-public-tag-bindings <json>] [--showcase-state <sqlite>] [--vndb-credit-bindings <json>]\n`,
    );
    return;
  }
  ensure(
    argv.length % 2 === 0 && argv.length >= requiredFlags.length * 2,
    'Expected explicit cross-media seed configuration',
  );
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!,
      value = argv[i + 1]!;
    ensure(
      flags.includes(flag) && !values.has(flag) && value && value.length <= 4096 && !value.includes('\0'),
      'Invalid seed option',
    );
    values.set(flag, value);
  }
  for (const flag of requiredFlags) ensure(values.has(flag), `Missing seed option: ${flag}`);
  const api = normalizeCrossMediaSeedOrigin(values.get('--api')!),
    auth = normalizeCrossMediaSeedOrigin(values.get('--auth')!);
  const input = new CrossMediaDumpFiles(values.get('--bangumi')!, values.get('--vndb')!);
  const plan = await planCrossMediaSeed(input);
  const showcasePath = values.has('--showcase-state') ? resolve(values.get('--showcase-state')!) : undefined;
  const { seedShowcaseVndbReleases } = await import('./showcase-vndb-releases.ts');
  const tokenProvider = await createAccountTokenProvider({
    accountKeyPath: values.get('--account-key')!,
    account: values.get('--account')!,
    client: values.get('--client')!,
    authOrigin: auth,
    scopes: [
      ...VNDB_IMPORTER_SCOPES,
      'subject:read',
      ...(showcasePath ? (['context:accept', 'context:adopt'] as const) : []),
    ],
  });
  const resultPath = resolve(values.get('--result')!);
  const statePath = resolve(values.get('--state')!);
  const characterBindingsPath = values.has('--bangumi-character-bindings')
    ? resolve(values.get('--bangumi-character-bindings')!)
    : undefined;
  const tagBindingsPath = values.has('--vndb-public-tag-bindings')
    ? resolve(values.get('--vndb-public-tag-bindings')!)
    : undefined;
  const explicitCreditBindingsPath = values.has('--vndb-credit-bindings')
    ? resolve(values.get('--vndb-credit-bindings')!)
    : undefined;
  const defaultCreditBindingsPath = resolve('.temp/cross-media-seed/vndb-credit-bindings.json');
  const creditBindingsPath =
    explicitCreditBindingsPath ?? (existsSync(defaultCreditBindingsPath) ? defaultCreditBindingsPath : undefined);
  const showcaseConflictPaths = [statePath, resultPath, characterBindingsPath, tagBindingsPath, creditBindingsPath]
    .filter((path): path is string => path !== undefined)
    .flatMap((path) => [path, `${path}-wal`, `${path}-shm`]);
  for (const extra of [characterBindingsPath, tagBindingsPath, creditBindingsPath]) {
    ensure(
      extra === undefined ||
        (extra !== resultPath && extra !== statePath && ![`${statePath}-wal`, `${statePath}-shm`].includes(extra)),
      'Seed binding files must not overlap importer state or result',
    );
  }
  let characterBindings: SourceVocabularyBindings | undefined;
  if (characterBindingsPath) {
    const bytes = await readFile(characterBindingsPath);
    ensure(bytes.byteLength <= 256 * 1024, 'Bangumi character bindings exceed the configuration limit');
    characterBindings = JSON.parse(bytes.toString('utf8')) as SourceVocabularyBindings;
  }
  let vndbCreditReferences: VndbCreditVocabularyReferences | undefined;
  if (creditBindingsPath) {
    const bytes = await readFile(creditBindingsPath);
    ensure(bytes.byteLength <= 256 * 1024, 'VNDB credit bindings exceed the configuration limit');
    vndbCreditReferences = JSON.parse(bytes.toString('utf8')) as VndbCreditVocabularyReferences;
  }
  ensure(
    resultPath !== statePath && ![`${statePath}-wal`, `${statePath}-shm`].includes(resultPath),
    'Result must not overwrite importer state',
  );
  ensure(!showcasePath || !showcaseConflictPaths.includes(showcasePath), 'Showcase state must not overlap seed files');
  await mkdir(dirname(statePath), { recursive: true });
  const importPort = createImportTransport({ origin: api, tokenProvider });
  const journal = showcasePath ? new ShowcaseJournal(showcasePath) : undefined;
  const port = journal ? captureShowcaseCommands(importPort, journal) : importPort;
  try {
    const result = await seedShowcaseVndbReleases({
      tables: input,
      plan,
      path: statePath,
      port,
      destination: { origin: api },
      extras: {
        ...(vndbCreditReferences ? { vndbCreditReferences } : {}),
        ...(options.episodeCatalogueSubjects ? { episodeCatalogueSubjects: options.episodeCatalogueSubjects } : {}),
        bangumiGenrePort: importPort,
      },
      ...(characterBindings === undefined ? {} : { characterBindings }),
    });
    const { importShowcaseTags, parseShowcaseTagKnownBindings } = await import('./showcase-tags.ts');
    let knownTagBindings = parseShowcaseTagKnownBindings({ schemes: [], concepts: [] });
    if (tagBindingsPath) {
      const bytes = await readFile(tagBindingsPath);
      ensure(bytes.byteLength <= 256 * 1024, 'VNDB public tag bindings exceed the configuration limit');
      knownTagBindings = parseShowcaseTagKnownBindings(JSON.parse(bytes.toString('utf8')));
    }
    const selectedVids = plan.members
      .filter((member) => member.source === 'vndb' && member.kind === 'work')
      .map((member) => member.key);
    const publicTags = await importShowcaseTags({
      tables: input,
      selectedVids,
      path: statePath,
      port,
      known: knownTagBindings,
      destination: { origin: api },
    });
    const showcase = journal
      ? await publishShowcase({
          plan,
          result,
          aliases: crossMediaAliases,
          journal,
          review: importPort,
          publicClient: createPublicBulkClient({ origin: api }),
        })
      : undefined;
    const { bangumiGenrePublication, ...publicResult } = result;
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(
      resultPath,
      `${JSON.stringify(
        {
          ...publicResult,
          facts: {
            works: Object.fromEntries(result.facts.works),
            releases: Object.fromEntries(result.facts.releases),
          },
          ...(bangumiGenrePublication ? { bangumiGenreDiagnostics: bangumiGenrePublication.diagnostics } : {}),
          ...(showcase ? { showcase } : {}),
          publicTags: {
            admitted: publicTags.admitted,
            vocabulary: publicTags.vocabulary,
            weightGap: publicTags.weightGap,
            truncated: publicTags.truncated,
            adoptedConcepts: publicTags.bindings.concepts.map((item) => item.code),
            gaps: publicTags.gaps,
          },
          sourceDigests: Object.fromEntries(input.digests),
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(
      showcase
        ? `Imported ${result.readings.length} records; publication ${showcase.status}; ${showcase.omissions.length} bounded omissions. Result: ${resultPath}\n`
        : `Imported ${result.readings.length} records; ${result.gaps.length + result.characterDiagnostics.length + result.vndbCreditDiagnostics.length + result.episodeDiagnostics.length + publicTags.gaps.length} review gaps. Result: ${resultPath}\n`,
    );
    ensure(
      !showcase || showcase.status === 'published',
      'Showcase publication is incomplete; rerun task seed:dev after resolving the listed gaps',
    );
  } finally {
    journal?.close();
  }
}
