import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import { sourceVocabularyLimits } from '@rezics/conversion/source-vocabulary';
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
import { sourceDigest, sourceWebsiteUrl } from '../../../packages/conversion/src/support.ts';
import { createAccountTokenProvider, VNDB_IMPORTER_SCOPES } from './credentials.ts';
import {
  CrossMediaGraph,
  citedProviderBinding,
  combineSourceVocabularyRequests,
  graphEdgeKey,
  type GraphEdgeDraft,
} from './cross-media-bindings.ts';
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
  prepareShowcaseVndbCredits,
  prepareShowcaseVndbCreditVocabulary,
  publishedShowcaseVndbCreditReferences,
  type VndbCreditVocabularyReferences,
  type VndbCreditVocabularyRequirement,
} from './showcase-vndb-credits.ts';
import type { VndbCreditVocabularyReadFailure } from './vndb-staff-credits.ts';
import {
  parseVndbCharacterProfileReferences,
  planVndbCharacterProfile,
  prepareShowcaseVndbCharacterProfileVocabulary,
  readShowcaseVndbCharacterProfileVocabulary,
  readVndbCharacterProfileBindings,
  vndbCharacterProfileAdmission,
  type VndbCharacterProfileReferences,
} from './vndb-character-profile.ts';
import { createImportTransport, type ReviewedSubjectRead } from './import-client.ts';
import { createPublicBulkClient } from './public-bulk-client.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
  type ShowcasePublicationResult,
} from './showcase-publication.ts';
import {
  prepareShowcaseBangumiSelectedCharacterVocabulary,
  readShowcaseBangumiSelectedCharacterVocabulary,
} from './showcase-bangumi-game-characters.ts';
import {
  createImporter,
  type ImporterOptions,
  type ImportIdentifierResolution,
  type ImportRunResult,
} from './importer.ts';
import { createMediaResolver } from './media-resolver.ts';
import type { BangumiCoverSource, CrossMediaMediaOutcome } from './showcase-media.ts';
import { acquireBangumiCoverSources } from './showcase-media.ts';
import {
  createSelectedFamilySourceRegistration,
  createSourceRegistration,
  crossMediaBangumiRevision,
} from './source-registry.ts';
import { runBangumiCharacterFidelity } from './bangumi-character-fidelity.ts';
import { VNDB_PUBLIC_TAG_COLUMNS } from './vndb-tables.ts';
import {
  planVndbReleasePlatforms,
  vndbReleaseAssociationReleaseCap,
  vndbReleasePlatformPayload,
  type VndbReleasePlatformFacts,
} from './vndb-release-platforms.ts';
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
import {
  createShowcaseBangumiGameEnvironmentLookup,
  mergeIdentifierResolutions,
  type BangumiGameEnvironmentBinding,
} from './showcase-bangumi-game-environment.ts';
import type { ReviewedCataloguePort } from './reviewed-catalogue.ts';
import {
  combineBangumiCreditBindings,
  currentBangumiCreatorCreditBindings,
  prepareBangumiCreatorCreditBindings,
  type BangumiCreditRoleBinding,
  type BangumiCreditVocabularyResolution,
} from './showcase-bangumi-credits.ts';
import { showcaseLimits, type ShowcaseManifest } from './showcase-manifest.ts';

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
const SHOWCASE_PEOPLE_PER_PROVIDER = 64;
const CREDIT_ASSOCIATIONS_PER_WORK = 64;
const CREDIT_ASSOCIATIONS = 8192;
const RELATION_CAP = 4096;
const APPEARANCE_ROW_BYTES = 16 * 1024;
const APPEARANCE_EVIDENCE_BYTES = 4 * 1024 * 1024;

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
  roleCode: unknown;
  order?: number | string | null;
  sourceRow?: Readonly<Record<string, unknown>>;
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
  /** Actual selected type-2 anime appearances. */
  characterAppearances?: BangumiCharacterAppearance[];
  /** Actual selected type-4 Game appearances, kept separate from anime. */
  gameCharacterAppearances?: BangumiCharacterAppearance[];
  gaps: CrossMediaGap[];
  relationScope: string[];
  relationSnapshotDigest: string;
  relationSnapshotComplete: boolean;
  /** Selected-family VNDB release dates/states for the common showcase publisher. */
  releaseFacts?: CrossMediaReleaseFacts;
  /** Exact selected VNDB release platform and medium rows for source-vocabulary admission. */
  releasePlatforms?: ReadonlyMap<string, VndbReleasePlatformFacts>;
  coverSources?: readonly BangumiCoverSource[];
};
const VNDB_EXPECTED_HEADERS: Readonly<Record<string, string>> = {
  chars:
    'id\timage\tbloodt\tcup_size\tsex\tspoil_sex\tgender\tspoil_gender\tmain\tmain_spoil\ts_bust\ts_waist\ts_hip\tbirthday\theight\tweight\tage\tdescription',
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
    gameCharacterAppearances: [],
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
export type CrossMediaSelection = {
  bangumi: readonly number[];
  vndb: readonly string[];
  includeReleases?: boolean;
  peoplePerProvider?: number;
};

export async function planCrossMediaSeed(
  input: CrossMediaTables,
  options: { deferVndbCharacterAppearances?: boolean; selection?: CrossMediaSelection } = {},
): Promise<CrossMediaPlan> {
  const selection = options.selection;
  if (selection) {
    ensure(
      selection.bangumi.length > 0 &&
        new Set(selection.bangumi).size === selection.bangumi.length &&
        selection.bangumi.every((id) => Number.isSafeInteger(id) && id > 0),
      'Invalid selected Bangumi work identities',
    );
    ensure(
      selection.vndb.length > 0 &&
        new Set(selection.vndb).size === selection.vndb.length &&
        selection.vndb.every((id) => /^v[1-9][0-9]*$/u.test(id)),
      'Invalid selected VNDB work identities',
    );
    if (selection.peoplePerProvider !== undefined)
      ensure(
        Number.isSafeInteger(selection.peoplePerProvider) &&
          selection.peoplePerProvider > 0 &&
          selection.peoplePerProvider <= SHOWCASE_PEOPLE_PER_PROVIDER,
        'Selected people limit must be between 1 and 64',
      );
  }
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
    if (selection && !selection.bangumi.includes(id)) continue;
    ensure(!types.has(id), 'Duplicate selected Bangumi subject');
    types.set(id, row.type as number);
    const family = crossMediaFranchise(row.name, row.name_cn);
    if (family) titled.set(id, family);
  }
  const familyIds = new Map<number, Franchise>(titled);
  const referencedWorks = new Map<number, Franchise>();
  let grew = selection === undefined;
  while (grew) {
    grew = false;
    for await (const row of input.rows('bangumi', 'subject-relations')) {
      const sid = number(row, 'subject_id');
      const rid = number(row, 'related_subject_id');
      if (selection && (!familyIds.has(sid) || !familyIds.has(rid))) continue;
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
    if (selection && (!familyIds.has(sid) || !familyIds.has(rid))) continue;
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
          ...(typeof row.order === 'number' && Number.isSafeInteger(row.order) ? { order: row.order } : {}),
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
  const importedWorks = new Set([...plan.records.bangumi, ...plan.entities.bangumi].map((record) => record.key));
  const selectedAnimeWorks = new Set(
    [...plan.records.bangumi, ...plan.entities.bangumi]
      .filter((record) => record.payload && typeof record.payload === 'object' && record.payload.type === 2)
      .map((record) => record.key),
  );
  const selectedGameWorks = new Set(
    [...plan.records.bangumi, ...plan.entities.bangumi]
      .filter(
        (record) =>
          record.payload &&
          typeof record.payload === 'object' &&
          record.payload.type === 4 &&
          familyIds.has(Number(record.key)),
      )
      .map((record) => record.key),
  );
  const admittedAppearanceIndices = new Set<number>();
  const appearanceCounts = new Map<number, number>();
  const admittedGameAppearanceIndices = new Set<number>();
  const gameAppearanceCounts = new Map<number, number>();
  const gameAppearancePairs = new Set<string>();
  const admittedStaffIndices = new Set<number>();
  const admittedVoiceIndices = new Set<number>();
  const staffCounts = new Map<number, number>();
  const voiceCounts = new Map<number, number>();
  const staffOverflow = new Set<number>();
  const voiceOverflow = new Set<number>();
  const appearanceOverflow = new Set<number>();
  const gameAppearanceOverflow = new Set<number>();
  let appearanceEvidenceBytes = 0;
  let selectionIndex = 0;
  for await (const row of input.rows('bangumi', 'subject-characters')) {
    const sourceIndex = selectionIndex++;
    const subjectId = number(row, 'subject_id');
    const characterId = number(row, 'character_id');
    const work = String(subjectId);
    if (familyWorks.has(subjectId) && !selectedAnimeWorks.has(work) && !selectedGameWorks.has(work))
      characters.add(characterId);
    if (selectedAnimeWorks.has(work)) {
      const count = (appearanceCounts.get(subjectId) ?? 0) + 1;
      appearanceCounts.set(subjectId, count);
      if (count > 64) {
        if (!appearanceOverflow.has(subjectId)) {
          gap(
            'bangumi',
            'subject-characters',
            { subject_id: subjectId, character_id: characterId },
            'Per-work character appearance mapping limit exceeded',
          );
          appearanceOverflow.add(subjectId);
        }
        continue;
      }
      const rowBytes = Buffer.byteLength(JSON.stringify(row));
      if (rowBytes > APPEARANCE_ROW_BYTES || appearanceEvidenceBytes + rowBytes > APPEARANCE_EVIDENCE_BYTES) {
        if (!appearanceOverflow.has(subjectId)) {
          gap(
            'bangumi',
            'subject-characters',
            { subject_id: subjectId, character_id: characterId },
            'Selected character appearance evidence exceeds its bounded byte limit',
          );
          appearanceOverflow.add(subjectId);
        }
        continue;
      }
      appearanceEvidenceBytes += rowBytes;
      characters.add(characterId);
      admittedAppearanceIndices.add(sourceIndex);
      continue;
    }
    if (!selectedGameWorks.has(work)) continue;
    const count = (gameAppearanceCounts.get(subjectId) ?? 0) + 1;
    gameAppearanceCounts.set(subjectId, count);
    if (count > 64) {
      if (!gameAppearanceOverflow.has(subjectId)) {
        gap(
          'bangumi',
          'subject-characters',
          { subject_id: subjectId, character_id: characterId },
          'Per-game character appearance mapping limit exceeded',
        );
        gameAppearanceOverflow.add(subjectId);
      }
      continue;
    }
    const rowBytes = Buffer.byteLength(JSON.stringify(row));
    if (rowBytes > APPEARANCE_ROW_BYTES || appearanceEvidenceBytes + rowBytes > APPEARANCE_EVIDENCE_BYTES) {
      if (!gameAppearanceOverflow.has(subjectId)) {
        gap(
          'bangumi',
          'subject-characters',
          { subject_id: subjectId, character_id: characterId },
          'Selected Game character appearance evidence exceeds its bounded byte limit',
        );
        gameAppearanceOverflow.add(subjectId);
      }
      continue;
    }
    appearanceEvidenceBytes += rowBytes;
    characters.add(characterId);
    admittedGameAppearanceIndices.add(sourceIndex);
    gameAppearancePairs.add(`${subjectId}\0${characterId}`);
  }
  let staffIndex = 0;
  for await (const row of input.rows('bangumi', 'subject-persons')) {
    const sourceIndex = staffIndex++;
    const subjectId = number(row, 'subject_id');
    if (!familyWorks.has(subjectId)) continue;
    const count = (staffCounts.get(subjectId) ?? 0) + 1;
    staffCounts.set(subjectId, count);
    if (count > CREDIT_ASSOCIATIONS_PER_WORK || admittedStaffIndices.size >= CREDIT_ASSOCIATIONS) {
      staffOverflow.add(subjectId);
      continue;
    }
    admittedStaffIndices.add(sourceIndex);
    persons.add(number(row, 'person_id'));
  }
  let voiceIndex = 0;
  for await (const row of input.rows('bangumi', 'person-characters')) {
    const sourceIndex = voiceIndex++;
    const subjectId = number(row, 'subject_id');
    if (!familyWorks.has(subjectId)) continue;
    const characterId = number(row, 'character_id');
    const count = (voiceCounts.get(subjectId) ?? 0) + 1;
    voiceCounts.set(subjectId, count);
    if (count > CREDIT_ASSOCIATIONS_PER_WORK || admittedVoiceIndices.size >= CREDIT_ASSOCIATIONS) {
      voiceOverflow.add(subjectId);
      continue;
    }
    if (
      selectedGameWorks.has(String(subjectId)) &&
      (gameAppearanceOverflow.has(subjectId) || !gameAppearancePairs.has(`${subjectId}\0${characterId}`))
    )
      continue;
    admittedVoiceIndices.add(sourceIndex);
    persons.add(number(row, 'person_id'));
    characters.add(characterId);
  }
  for (const subjectId of staffOverflow)
    plan.gaps.push({
      source: 'bangumi',
      fields: ['person_id', 'position', 'subject_id'],
      record: { subject_id: subjectId },
      reason: 'Per-work subject-person credit limit exceeded',
      property: 'schema:contributor',
    });
  for (const subjectId of voiceOverflow)
    plan.gaps.push({
      source: 'bangumi',
      fields: ['character_id', 'person_id', 'subject_id'],
      record: { subject_id: subjectId },
      reason: 'Per-work person-character credit limit exceeded',
      property: 'wdt:P725',
    });
  let appearanceIndex = 0;
  for await (const row of input.rows('bangumi', 'subject-characters')) {
    const sourceIndex = appearanceIndex++;
    const subjectId = number(row, 'subject_id');
    const characterId = number(row, 'character_id');
    const work = String(subjectId);
    if (selectedGameWorks.has(work)) {
      if (
        !admittedGameAppearanceIndices.has(sourceIndex) ||
        gameAppearanceOverflow.has(subjectId) ||
        !characters.has(characterId)
      )
        continue;
      const character = `character:${characterId}`;
      member({
        source: 'bangumi',
        key: character,
        kind: 'character',
        membership: 'family',
        ...tagged(familyIds.get(subjectId)),
      });
      (plan.gameCharacterAppearances ??= []).push({
        subjectId: work,
        characterId,
        sourceIndex,
        roleCode: row.type,
        sourceRow: Object.freeze({ ...row }),
        ...(row.order === undefined
          ? {}
          : {
              order:
                typeof row.order === 'number' || typeof row.order === 'string' || row.order === null ? row.order : -1,
            }),
      });
      continue;
    }
    if (!admittedAppearanceIndices.has(sourceIndex) || !selectedAnimeWorks.has(work) || !characters.has(characterId))
      continue;
    const character = `character:${characterId}`;
    member({
      source: 'bangumi',
      key: character,
      kind: 'character',
      membership: familyWorks.has(number(row, 'subject_id')) ? 'family' : 'referenced',
      ...tagged(familyIds.get(number(row, 'subject_id'))),
    });
    const roleCode = row.type;
    (plan.characterAppearances ??= []).push({
      subjectId: work,
      characterId,
      sourceIndex,
      roleCode,
      sourceRow: Object.freeze({ ...row }),
      ...(row.order === undefined
        ? {}
        : {
            order:
              typeof row.order === 'number' || typeof row.order === 'string' || row.order === null ? row.order : -1,
          }),
    });
  }
  let currentStaffIndex = 0;
  for await (const row of input.rows('bangumi', 'subject-persons')) {
    const sourceIndex = currentStaffIndex++;
    if (!admittedStaffIndices.has(sourceIndex)) continue;
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
      ...(row.creditedAs === undefined ? {} : { creditedAs: row.creditedAs as string }),
      path: `/subject-persons/${work}/${personId}/position`,
      record: row,
    });
  }
  let currentVoiceIndex = 0;
  for await (const row of input.rows('bangumi', 'person-characters')) {
    const sourceIndex = currentVoiceIndex++;
    if (!admittedVoiceIndices.has(sourceIndex)) continue;
    const subjectId = number(row, 'subject_id');
    if (!familyWorks.has(subjectId)) continue;
    const work = String(subjectId);
    const personId = number(row, 'person_id');
    const characterId = number(row, 'character_id');
    if (
      selectedGameWorks.has(work) &&
      (gameAppearanceOverflow.has(subjectId) || !gameAppearancePairs.has(`${subjectId}\0${characterId}`))
    )
      continue;
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
      ...(row.creditedAs === undefined ? {} : { creditedAs: row.creditedAs as string }),
      path: `/person-characters/${work}/${personId}/${characterId}`,
      record: row,
    });
  }
  const corePersons = new Set(persons),
    coreCharacters = new Set(characters);
  for await (const row of input.rows('bangumi', 'person-relations')) {
    if (selection) continue;
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
    if (selection && !selection.vndb.includes(text(row, 'id'))) continue;
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
  let vnGrew = selection === undefined;
  while (vnGrew) {
    vnGrew = false;
    for await (const row of input.rows('vndb', 'vn_relations')) {
      const id = text(row, 'id');
      const vid = text(row, 'vid');
      if (selection && (!vnFamily.has(id) || !vnFamily.has(vid))) continue;
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
    if (selection && (!vnIds.has(id) || !vnIds.has(vid))) continue;
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
  let releaseOverflowReported = false;
  for await (const row of input.rows('vndb', 'releases_vn')) {
    if (selection?.includeReleases === false || !vnIds.has(text(row, 'vid'))) continue;
    const id = text(row, 'id');
    if (releases.has(id)) continue;
    if (releases.size >= vndbReleaseAssociationReleaseCap) {
      if (!releaseOverflowReported) {
        gap('vndb', 'releases_vn', { id }, 'Selected VNDB releases exceed the bounded import cap');
        releaseOverflowReported = true;
      }
      continue;
    }
    releases.add(id);
  }
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
    if (!options.deferVndbCharacterAppearances) {
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
    }
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
  let producerGrew = selection === undefined;
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
    if (selection && (!producers.has(id) || !producers.has(pid))) continue;
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
  const invalidWebsites = new Set<number>();
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
    if (site === 'website') {
      try {
        sourceWebsiteUrl(value);
      } catch {
        invalidWebsites.add(id);
        gap('vndb', 'extlinks', { id, site }, 'Invalid external website URL; omitted from native facts');
      }
    }
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
    joins: new Map(
      [...workJoins].map(([owner, joins]) => [owner, joins.filter((join) => !invalidWebsites.has(join.join.link))]),
    ),
    dictionary: workDictionary,
  });
  plan.records.vndb = workProjection.records;
  plan.workLinks = workProjection.links;
  plan.edges.push(...workProjection.edges);
  for (const missing of workProjection.gaps) gap('vndb', 'vn_extlinks', missing.record, missing.reason);
  for (const entity of plan.entities.vndb) {
    const entry = entityJoins.get(entity.key);
    if (!entry) continue;
    const joins = entry.joins.filter((join) => !invalidWebsites.has(join.link));
    const missing = joins.filter((join) => !dictionary.has(join.link));
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
    const extlinks = joins.map((join) => {
      const row = dictionary.get(join.link);
      ensure(row, 'Selected VNDB external-link dictionary row disappeared during projection');
      return { id: row.id, site: row.site, value: row.value };
    });
    entity.payload = { ...(entity.payload as object), [entry.table]: joins, extlinks };
  }

  if (selection) {
    const peopleLimit = selection.peoplePerProvider ?? SHOWCASE_PEOPLE_PER_PROVIDER;
    for (const provider of ['bangumi', 'vndb'] as const) {
      let people = 0;
      const omitted = new Set<string>();
      plan.entities[provider] = [...plan.entities[provider]]
        .sort((left, right) => left.key.localeCompare(right.key))
        .filter((row) => {
          const isPerson = provider === 'bangumi' ? row.key.startsWith('person:') : /^[sp][1-9][0-9]*$/u.test(row.key);
          if (!isPerson || people++ < peopleLimit) return true;
          omitted.add(row.key);
          gap(provider, 'people', { id: row.key }, 'Development showcase people limit exceeded');
          return false;
        });
      plan.members = plan.members.filter((row) => row.source !== provider || !omitted.has(row.key));
      plan.edges = plan.edges.filter(
        (row) => row.source !== provider || (!omitted.has(row.holder) && !omitted.has(row.target)),
      );
      if (provider === 'bangumi') plan.credits = plan.credits.filter((row) => !omitted.has(row.person));
    }
    for (const id of selection.bangumi)
      ensure(
        [...plan.records.bangumi, ...plan.entities.bangumi].some((row) => row.key === String(id)),
        `Missing selected Bangumi work: ${id}`,
      );
    for (const id of selection.vndb)
      ensure(
        plan.records.vndb.some((row) => row.key === id),
        `Missing selected VNDB work: ${id}`,
      );
    ensure(
      plan.records.bangumi.length +
        plan.entities.bangumi.length +
        plan.records.vndb.length +
        plan.entities.vndb.length <=
        showcaseLimits.records,
      'Selected showcase record limit exceeded',
    );
  } else {
    for (const family of Object.keys(patterns) as Franchise[])
      ensure(anime.has(family) && plan.franchises[family].vndb.length, `Missing anime/VN pair for ${family}`);
  }
  const selectedReleaseIds = plan.entities.vndb
    .map((row) => row.key)
    .filter((id) => /^r[1-9][0-9]*$/u.test(id))
    .sort();
  const selectedReleaseSet = new Set(selectedReleaseIds);
  const releaseLinks = new Map<string, number>();
  for (const draft of plan.edges)
    if (draft.source === 'vndb' && draft.table === 'releases_vn' && selectedReleaseSet.has(draft.holder))
      releaseLinks.set(draft.holder, (releaseLinks.get(draft.holder) ?? 0) + 1);
  const availableVocabularyRows = new Map(
    selectedReleaseIds.map((id) => [id, Math.max(0, sourceVocabularyLimits.rows - 1 - (releaseLinks.get(id) ?? 0))]),
  );
  const releasePlatformPlan = await planVndbReleasePlatforms(input, selectedReleaseIds, availableVocabularyRows);
  plan.releasePlatforms = releasePlatformPlan.byRelease;
  plan.gaps.push(...releasePlatformPlan.gaps);
  for (const row of plan.entities.vndb) {
    const facts = releasePlatformPlan.byRelease.get(row.key);
    if (!facts) continue;
    row.payload = { ...(row.payload as object), ...vndbReleasePlatformPayload(row.key, facts) };
  }
  for (const provider of ['bangumi', 'vndb'] as const) {
    const registration = createSourceRegistration(provider, {
      source: crossMediaAliases[provider],
      converterRevision: provider === 'bangumi' ? crossMediaBangumiRevision : entityRevision,
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
> &
  Partial<Pick<ReturnType<typeof createImportTransport>, 'requestMedia' | 'mediaStatus'>>;
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
  mediaOutcomes: CrossMediaMediaOutcome[];
  workLinks: ShowcaseWorkLinkHandoff[];
  gaps: CrossMediaGap[];
  creditGaps: BangumiCreatorCreditGap[];
  vndbCreditDiagnostics: SourceVocabularyGap[];
  vndbCreditVocabularyRequirements: VndbCreditVocabularyRequirement[];
  vndbCreditVocabularyUnavailable: VndbCreditVocabularyReadFailure[];
  creditRoles?: readonly BangumiCreditRoleBinding[];
  creditVocabularyRequirements?: BangumiCreditVocabularyResolution['requirements'];
  vndbCharacterProfileRequirements: ReturnType<typeof planVndbCharacterProfile>['requirements'];
  vndbCharacterProfileOmissions: ReturnType<typeof planVndbCharacterProfile>['omissions'];
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
  vndbCharacterProfileBindings?: SourceVocabularyBindings;
  providers?: readonly Provider[];
  mediaDeadlineMs?: ImporterOptions['mediaDeadlineMs'];
  onConversionOutput?: ImporterOptions['onConversionOutput'];
  /** The ordinary CLI supplies its existing authenticated read port. */
  bangumiGenrePort?: ReviewedCataloguePort;
  /** Reviewed Game platform/engine Concepts; UUID/label values are lookup hints only. */
  bangumiGameEnvironment?: { readonly bindings: readonly BangumiGameEnvironmentBinding[] };
  readPublicSubject?: (subjectId: string) => Promise<ReviewedSubjectRead>;
  prepareBangumiCreatorCreditBindings?: (input: {
    plan: CrossMediaPlan;
    result: CrossMediaSeedResult;
    drafts: readonly BangumiCreatorCreditDraft[];
    read(subjectId: string): Promise<ReviewedSubjectRead | null>;
  }) => Promise<BangumiCreditVocabularyResolution>;
};

function bangumiSourceIdentity(key: string): { property: string; value: string } | undefined {
  if (key.startsWith('person:')) return { property: 'wdt:P6298', value: key.slice('person:'.length) };
  if (key.startsWith('character:')) return { property: 'wdt:P6296', value: key.slice('character:'.length) };
  if (key.startsWith('episode:')) return { property: 'schema:url', value: bangumiRecordUrl(key) };
  if (/^[1-9][0-9]*$/u.test(key)) return { property: 'wdt:P5732', value: key };
  return undefined;
}

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
    ? await prepareShowcaseVndbCredits(plan, port, extras?.vndbCreditReferences, extras?.readPublicSubject)
    : undefined;
  const characterProfile = providers.includes('vndb') ? planVndbCharacterProfile(plan) : undefined;
  const characterProfileAdmission =
    characterProfile === undefined
      ? undefined
      : vndbCharacterProfileAdmission(
          characterProfile,
          extras?.vndbCharacterProfileBindings ?? { releaseDigest: bundledDigest, schemes: [], concepts: [] },
        );
  const existingAdmission =
    extras?.vocabularyAdmission || vndbCredits || characterProfileAdmission
      ? {
          request(context: Parameters<NonNullable<NonNullable<ImporterOptions['vocabularyAdmission']>['request']>>[0]) {
            return combineSourceVocabularyRequests([
              extras?.vocabularyAdmission?.request?.(context),
              vndbCredits?.vocabularyAdmission.request?.(context),
              characterProfileAdmission?.request?.(context),
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
  let gameEnvironmentAdapter: ReturnType<typeof createShowcaseBangumiGameEnvironmentLookup> | undefined;
  const identifierLookup =
    extras?.bangumiGenrePort || extras?.bangumiGameEnvironment
      ? {
          async resolve(input: Parameters<NonNullable<ImporterOptions['identifierLookup']>['resolve']>[0]) {
            const parts: ImportIdentifierResolution[] = [];
            if (extras?.bangumiGenrePort) {
              genreAdapter ??= createShowcaseBangumiGenreLookup(
                crossMediaAliases.bangumi,
                importer.session.bindings,
                extras.bangumiGenrePort,
              );
              parts.push(await genreAdapter.lookup.resolve(input));
            }
            if (extras?.bangumiGameEnvironment) {
              gameEnvironmentAdapter ??= createShowcaseBangumiGameEnvironmentLookup({
                sourceAlias: crossMediaAliases.bangumi,
                bindings: extras.bangumiGameEnvironment.bindings,
                read: async (id) => {
                  try {
                    return await port.readReviewedSubject(id);
                  } catch {
                    return null;
                  }
                },
              });
              parts.push(await gameEnvironmentAdapter.resolve(input));
            }
            return mergeIdentifierResolutions(parts);
          },
        }
      : undefined;
  const importerOptions: ImporterOptions = {
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
  };
  importer = createImporter(importerOptions);
  const runs: CrossMediaSeedResult['runs'] = {};
  const readings: CrossMediaReading[] = [];
  const mediaAttempts = new Map<string, CrossMediaMediaOutcome>();
  const onlyPendingBangumiCovers = (provider: Provider, result: ImportRunResult): boolean => {
    if (
      provider !== 'bangumi' ||
      result.status !== 'bulk-failed' ||
      result.diagnostic !== 'Durable operations remain unresolved' ||
      !result.runId
    )
      return false;
    const alias = crossMediaAliases.bangumi;
    const store = importer.session.store;
    const active = store.peekActive(alias);
    if (!active || active.run.id !== result.runId || active.status !== 'ready') return false;
    const resume = store.stagingResumeState(active.run);
    if (resume.status !== 'ready' || resume.pending || !resume.covers || store.hasUnresolvedAggregates(active.run))
      return false;
    const coverKeys = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const page = store.pageDeferredCovers(active.run, { ...(after ? { after } : {}), limit: 100 });
      for (const deferred of page) {
        const key = deferred.row.recordKey;
        const outcome = mediaAttempts.get(`${alias}\0${key}`);
        const claim = importer.session.bindings.claim({ source: alias, external_id: key });
        if (
          !outcome ||
          (outcome.status !== 'pending' && outcome.status !== 'fenced') ||
          claim?.state !== 'bound' ||
          outcome.containerId !== claim.subject ||
          store.key(alias, key, active.run).resolved ||
          !store.key(alias, key, active.run).coverPending
        )
          return false;
        coverKeys.add(key);
      }
      if (page.length) after = page.at(-1)!.row.recordKey;
      if (page.length < 100) break;
    }
    if (!coverKeys.size) return false;
    const unresolved = new Set<string>();
    after = undefined;
    for (;;) {
      const page = store.pageStaged(active.run, { ...(after ? { after } : {}), limit: 100 });
      for (const staged of page) {
        const state = store.key(alias, staged.row.recordKey, active.run);
        if (state.resolved) continue;
        if (!state.coverPending || !coverKeys.has(staged.row.recordKey)) return false;
        unresolved.add(staged.row.recordKey);
      }
      if (page.length) after = page.at(-1)!.row.recordKey;
      if (page.length < 100) break;
    }
    return unresolved.size === coverKeys.size;
  };
  try {
    if (port.requestMedia && port.mediaStatus) {
      const resolver = createMediaResolver({
        bindings: importer.session.bindings,
        port: {
          readFence: (tuple, signal) =>
            port.fence({ source: tuple.source, externalId: tuple.externalId, fieldGroup: tuple.fieldGroup }, signal),
          importFromUrl: (bytes, key, signal) => port.requestMedia!(bytes, key, signal),
          importStatus: (id, signal) => port.mediaStatus!(id, signal),
        },
        sleep: async (ms, signal) => {
          signal.throwIfAborted();
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              signal.removeEventListener('abort', aborted);
              resolve();
            }, ms);
            const aborted = () => {
              clearTimeout(timer);
              reject(signal.reason);
            };
            signal.addEventListener('abort', aborted, { once: true });
          });
          signal.throwIfAborted();
        },
      });
      importerOptions.mediaResolver = {
        async resolve(input) {
          const source = plan.coverSources?.find(
            (item) => item.sourceAlias === input.owner.source && item.externalId === input.owner.external_id,
          );
          ensure(
            source?.sourceStatus === 'available' && source.sourceUrl,
            'Media intent has no admitted Bangumi cover source',
          );
          ensure(input.mediaImportIntents.length === 1, 'Unexpected Bangumi showcase media asset count');
          const intent = input.mediaImportIntents[0]!;
          const sourceRecord = [...plan.records.bangumi, ...plan.entities.bangumi].find(
            (row) => row.key === source.externalId,
          );
          ensure(sourceRecord, 'Bangumi cover source record is missing');
          const conversion = createSourceRegistration('bangumi', {
            source: source.sourceAlias,
            converterRevision: crossMediaBangumiRevision,
          }).convert(
            {
              external_id: sourceRecord.key,
              record_revision: sourceRecord.revision ?? 'unversioned',
              record: sourceRecord.payload,
            },
            { source: source.sourceAlias, subjectId: input.subject },
          );
          const expectedIntent = (
            conversion as typeof conversion & { mediaImportIntents?: typeof input.mediaImportIntents }
          ).mediaImportIntents?.[0];
          ensure(
            expectedIntent &&
              JSON.stringify(expectedIntent) === JSON.stringify(intent) &&
              intent.containerId === input.subject &&
              intent.sourceUrl === source.sourceUrl &&
              intent.provenance.source === source.sourceAlias &&
              intent.provenance.external_id === source.externalId &&
              intent.provenance.record_revision === source.sourceRevision &&
              intent.provenance.field_group === 'cover' &&
              intent.provenance.digest === conversion.digest &&
              intent.credit.rightsHolder === '(c) rights holder' &&
              intent.credit.via.name === 'Bangumi' &&
              intent.credit.via.url === bangumiRecordUrl(source.externalId) &&
              intent.credit.license === 'LicenseRef-unknown' &&
              intent.provenance.references.some((reference) =>
                reference.parts.some((part) => part.value.type === 'value' && part.value.content === source.sourceUrl),
              ),
            'Bangumi cover intent does not match its admitted source evidence',
          );
          const resolution = await resolver.resolve({
            owner: input.owner,
            containerId: input.subject,
            mediaImportIntents: input.mediaImportIntents,
            signal: input.signal,
            ...(input.deferPending === undefined ? {} : { deferPending: input.deferPending }),
          });
          const recordKey = `${source.sourceAlias}\0${source.externalId}`;
          if (resolution.outcome === 'fenced') {
            mediaAttempts.set(recordKey, { ...source, status: 'fenced', containerId: input.subject });
            return { status: 'pending' };
          }
          const asset = resolution.assets[0]!;
          const mediaId = asset.outcome === 'available' ? resolution.mediaIds[asset.sourceUrl] : undefined;
          const observed: CrossMediaMediaOutcome = {
            ...source,
            status: asset.outcome,
            containerId: input.subject,
            mediaKey: asset.key,
            ...(mediaId ? { mediaId } : {}),
            credit: intent.credit,
            provenance: intent.provenance,
          };
          mediaAttempts.set(recordKey, observed);
          if (asset.outcome === 'rejected') return { status: 'rejected' };
          if (asset.outcome === 'pending') return { status: 'pending' };
          ensure(
            mediaId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(mediaId),
            'Available media identity is invalid',
          );
          return { status: 'available', mediaIds: resolution.mediaIds };
        },
      };
    }
    const nativeTypes = new Map<string, string>();
    const currentReads = new Map<string, Promise<ReviewedSubjectRead | null>>();
    const readCurrent = (subjectId: string): Promise<ReviewedSubjectRead | null> => {
      let pending = currentReads.get(subjectId);
      if (!pending) {
        pending = port.readReviewedSubject(subjectId).catch(() => null);
        currentReads.set(subjectId, pending);
      }
      return pending;
    };
    for (const provider of providers) {
      if (!plan.records[provider].length && !plan.entities[provider].length) continue;
      const registration = createSourceRegistration(provider, {
        source: crossMediaAliases[provider],
        converterRevision: provider === 'bangumi' ? crossMediaBangumiRevision : entityRevision,
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
      ensure(
        run.status === 'committed' || onlyPendingBangumiCovers(provider, run),
        `Cross-media ${provider} import failed: ${run.status}${run.diagnostic ? ` (${run.diagnostic})` : ''}`,
      );
      runs[provider] = run;
    }
    const bangumiFidelityRecords = [...plan.records.bangumi, ...plan.entities.bangumi];
    const bangumiCharacterAppearances = [
      ...(plan.characterAppearances ?? []),
      ...(plan.gameCharacterAppearances ?? []),
    ];
    const hasBangumiFidelityInput =
      bangumiCharacterAppearances.length > 0 ||
      bangumiFidelityRecords.some((record) => record.key.startsWith('character:'));
    const fidelity =
      providers.includes('bangumi') && hasBangumiFidelityInput
        ? await runBangumiCharacterFidelity({
            importer,
            port,
            sourceAlias: crossMediaAliases.bangumi,
            records: bangumiFidelityRecords,
            appearances: bangumiCharacterAppearances,
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
    const keys = [...plan.records.bangumi, ...plan.entities.bangumi, ...plan.records.vndb, ...plan.entities.vndb];
    const sourceIdentityGaps: CrossMediaGap[] = [];
    for (const record of keys) {
      const provider: Provider = record.source === 'vndb' ? 'vndb' : 'bangumi';
      const sourceAlias = crossMediaAliases[provider];
      const claim = importer.session.bindings.claim({ source: sourceAlias, external_id: record.key });
      if (claim?.state !== 'bound') continue;
      const subjectRead = await readCurrent(claim.subject);
      ensure(subjectRead, 'Current bound source subject is unavailable');
      if (provider === 'bangumi') {
        const subject = subjectRead.subject as
          | {
              id?: unknown;
              type?: unknown;
              statements?: Record<string, readonly { value?: { type?: unknown; content?: unknown } }[]>;
            }
          | undefined;
        const identity = bangumiSourceIdentity(record.key);
        const expectedType = nativeTypes.get(`${sourceAlias}\u0000${record.key}`);
        const matches =
          identity !== undefined &&
          (subject?.statements?.[identity.property]?.some(
            (statement) => statement.value?.type === 'value' && statement.value.content === identity.value,
          ) ??
            false);
        if (subject?.id !== claim.subject || subject.type !== expectedType || !matches) {
          if (identity)
            sourceIdentityGaps.push({
              source: 'bangumi',
              fields: [identity.property],
              record: { external_id: record.key },
              reason: 'Current source identity association is missing or mismatched',
              property: identity.property,
            });
          continue;
        }
      }
      readings.push({
        source: provider,
        externalId: record.key,
        subject: subjectRead,
        route: subjectRoute(subjectRead),
        selection: 'selected',
      });
    }
    const unresolved = delivered.unresolved.map((edge) => ({
      holder: edge.holder,
      target: edge.target,
      property: edge.property,
      reason: edge.reason,
    }));
    const baseResult: CrossMediaSeedResult = {
      status:
        plan.gaps.length ||
        delivered.gaps.length ||
        unresolved.length ||
        sourceIdentityGaps.length ||
        (vndbCredits?.diagnostics.length ?? 0) ||
        (vndbCredits?.vocabularyUnavailable.length ?? 0) ||
        (characterProfile?.omissions.length ?? 0) ||
        episodeDiagnostics.length ||
        fidelity?.gaps.length
          ? 'imported-with-gaps'
          : 'imported',
      franchises: plan.franchises,
      members: plan.members,
      runs,
      readings,
      mediaOutcomes: [],
      workLinks: [],
      gaps: [
        ...plan.gaps,
        ...sourceIdentityGaps,
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
      creditGaps: [],
      vndbCreditDiagnostics: vndbCredits?.diagnostics ?? [],
      vndbCreditVocabularyRequirements: vndbCredits?.requirements ?? [],
      vndbCreditVocabularyUnavailable: vndbCredits?.vocabularyUnavailable ?? [],
      vndbCharacterProfileRequirements: characterProfile?.requirements ?? [],
      vndbCharacterProfileOmissions: characterProfile?.omissions ?? [],
      characterDiagnostics: fidelity?.gaps ?? [],
      episodeDiagnostics,
      unresolved,
    };
    const vocabulary = extras?.prepareBangumiCreatorCreditBindings
      ? await extras.prepareBangumiCreatorCreditBindings({
          plan,
          result: baseResult,
          drafts: plan.credits,
          read: (subjectId) => (extras.readPublicSubject ?? port.readReviewedSubject)(subjectId),
        })
      : undefined;
    if (vocabulary) currentReads.clear();
    const bindings = combineBangumiCreditBindings(
      extras?.sourceVocabulary,
      vocabulary?.bindings ?? { releaseDigest: bundledDigest, schemes: [], concepts: [] },
    );
    const bangumiRegistration = createSelectedFamilySourceRegistration('bangumi', crossMediaAliases.bangumi);
    const credits = await deliverBangumiCreatorCredits({
      alias: crossMediaAliases.bangumi,
      converterRevision: entityRevision,
      drafts: plan.credits,
      bindings,
      claim: (owner) => importer.session.bindings.claim(owner),
      batch: (request) => port.batch(request),
      fence: (tuple) => port.fence(tuple),
      read: (subjectId) =>
        extras?.readPublicSubject
          ? extras.readPublicSubject(subjectId)
          : (readCurrent(subjectId) as Promise<ReviewedSubjectRead>),
      expectedNativeType: (externalId) => nativeTypes.get(`${crossMediaAliases.bangumi}\u0000${externalId}`),
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
    const currentWorkReads = new Map<string, CurrentWorkRead>();
    for (const reading of readings) {
      const current = currentWorkRead(reading.subject);
      if (current) currentWorkReads.set(`${reading.source}\u0000${reading.externalId}`, current);
    }
    for (const link of plan.workLinks) {
      const externalId = link.bangumiExternalId;
      if (externalId === undefined) continue;
      const key = `bangumi\u0000${externalId}`;
      if (currentWorkReads.has(key)) continue;
      const claim = importer.session.bindings.claim({ source: crossMediaAliases.bangumi, external_id: externalId });
      if (claim?.state !== 'bound') continue;
      const subject = await readCurrent(claim.subject);
      const current = subject ? currentWorkRead(subject) : undefined;
      if (current) currentWorkReads.set(key, current);
    }
    const workLinks = resolveShowcaseWorkLinkHandoffs(plan.workLinks, currentWorkReads);
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
    const mediaOutcomes: CrossMediaMediaOutcome[] = [];
    for (const source of plan.coverSources ?? []) {
      const owner = { source: source.sourceAlias, external_id: source.externalId };
      const prior = mediaAttempts.get(`${source.sourceAlias}\0${source.externalId}`);
      const claim = importer.session.bindings.claim(owner);
      const containerId = claim?.state === 'bound' ? claim.subject : null;
      if (source.sourceStatus !== 'available') {
        mediaOutcomes.push({ ...source, status: source.sourceStatus, containerId });
        continue;
      }
      if (containerId) {
        try {
          const fence = await port.fence({
            source: source.sourceAlias,
            externalId: source.externalId,
            fieldGroup: 'cover',
          });
          if (fence.fenced) {
            mediaOutcomes.push({ ...source, status: 'fenced', containerId });
            continue;
          }
          ensure(fence.securityRevision === null, 'Unexpected Bangumi cover fence revision');
        } catch {
          mediaOutcomes.push({ ...source, status: 'unavailable', containerId, code: 'cover-fence-unavailable' });
          continue;
        }
      }
      const mediaId = containerId ? importer.session.bindings.mediaIds(owner).cover : undefined;
      let storedIntent: CrossMediaMediaOutcome | undefined;
      if (containerId && mediaId) {
        const row = [...plan.records.bangumi, ...plan.entities.bangumi].find(
          (candidate) => candidate.key === source.externalId,
        );
        if (row) {
          const converted = createSourceRegistration('bangumi', {
            source: source.sourceAlias,
            converterRevision: crossMediaBangumiRevision,
          }).convert(
            {
              external_id: row.key,
              record_revision: row.revision ?? 'unversioned',
              record: row.payload,
            },
            { source: source.sourceAlias, subjectId: containerId },
          ) as {
            mediaImportIntents?: Array<{
              credit: CrossMediaMediaOutcome['credit'];
              provenance: CrossMediaMediaOutcome['provenance'];
            }>;
          };
          const intent = converted.mediaImportIntents?.[0];
          if (intent)
            storedIntent = {
              ...source,
              status: 'available',
              containerId,
              mediaId,
              ...(intent.credit ? { credit: intent.credit } : {}),
              ...(intent.provenance ? { provenance: intent.provenance } : {}),
            };
        }
      }
      const outcome = prior ??
        storedIntent ?? {
          ...source,
          status: 'unavailable' as const,
          containerId,
          code: 'media-intent-not-delivered' as const,
        };
      if (outcome.status === 'available' && (!mediaId || outcome.mediaId !== mediaId)) {
        const {
          mediaId: _mediaId,
          mediaKey: _mediaKey,
          credit: _credit,
          provenance: _provenance,
          ...sourceEvidence
        } = outcome;
        mediaOutcomes.push({
          ...sourceEvidence,
          status: 'unavailable',
          containerId,
          code: 'media-intent-not-delivered',
        });
      } else mediaOutcomes.push(outcome);
    }
    return {
      status:
        plan.gaps.length ||
        delivered.gaps.length ||
        unresolved.length ||
        sourceIdentityGaps.length ||
        credits.gaps.length ||
        credits.fenced.length ||
        (vndbCredits?.diagnostics.length ?? 0) ||
        (vndbCredits?.vocabularyUnavailable.length ?? 0) ||
        (characterProfile?.omissions.length ?? 0) ||
        (fidelity?.gaps.length ?? 0) ||
        episodeDiagnostics.length ||
        (bangumiGenrePublication?.diagnostics.length ?? 0) ||
        mediaOutcomes.some((outcome) => outcome.status !== 'available')
          ? ('imported-with-gaps' as const)
          : ('imported' as const),
      franchises: plan.franchises,
      members: plan.members,
      runs,
      readings,
      mediaOutcomes,
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
      vndbCreditVocabularyUnavailable: vndbCredits?.vocabularyUnavailable ?? [],
      ...(vocabulary ? { creditRoles: vocabulary.roles, creditVocabularyRequirements: vocabulary.requirements } : {}),
      vndbCharacterProfileRequirements: characterProfile?.requirements ?? [],
      vndbCharacterProfileOmissions: characterProfile?.omissions ?? [],
      characterDiagnostics: fidelity?.gaps ?? [],
      episodeDiagnostics,
      unresolved,
      ...(bangumiGenrePublication ? { bangumiGenrePublication } : {}),
    };
  } finally {
    await importer.close();
  }
}

async function readPriorShowcasePublication(
  path: string,
): Promise<Pick<ShowcasePublicationResult, 'manifest' | 'published'> | undefined> {
  const limit = 32 * 1024 * 1024;
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  ensure(bytes.byteLength <= limit, 'Prior cross-media result exceeds the bounded showcase read limit');
  const value = JSON.parse(bytes.toString('utf8')) as { showcase?: unknown };
  const showcase = value?.showcase;
  if (!showcase || typeof showcase !== 'object' || Array.isArray(showcase)) return undefined;
  const manifest = Reflect.get(showcase, 'manifest') as ShowcaseManifest | undefined;
  const published = Reflect.get(showcase, 'published') as ShowcasePublicationResult['published'] | undefined;
  if (
    !manifest ||
    manifest.version !== 1 ||
    typeof manifest.digest !== 'string' ||
    !Array.isArray(manifest.vocabulary) ||
    manifest.vocabulary.length > showcaseLimits.vocabulary ||
    !Array.isArray(manifest.records) ||
    manifest.records.length > showcaseLimits.records ||
    !Array.isArray(published) ||
    published.length > showcaseLimits.records + showcaseLimits.vocabulary
  )
    return undefined;
  return { manifest, published };
}

export type CrossMediaSeedCliOptions = {
  episodeCatalogueSubjects?: Readonly<Record<string, string>>;
  reviewedCatalogueSubjects?: Readonly<Record<string, string>>;
  selection?: CrossMediaSelection;
};

export async function runCrossMediaSeedCli(
  argv: readonly string[],
  options: CrossMediaSeedCliOptions = {},
): Promise<void> {
  const {
    composeVndbCharacterVocabularyBindings,
    parseVndbCharacterVocabularyProfile,
    planShowcaseCharacterVocabulary,
    prepareShowcaseCharacterVocabulary,
    profileFromCharacterVocabularyBindings,
    readShowcaseCharacterVocabulary,
  } = await import('./showcase-character-vocabulary.ts');
  const optionalFlags = [
    '--bangumi-character-bindings',
    '--vndb-public-tag-bindings',
    '--showcase-state',
    '--vndb-credit-bindings',
    '--vndb-character-vocabulary',
    '--vndb-character-profile-bindings',
    '--vndb-release-state-bindings',
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
      'Usage: bun scripts/datasets/cross-media-seed.ts ' +
        requiredFlags.map((flag) => flag + ' <value>').join(' ') +
        ' [--bangumi-character-bindings <json>] [--vndb-public-tag-bindings <json>] [--showcase-state <sqlite>] [--vndb-credit-bindings <json>] [--vndb-character-vocabulary <json>] [--vndb-character-profile-bindings <json>] [--vndb-release-state-bindings <json>]\n',
    );
    return;
  }
  ensure(
    argv.length % 2 === 0 && argv.length >= requiredFlags.length * 2 && argv.length <= flags.length * 2,
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
  for (const flag of requiredFlags) ensure(values.has(flag), 'Missing seed option: ' + flag);
  const api = normalizeCrossMediaSeedOrigin(values.get('--api')!),
    auth = normalizeCrossMediaSeedOrigin(values.get('--auth')!);
  const input = new CrossMediaDumpFiles(values.get('--bangumi')!, values.get('--vndb')!);
  let plan = await planCrossMediaSeed(input, {
    deferVndbCharacterAppearances: true,
    ...(options.selection ? { selection: options.selection } : {}),
  });
  const characterVocabulary = await planShowcaseCharacterVocabulary(input, plan);
  const showcasePath = values.has('--showcase-state') ? resolve(values.get('--showcase-state')!) : undefined;
  const { parseVndbReleaseStateBindings, prepareShowcaseVndbReleaseClassifications, seedShowcaseVndbReleases } =
    await import('./showcase-vndb-releases.ts');
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
  const priorShowcase = showcasePath ? await readPriorShowcasePublication(resultPath) : undefined;
  const characterBindingsPath = values.has('--bangumi-character-bindings')
    ? resolve(values.get('--bangumi-character-bindings')!)
    : undefined;
  const tagBindingsPath = values.has('--vndb-public-tag-bindings')
    ? resolve(values.get('--vndb-public-tag-bindings')!)
    : undefined;
  const vocabularyPath = values.has('--vndb-character-vocabulary')
    ? resolve(values.get('--vndb-character-vocabulary')!)
    : undefined;
  const explicitCreditBindingsPath = values.has('--vndb-credit-bindings')
    ? resolve(values.get('--vndb-credit-bindings')!)
    : undefined;
  const defaultCreditBindingsPath = resolve('.temp/cross-media-seed/vndb-credit-bindings.json');
  const creditBindingsPath =
    explicitCreditBindingsPath ??
    (!showcasePath && existsSync(defaultCreditBindingsPath) ? defaultCreditBindingsPath : undefined);
  const explicitProfileBindingsPath = values.has('--vndb-character-profile-bindings')
    ? resolve(values.get('--vndb-character-profile-bindings')!)
    : undefined;
  const defaultProfileBindingsPath = resolve('.temp/cross-media-seed/vndb-character-profile-bindings.json');
  const profileBindingsPath =
    explicitProfileBindingsPath ??
    (!showcasePath && existsSync(defaultProfileBindingsPath) ? defaultProfileBindingsPath : undefined);
  const explicitReleaseStateBindingsPath = values.has('--vndb-release-state-bindings')
    ? resolve(values.get('--vndb-release-state-bindings')!)
    : undefined;
  const defaultReleaseStateBindingsPath = resolve('.temp/cross-media-seed/vndb-release-state-bindings.json');
  const releaseStateBindingsPath =
    explicitReleaseStateBindingsPath ??
    (existsSync(defaultReleaseStateBindingsPath) ? defaultReleaseStateBindingsPath : undefined);
  const seedFiles = [
    characterBindingsPath,
    tagBindingsPath,
    creditBindingsPath,
    vocabularyPath,
    profileBindingsPath,
    releaseStateBindingsPath,
  ].filter((path): path is string => path !== undefined);
  const showcaseConflictPaths = [statePath, resultPath, ...seedFiles].flatMap((path) => [
    path,
    path + '-wal',
    path + '-shm',
  ]);
  for (const extra of seedFiles) {
    ensure(
      extra !== resultPath && extra !== statePath && ![statePath + '-wal', statePath + '-shm'].includes(extra),
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
  let vndbVocabularyProfile: ReturnType<typeof parseVndbCharacterVocabularyProfile> | undefined;
  if (vocabularyPath) {
    const bytes = await readFile(vocabularyPath);
    ensure(bytes.byteLength <= 256 * 1024, 'VNDB character vocabulary profile exceeds the configuration limit');
    vndbVocabularyProfile = parseVndbCharacterVocabularyProfile(JSON.parse(bytes.toString('utf8')) as unknown);
  }
  let vndbCharacterProfileReferences: VndbCharacterProfileReferences | undefined;
  if (profileBindingsPath) {
    const bytes = await readFile(profileBindingsPath);
    ensure(bytes.byteLength <= 256 * 1024, 'VNDB character profile bindings exceed the configuration limit');
    vndbCharacterProfileReferences = parseVndbCharacterProfileReferences(JSON.parse(bytes.toString('utf8')));
  }
  let vndbReleaseStateBindings: ReturnType<typeof parseVndbReleaseStateBindings> | undefined;
  if (releaseStateBindingsPath) {
    const bytes = await readFile(releaseStateBindingsPath);
    ensure(bytes.byteLength <= 256 * 1024, 'VNDB release-state bindings exceed the configuration limit');
    vndbReleaseStateBindings = parseVndbReleaseStateBindings(JSON.parse(bytes.toString('utf8')));
  }
  ensure(
    resultPath !== statePath && ![statePath + '-wal', statePath + '-shm'].includes(resultPath),
    'Result must not overwrite importer state',
  );
  ensure(!showcasePath || !showcaseConflictPaths.includes(showcasePath), 'Showcase state must not overlap seed files');
  await mkdir(dirname(statePath), { recursive: true });
  const importPort = createImportTransport({ origin: api, tokenProvider });
  let characterProfileBindings = await readVndbCharacterProfileBindings(importPort, vndbCharacterProfileReferences);
  const journal = showcasePath ? new ShowcaseJournal(showcasePath) : undefined;
  const port = journal ? captureShowcaseCommands(importPort, journal) : importPort;
  const publicClient = showcasePath ? createPublicBulkClient({ origin: api }) : undefined;
  let autoVndbCreditReferences: VndbCreditVocabularyReferences | undefined;
  let vndbCharacterProfileVocabularyRequirements: Awaited<
    ReturnType<typeof prepareShowcaseVndbCharacterProfileVocabulary>
  >['requirements'] = [];
  let vndbCreditVocabularyRequirements: Awaited<
    ReturnType<typeof prepareShowcaseVndbCreditVocabulary>
  >['requirements'] = [];
  let vndbCreditVocabularyIssues: Awaited<ReturnType<typeof prepareShowcaseVndbCreditVocabulary>>['issues'] = [];
  let releaseClassificationPreparation: Awaited<ReturnType<typeof prepareShowcaseVndbReleaseClassifications>> = {
    requirements: [],
    bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
    groups: [],
  };
  let creditResolution: BangumiCreditVocabularyResolution | undefined;
  try {
    if (journal && publicClient)
      releaseClassificationPreparation = await prepareShowcaseVndbReleaseClassifications({
        plan,
        port,
        journal,
        stage: 'schemes',
      });
    const reviewedSubjects = options.reviewedCatalogueSubjects;
    const reviewedSelection = Boolean(options.selection && reviewedSubjects);
    const {
      importShowcaseTags,
      knownShowcaseTagBindings,
      parseShowcaseTagKnownBindings,
      prepareShowcaseTags,
      prepareShowcaseVndbPublicTagVocabulary,
      readShowcaseVndbPublicTagVocabulary,
    } = await import('./showcase-tags.ts');
    const { importVndbCharacterTraits } = await import('./vndb-character-traits.ts');
    const selectedVids = plan.members
      .filter((member) => member.source === 'vndb' && member.kind === 'work')
      .map((member) => member.key);
    let preparedPublicTags: Awaited<ReturnType<typeof prepareShowcaseTags>> | undefined;
    let tagVocabularyRequirements: Awaited<ReturnType<typeof prepareShowcaseVndbPublicTagVocabulary>>['requirements'] =
      [];
    let vocabularyAdmissions: NonNullable<ImporterOptions['vocabularyAdmission']>[] = [];
    let vndbBindings: SourceVocabularyBindings | undefined;
    if (options.selection && reviewedSubjects) {
      const plannedKeys = new Set([...plan.records.vndb, ...plan.entities.vndb].map((row) => row.key));
      for (const row of [...characterVocabulary.plan.records.vndb, ...characterVocabulary.plan.entities.vndb]) {
        if (plannedKeys.has(row.key)) continue;
        plannedKeys.add(row.key);
        plan.entities.vndb.push(row);
      }
      const memberKeys = new Set(plan.members.map((row) => `${row.source}\0${row.key}`));
      for (const entry of characterVocabulary.plan.members) {
        const key = `${entry.source}\0${entry.key}`;
        if (memberKeys.has(key)) {
          const current = plan.members.find((row) => row.source === entry.source && row.key === entry.key);
          if (current && current.membership !== 'family' && entry.membership === 'family')
            Object.assign(current, entry);
          continue;
        }
        memberKeys.add(key);
        plan.members.push(entry);
      }
      ensure(
        plan.records.bangumi.length +
          plan.entities.bangumi.length +
          plan.records.vndb.length +
          plan.entities.vndb.length <=
          showcaseLimits.records,
        'Selected showcase record limit exceeded after character selection',
      );

      let knownTagBindings = parseShowcaseTagKnownBindings({ schemes: [], concepts: [] });
      if (tagBindingsPath) {
        const bytes = await readFile(tagBindingsPath);
        ensure(bytes.byteLength <= 256 * 1024, 'VNDB public tag bindings exceed the configuration limit');
        knownTagBindings = parseShowcaseTagKnownBindings(JSON.parse(bytes.toString('utf8')));
      } else {
        knownTagBindings = parseShowcaseTagKnownBindings({
          schemes: [{ category: 'cont', id: reviewedSubjects['vndb-public-tags-cont-scheme'] }],
          concepts: ['g105', 'g249'].map((code) => ({
            category: 'cont',
            code,
            id: reviewedSubjects[`vndb-public-tags-cont-${code}`],
          })),
        });
      }
      preparedPublicTags = await prepareShowcaseTags({ tables: input, selectedVids, port, known: knownTagBindings });

      const { vndbCharacterVocabularyAdmission, appearanceRoleTaxonomy } = await import('./vndb-character-traits.ts');
      const roleRequirements = {
        ...characterVocabulary.requirements,
        terms: characterVocabulary.requirements.terms.filter((term) => term.taxonomy === appearanceRoleTaxonomy),
      };
      const characterAdmissions: NonNullable<ImporterOptions['vocabularyAdmission']>[] = [];
      const roleBindings = await composeVndbCharacterVocabularyBindings(port, vndbVocabularyProfile, roleRequirements);
      const { prepareShowcaseVndbTraits } = await import('./showcase-vndb-traits.ts');
      const reviewedTraits = await prepareShowcaseVndbTraits(plan, characterVocabulary.plan, port, reviewedSubjects);
      characterAdmissions.push(reviewedTraits.vocabularyAdmission);
      characterAdmissions.push(
        vndbCharacterVocabularyAdmission(roleBindings, { ...characterVocabulary.plan, traits: [] }),
      );
      vndbBindings = {
        releaseDigest: bundledDigest,
        schemes: [...reviewedTraits.bindings.schemes, ...roleBindings.schemes],
        concepts: [...reviewedTraits.bindings.concepts, ...roleBindings.concepts],
      };
      vocabularyAdmissions = [preparedPublicTags.vocabularyAdmission, ...characterAdmissions];
    }
    const episodeCatalogueSubjects = options.reviewedCatalogueSubjects ?? options.episodeCatalogueSubjects;

    if (journal) plan = await acquireBangumiCoverSources(plan, { journal });
    let publicationPlan = structuredClone(plan);
    let result = await seedShowcaseVndbReleases({
      tables: input,
      plan: publicationPlan,
      path: statePath,
      port,
      bindings: releaseClassificationPreparation.bindings,
      destination: { origin: api },
      ...(vndbReleaseStateBindings?.groups.length || releaseClassificationPreparation.groups.length
        ? { groups: [...(vndbReleaseStateBindings?.groups ?? []), ...releaseClassificationPreparation.groups] }
        : {}),
      extras: {
        ...(vndbCreditReferences ? { vndbCreditReferences } : {}),
        vndbCharacterProfileBindings: characterProfileBindings,
        ...(episodeCatalogueSubjects ? { episodeCatalogueSubjects } : {}),
        ...(vocabularyAdmissions.length ? { vocabularyAdmissions } : {}),
        bangumiGenrePort: importPort,
        ...(journal && publicClient
          ? {
              readPublicSubject: (subjectId: string) => publicClient.readSubject(subjectId),
              prepareBangumiCreatorCreditBindings: async ({ result: baseResult, drafts, read }) => {
                const prepared = await prepareBangumiCreatorCreditBindings({
                  plan,
                  result: baseResult,
                  drafts,
                  port,
                  journal,
                  review: importPort,
                  publicClient,
                  ...(priorShowcase ? { prior: priorShowcase } : {}),
                  subjectTypes: [2],
                  read,
                });
                creditResolution = prepared;
                return prepared;
              },
            }
          : {}),
      },
      ...(characterBindings === undefined ? {} : { characterBindings }),
    });
    let releaseClassificationRequirements = releaseClassificationPreparation.requirements;
    if (journal && publicClient) {
      if (releaseClassificationRequirements.length)
        await publishShowcase({
          plan: publicationPlan,
          result,
          aliases: crossMediaAliases,
          journal,
          review: importPort,
          publicClient,
          vocabularyRequirements: [
            ...(result.creditVocabularyRequirements ?? []),
            ...releaseClassificationRequirements,
          ],
        });
      releaseClassificationPreparation = await prepareShowcaseVndbReleaseClassifications({
        plan: publicationPlan,
        port,
        journal,
        stage: 'concepts',
      });
      releaseClassificationRequirements = releaseClassificationPreparation.requirements;
      if (releaseClassificationRequirements.length)
        await publishShowcase({
          plan: publicationPlan,
          result,
          aliases: crossMediaAliases,
          journal,
          review: importPort,
          publicClient,
          vocabularyRequirements: [
            ...(result.creditVocabularyRequirements ?? []),
            ...releaseClassificationRequirements,
          ],
        });
      const currentReleaseClassifications = await prepareShowcaseVndbReleaseClassifications({
        plan: publicationPlan,
        port,
        journal,
        stage: 'concepts',
      });
      const sameBindings =
        JSON.stringify(currentReleaseClassifications.bindings) ===
        JSON.stringify(releaseClassificationPreparation.bindings);
      releaseClassificationPreparation = currentReleaseClassifications;
      releaseClassificationRequirements = currentReleaseClassifications.requirements;
      if (!sameBindings) {
        publicationPlan = structuredClone(plan);
        result = await seedShowcaseVndbReleases({
          tables: input,
          plan: publicationPlan,
          path: statePath,
          port,
          bindings: currentReleaseClassifications.bindings,
          destination: { origin: api },
          ...(vndbReleaseStateBindings?.groups.length
            ? { groups: [...vndbReleaseStateBindings.groups, ...currentReleaseClassifications.groups] }
            : currentReleaseClassifications.groups.length
              ? { groups: currentReleaseClassifications.groups }
              : {}),
          extras: {
            ...(vndbCreditReferences ? { vndbCreditReferences } : {}),
            vndbCharacterProfileBindings: characterProfileBindings,
            ...(episodeCatalogueSubjects ? { episodeCatalogueSubjects } : {}),
            ...(vocabularyAdmissions.length ? { vocabularyAdmissions } : {}),
            bangumiGenrePort: importPort,
            ...(journal && publicClient
              ? {
                  readPublicSubject: (subjectId: string) => publicClient.readSubject(subjectId),
                  prepareBangumiCreatorCreditBindings: async ({ result: baseResult, drafts, read }) => {
                    const prepared = await prepareBangumiCreatorCreditBindings({
                      plan,
                      result: baseResult,
                      drafts,
                      port,
                      journal,
                      review: importPort,
                      publicClient,
                      ...(priorShowcase ? { prior: priorShowcase } : {}),
                      subjectTypes: [2],
                      read,
                    });
                    creditResolution = prepared;
                    return prepared;
                  },
                }
              : {}),
          },
          ...(characterBindings === undefined ? {} : { characterBindings }),
        });
      }
    }
    let publicTags: Awaited<ReturnType<typeof importShowcaseTags>> | Awaited<ReturnType<typeof prepareShowcaseTags>>;
    if (preparedPublicTags) {
      publicTags = preparedPublicTags;
    } else {
      let knownTagBindings = parseShowcaseTagKnownBindings({ schemes: [], concepts: [] });
      if (tagBindingsPath) {
        const bytes = await readFile(tagBindingsPath);
        ensure(bytes.byteLength <= 256 * 1024, 'VNDB public tag bindings exceed the configuration limit');
        knownTagBindings = parseShowcaseTagKnownBindings(JSON.parse(bytes.toString('utf8')));
      } else if (journal && publicClient) {
        const schemes = await prepareShowcaseVndbPublicTagVocabulary({
          tables: input,
          selectedVids,
          plan: publicationPlan,
          port,
          journal,
          stage: 'schemes',
        });
        if (schemes.requirements.length)
          await publishShowcase({
            plan: publicationPlan,
            result,
            aliases: crossMediaAliases,
            journal,
            review: importPort,
            publicClient,
            vocabularyRequirements: [
              ...(result.creditVocabularyRequirements ?? []),
              ...releaseClassificationRequirements,
              ...schemes.requirements,
            ],
          });
        const concepts = await prepareShowcaseVndbPublicTagVocabulary({
          tables: input,
          selectedVids,
          plan: publicationPlan,
          port,
          journal,
          stage: 'concepts',
        });
        if (concepts.requirements.length)
          await publishShowcase({
            plan: publicationPlan,
            result,
            aliases: crossMediaAliases,
            journal,
            review: importPort,
            publicClient,
            vocabularyRequirements: [
              ...(result.creditVocabularyRequirements ?? []),
              ...releaseClassificationRequirements,
              ...concepts.requirements,
            ],
          });
        tagVocabularyRequirements = concepts.requirements;
        knownTagBindings = knownShowcaseTagBindings(
          await readShowcaseVndbPublicTagVocabulary({
            tables: input,
            selectedVids,
            plan: publicationPlan,
            port,
            journal,
          }),
        );
      }
      publicTags = await importShowcaseTags({
        tables: input,
        selectedVids,
        path: statePath,
        port,
        known: knownTagBindings,
        destination: { origin: api },
      });
    }
    if (journal && publicClient && !explicitCreditBindingsPath) {
      const schemes = await prepareShowcaseVndbCreditVocabulary({
        plan: publicationPlan,
        port,
        journal,
        stage: 'schemes',
      });
      vndbCreditVocabularyIssues.push(...schemes.issues);
      if (schemes.requirements.length)
        await publishShowcase({
          plan: publicationPlan,
          result,
          aliases: crossMediaAliases,
          journal,
          review: importPort,
          publicClient,
          vocabularyRequirements: [
            ...(result.creditVocabularyRequirements ?? []),
            ...tagVocabularyRequirements,
            ...schemes.requirements,
          ],
        });
      const concepts = await prepareShowcaseVndbCreditVocabulary({
        plan: publicationPlan,
        port,
        journal,
        stage: 'concepts',
      });
      vndbCreditVocabularyRequirements = concepts.requirements;
      vndbCreditVocabularyIssues.push(...concepts.issues);
      let creditVocabularyPublication: ShowcasePublicationResult | undefined;
      if (concepts.requirements.length)
        creditVocabularyPublication = await publishShowcase({
          plan: publicationPlan,
          result,
          aliases: crossMediaAliases,
          journal,
          review: importPort,
          publicClient,
          vocabularyRequirements: [
            ...(result.creditVocabularyRequirements ?? []),
            ...tagVocabularyRequirements,
            ...concepts.requirements,
          ],
        });
      if (creditVocabularyPublication)
        autoVndbCreditReferences = publishedShowcaseVndbCreditReferences(
          creditVocabularyPublication,
          journal,
          concepts.requirements,
        );
    }
    if (journal && publicClient && !explicitProfileBindingsPath) {
      const schemes = await prepareShowcaseVndbCharacterProfileVocabulary({
        plan: publicationPlan,
        port,
        journal,
        stage: 'schemes',
      });
      if (schemes.requirements.length)
        await publishShowcase({
          plan: publicationPlan,
          result,
          aliases: crossMediaAliases,
          journal,
          review: importPort,
          publicClient,
          vocabularyRequirements: [
            ...(result.creditVocabularyRequirements ?? []),
            ...releaseClassificationRequirements,
            ...tagVocabularyRequirements,
            ...vndbCreditVocabularyRequirements,
            ...schemes.requirements,
          ],
        });
      const concepts = await prepareShowcaseVndbCharacterProfileVocabulary({
        plan: publicationPlan,
        port,
        journal,
        stage: 'concepts',
      });
      vndbCharacterProfileVocabularyRequirements = concepts.requirements;
      if (concepts.requirements.length)
        await publishShowcase({
          plan: publicationPlan,
          result,
          aliases: crossMediaAliases,
          journal,
          review: importPort,
          publicClient,
          vocabularyRequirements: [
            ...(result.creditVocabularyRequirements ?? []),
            ...releaseClassificationRequirements,
            ...tagVocabularyRequirements,
            ...vndbCreditVocabularyRequirements,
            ...concepts.requirements,
          ],
        });
      characterProfileBindings = await readShowcaseVndbCharacterProfileVocabulary({
        plan: publicationPlan,
        port,
        journal,
      });
    }
    const currentVndbCreditReferences = autoVndbCreditReferences ?? vndbCreditReferences;
    let showcase: ShowcasePublicationResult | undefined;
    let bangumiVocabularyRequirements:
      | Awaited<ReturnType<typeof prepareShowcaseBangumiSelectedCharacterVocabulary>>['requirements']
      | undefined;
    const reseedWithCurrentVocabulary = async (nextCharacterBindings: SourceVocabularyBindings) => {
      publicationPlan = structuredClone(plan);
      result = await seedShowcaseVndbReleases({
        tables: input,
        plan: publicationPlan,
        path: statePath,
        port,
        bindings: result.bindings,
        destination: { origin: api },
        ...(vndbReleaseStateBindings?.groups.length ? { groups: vndbReleaseStateBindings.groups } : {}),
        extras: {
          ...(currentVndbCreditReferences ? { vndbCreditReferences: currentVndbCreditReferences } : {}),
          vndbCharacterProfileBindings: characterProfileBindings,
          ...(episodeCatalogueSubjects ? { episodeCatalogueSubjects } : {}),
          ...(vocabularyAdmissions.length ? { vocabularyAdmissions } : {}),
          bangumiGenrePort: importPort,
          ...(journal && publicClient
            ? {
                readPublicSubject: (subjectId: string) => publicClient.readSubject(subjectId),
                prepareBangumiCreatorCreditBindings: async ({ result: baseResult, drafts, read }) => {
                  const prepared = await prepareBangumiCreatorCreditBindings({
                    plan,
                    result: baseResult,
                    drafts,
                    port,
                    journal,
                    review: importPort,
                    publicClient,
                    ...(priorShowcase ? { prior: priorShowcase } : {}),
                    subjectTypes: [2],
                    read,
                  });
                  creditResolution = prepared;
                  return prepared;
                },
              }
            : {}),
        },
        characterBindings: nextCharacterBindings,
      });
    };
    if (journal && publicClient && !characterBindingsPath) {
      const schemes = await prepareShowcaseBangumiSelectedCharacterVocabulary({
        plan: publicationPlan,
        port,
        journal,
        stage: 'schemes',
      });
      await publishShowcase({
        plan: publicationPlan,
        result,
        aliases: crossMediaAliases,
        journal,
        review: importPort,
        publicClient,
        vocabularyRequirements: [
          ...(result.creditVocabularyRequirements ?? []),
          ...releaseClassificationRequirements,
          ...tagVocabularyRequirements,
          ...vndbCreditVocabularyRequirements,
          ...vndbCharacterProfileVocabularyRequirements,
          ...schemes.requirements,
        ],
      });
      const concepts = await prepareShowcaseBangumiSelectedCharacterVocabulary({
        plan: publicationPlan,
        port,
        journal,
        stage: 'concepts',
      });
      await publishShowcase({
        plan: publicationPlan,
        result,
        aliases: crossMediaAliases,
        journal,
        review: importPort,
        publicClient,
        vocabularyRequirements: [
          ...(result.creditVocabularyRequirements ?? []),
          ...releaseClassificationRequirements,
          ...tagVocabularyRequirements,
          ...vndbCreditVocabularyRequirements,
          ...vndbCharacterProfileVocabularyRequirements,
          ...concepts.requirements,
        ],
      });
      bangumiVocabularyRequirements = concepts.requirements;
      const currentCharacterBindings = await readShowcaseBangumiSelectedCharacterVocabulary({
        plan: publicationPlan,
        port,
        journal,
      });
      await reseedWithCurrentVocabulary(currentCharacterBindings);
    } else if (
      journal &&
      publicClient &&
      characterBindingsPath &&
      (autoVndbCreditReferences || (!explicitProfileBindingsPath && characterProfileBindings.concepts.length > 0))
    ) {
      await reseedWithCurrentVocabulary(
        characterBindings ?? { releaseDigest: bundledDigest, schemes: [], concepts: [] },
      );
    }
    if (journal && publicClient && creditResolution) {
      const current = await currentBangumiCreatorCreditBindings({
        resolution: creditResolution,
        acknowledgements: journal.acknowledgedCommands(),
        read: async (id) => {
          try {
            return await publicClient.readSubject(id);
          } catch {
            return null;
          }
        },
      });
      const currentCodes = new Set(current.roles.map((role) => role.code));
      for (const role of creditResolution.roles) {
        if (currentCodes.has(role.code)) continue;
        for (const draft of plan.credits) {
          if (draft.kind !== 'staff' || String(draft.roleCode) !== role.code) continue;
          result.creditGaps.push({
            provider: 'bangumi',
            path: draft.path,
            code: role.code,
            reason: 'missing_concept',
            property: role.property,
          });
        }
      }
      result.creditRoles = current.roles;
      result.creditVocabularyRequirements = current.requirements;
      if (result.creditGaps.length) result.status = 'imported-with-gaps';
    }
    let characterVocabularyRequirements: Awaited<
      ReturnType<typeof prepareShowcaseCharacterVocabulary>
    >['requirements'] = [];
    let characterResult: Awaited<ReturnType<typeof importVndbCharacterTraits>> | undefined;
    if (!reviewedSelection) {
      if (!vocabularyPath && journal && publicClient) {
        const schemes = await prepareShowcaseCharacterVocabulary({
          tables: input,
          selectedPlan: publicationPlan,
          port,
          journal,
          stage: 'schemes',
        });
        if (schemes.requirements.length)
          await publishShowcase({
            plan: publicationPlan,
            result,
            aliases: crossMediaAliases,
            journal,
            review: importPort,
            publicClient,
            vocabularyRequirements: [
              ...(result.creditVocabularyRequirements ?? []),
              ...releaseClassificationRequirements,
              ...(bangumiVocabularyRequirements ?? []),
              ...tagVocabularyRequirements,
              ...vndbCreditVocabularyRequirements,
              ...vndbCharacterProfileVocabularyRequirements,
              ...schemes.requirements,
            ],
          });
        const concepts = await prepareShowcaseCharacterVocabulary({
          tables: input,
          selectedPlan: publicationPlan,
          port,
          journal,
          stage: 'concepts',
        });
        if (concepts.requirements.length)
          await publishShowcase({
            plan: publicationPlan,
            result,
            aliases: crossMediaAliases,
            journal,
            review: importPort,
            publicClient,
            vocabularyRequirements: [
              ...(result.creditVocabularyRequirements ?? []),
              ...releaseClassificationRequirements,
              ...(bangumiVocabularyRequirements ?? []),
              ...tagVocabularyRequirements,
              ...vndbCreditVocabularyRequirements,
              ...vndbCharacterProfileVocabularyRequirements,
              ...concepts.requirements,
            ],
          });
        characterVocabularyRequirements = concepts.requirements;
        vndbVocabularyProfile = profileFromCharacterVocabularyBindings(
          await readShowcaseCharacterVocabulary({
            tables: input,
            selectedPlan: publicationPlan,
            port,
            journal,
          }),
        );
      }
      vndbBindings = await composeVndbCharacterVocabularyBindings(
        port,
        vndbVocabularyProfile,
        characterVocabulary.requirements,
      );
      characterResult = await importVndbCharacterTraits({
        tables: input,
        path: statePath,
        port,
        bindings: vndbBindings,
        selectedWorkIds: characterVocabulary.requirements.selectedWorkIds,
        destination: { origin: api },
      });
    }
    ensure(vndbBindings, 'Selected VNDB character vocabulary bindings are missing');
    const mergeSeparator = String.fromCharCode(0);
    const readings = new Map<string, (typeof result.readings)[number]>();
    for (const reading of [
      ...result.readings,
      ...('readings' in publicTags ? publicTags.readings : []),
      ...(characterResult?.readings ?? []),
    ])
      readings.set(reading.source + mergeSeparator + reading.externalId, reading);
    const members = new Map<string, (typeof result.members)[number]>();
    for (const member of [...result.members, ...(characterResult?.members ?? [])]) {
      const key = member.source + mergeSeparator + member.key;
      const previous = members.get(key);
      if (!previous || member.membership === 'family') members.set(key, member);
    }
    const gaps = [
      ...result.gaps,
      ...(characterResult?.gaps ?? []),
      ...characterVocabulary.plan.gaps,
      ...publicTags.gaps,
    ];
    const combinedResult = {
      ...result,
      status:
        result.status === 'imported-with-gaps' || characterResult?.status === 'imported-with-gaps' || gaps.length
          ? ('imported-with-gaps' as const)
          : ('imported' as const),
      readings: [...readings.values()],
      members: [...members.values()].sort(
        (left, right) => left.source.localeCompare(right.source) || left.key.localeCompare(right.key),
      ),
      gaps,
      characterDiagnostics: [...result.characterDiagnostics, ...(characterResult?.characterDiagnostics ?? [])],
      runs: {
        ...result.runs,
        ...(characterResult?.runs.vndb ? { vndbCharacterVocabulary: characterResult.runs.vndb } : {}),
      },
      publicTags: {
        admitted: publicTags.admitted,
        vocabulary: publicTags.vocabulary,
        truncated: publicTags.truncated,
        adoptedConcepts: publicTags.bindings.concepts.map((item) => item.code),
        tagWeightObservations: publicTags.tagWeightObservations,
        tagWeightRefreshes: publicTags.tagWeightRefreshes,
        gaps: publicTags.gaps,
      },
      vndbCreditVocabularyDelivery: vndbCreditVocabularyIssues,
      characterVocabulary: {
        requirements: characterVocabulary.requirements,
        admittedConceptCodes: vndbBindings.concepts.map((concept) => concept.taxonomy + ':' + concept.code).sort(),
        withheldConceptCodes: characterVocabulary.requirements.terms
          .filter(
            (term) =>
              !vndbBindings.concepts.some(
                (concept) => concept.taxonomy === term.taxonomy && concept.code === term.code,
              ),
          )
          .map((term) => term.taxonomy + ':' + term.code)
          .sort(),
      },
    };
    const { importShowcaseBooks, showcaseBooksToCrossMediaPlan } = await import('./showcase-books.ts');
    const books = options.selection
      ? undefined
      : await importShowcaseBooks({
          tables: input,
          path: statePath,
          port,
          destination: { origin: api },
          ...(journal && publicClient
            ? {
                journal,
                review: importPort,
                publicClient,
                ...(creditResolution?.publication
                  ? { prior: creditResolution.publication }
                  : priorShowcase
                    ? { prior: priorShowcase }
                    : {}),
                readPublicSubject: (subjectId: string) => publicClient.readSubject(subjectId),
              }
            : {}),
        });
    if (books) {
      const bookCross = showcaseBooksToCrossMediaPlan(books.planned);
      for (const target of [plan, publicationPlan]) {
        const existingRecordKeys = new Set(
          [...target.records.bangumi, ...target.entities.bangumi].map((row) => `${row.source}\0${row.key}`),
        );
        target.records.bangumi.push(
          ...bookCross.records.bangumi.filter((row) => !existingRecordKeys.has(`${row.source}\0${row.key}`)),
        );
        target.entities.bangumi.push(
          ...bookCross.entities.bangumi.filter((row) => !existingRecordKeys.has(`${row.source}\0${row.key}`)),
        );
        const existingMemberKeys = new Set(target.members.map((row) => `${row.source}\0${row.key}`));
        target.members.push(...bookCross.members.filter((row) => !existingMemberKeys.has(`${row.source}\0${row.key}`)));
        const existingCreditKeys = new Set(
          target.credits.map((row) => `${row.kind}\0${row.work}\0${row.person}\0${row.roleCode}`),
        );
        target.credits.push(
          ...bookCross.credits.filter(
            (row) => !existingCreditKeys.has(`${row.kind}\0${row.work}\0${row.person}\0${row.roleCode}`),
          ),
        );
        const existingEdgeKeys = new Set(
          target.edges.map((row) => `${row.source}\0${row.holder}\0${row.target}\0${row.property}`),
        );
        target.edges.push(
          ...bookCross.edges.filter(
            (row) => !existingEdgeKeys.has(`${row.source}\0${row.holder}\0${row.target}\0${row.property}`),
          ),
        );
      }
    }
    const separator = String.fromCharCode(0);
    const publicationReadings = [...combinedResult.readings];
    const seenReadings = new Set(publicationReadings.map((row) => row.source + separator + row.externalId));
    for (const reading of books?.readings ?? []) {
      const key = reading.source + separator + reading.externalId;
      if (seenReadings.has(key)) continue;
      seenReadings.add(key);
      publicationReadings.push(reading);
    }
    const vocabularyRequirements = [
      ...(result.creditVocabularyRequirements ?? []),
      ...(books?.creditVocabularyRequirements ?? []),
      ...releaseClassificationRequirements,
      ...(bangumiVocabularyRequirements ?? []),
      ...tagVocabularyRequirements,
      ...characterVocabularyRequirements,
      ...vndbCreditVocabularyRequirements,
      ...vndbCharacterProfileVocabularyRequirements,
    ];
    if (journal && publicClient)
      showcase = await publishShowcase({
        plan: publicationPlan,
        result: {
          ...combinedResult,
          readings: publicationReadings,
          creditRoles: [...(combinedResult.creditRoles ?? []), ...(books?.creditRoles ?? [])],
          ...(vocabularyRequirements.length ? { creditVocabularyRequirements: vocabularyRequirements } : {}),
        },
        aliases: crossMediaAliases,
        journal,
        review: importPort,
        publicClient,
        ...(vocabularyRequirements.length ? { vocabularyRequirements } : {}),
        tagWeightObservations: publicTags.tagWeightObservations,
        tagWeightRefreshes: publicTags.tagWeightRefreshes,
      });
    const { bangumiGenrePublication, ...publicCombinedResult } = combinedResult;
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(
      resultPath,
      JSON.stringify(
        {
          ...publicCombinedResult,
          facts: {
            works: Object.fromEntries(result.facts.works),
            releases: Object.fromEntries(result.facts.releases),
          },
          ...(bangumiGenrePublication ? { bangumiGenreDiagnostics: bangumiGenrePublication.diagnostics } : {}),
          ...(showcase ? { showcase } : {}),
          ...(books
            ? {
                books: {
                  family: books.family,
                  selected: books.selected,
                  conversions: books.conversions,
                  identities: books.identities,
                  status: books.status,
                  gaps: books.gaps,
                  creditGaps: books.creditGaps,
                  creditRoles: books.creditRoles ?? [],
                  creditVocabularyRequirements: books.creditVocabularyRequirements ?? [],
                },
              }
            : {}),
          sourceDigests: Object.fromEntries(input.digests),
        },
        null,
        2,
      ) + '\n',
    );
    process.stdout.write(
      showcase
        ? 'Imported ' +
            (combinedResult.readings.length + (books?.readings.length ?? 0)) +
            ' records; publication ' +
            showcase.status +
            '; ' +
            showcase.omissions.length +
            ' bounded omissions. Result: ' +
            resultPath +
            '\n'
        : 'Imported ' +
            (combinedResult.readings.length + (books?.readings.length ?? 0)) +
            ' records; ' +
            (combinedResult.gaps.length +
              combinedResult.characterDiagnostics.length +
              combinedResult.vndbCreditDiagnostics.length +
              combinedResult.episodeDiagnostics.length +
              publicTags.gaps.length +
              (books?.gaps.length ?? 0)) +
            ' review gaps. Result: ' +
            resultPath +
            '\n',
    );
    ensure(
      !showcase || showcase.status === 'published',
      'Showcase publication is incomplete; rerun task seed:dev after resolving the listed gaps',
    );
  } finally {
    journal?.close();
  }
}
