import { createHash } from 'node:crypto';
import type { SourceRecord } from '@rezics/conversion';
import { sourceDigest, type VndbPublicTagCategory } from '@rezics/conversion';
import type { BatchCommand, BatchStatement } from '@rezics/definitions/bulk';
import type { GraphEdgeDraft } from './cross-media-bindings.ts';
import type { BangumiCreatorCreditDraft } from './bangumi-creator-credits.ts';
import type { createImportTransport } from './import-client.ts';
import type { BangumiCoverSource, BangumiPersonCareerSource, CrossMediaMediaOutcome } from './showcase-media.ts';
import type { ShowcaseWorkLink } from './showcase-work-links.ts';
import type { VndbReleasePlatformFacts } from './vndb-release-platforms.ts';
import type { VndbTagRatingObservation } from './showcase-vndb-tag-ratings.ts';

export type Provider = 'bangumi' | 'vndb';
export type Franchise = 'steins-gate' | 'clannad' | 'fate';
type Row = Record<string, unknown>;

const franchisePatterns: Record<Franchise, RegExp> = {
  'steins-gate': /^(?:STEINS[;；]GATE|シュタインズ[・･]ゲート|命运石之门)(?:$|[\s:：0])/i,
  clannad: /^CLANNAD(?:$|[\s:：])/i,
  fate: /^(?:Fate\s*[/／]|フェイト\s*[/／])/i,
};

/** Selected-family aliases. Ordinary CLI aliases remain the provider default. */
export const crossMediaAliases = Object.freeze({ bangumi: 'bangumi_cross_media', vndb: 'vndb_cross_media' } as const);

/** Cover + creator + character image slots admitted by one selected Bangumi pass. */
export const showcaseMediaLimit = 256 + 64 + 256;

export const showcaseLimits = Object.freeze({
  records: 768,
  media: showcaseMediaLimit,
  candidates: 8192,
  vocabulary: 512,
  candidatesPerRecord: 128,
  reviewPage: 100,
  omissions: 320,
});

/** Membership uses titles only, never synopsis mentions, credits or a shared actor. */
export function crossMediaFranchise(...names: unknown[]): Franchise | undefined {
  return (Object.keys(franchisePatterns) as Franchise[]).find((family) =>
    names.some((name) => typeof name === 'string' && franchisePatterns[family].test(name.trim())),
  );
}

export type CrossMediaTableScanLimits = {
  maxRows: number;
  maxBytes: number;
  consumeRow?: (bytes: number) => void;
  /** Byte offset of the first unread dump line for a bounded continuation page. */
  resumeBytes?: number;
};

export class CrossMediaTableScanLimitError extends Error {
  constructor(
    readonly provider: Provider,
    readonly table: string,
    readonly resumeBytes = 0,
  ) {
    super(`Cross-media ${provider}/${table} exceeded its bounded scan`);
    this.name = 'CrossMediaTableScanLimitError';
  }
}

/** A duplicate module instance can produce the same named scan-limit error. */
export function isCrossMediaTableScanLimitError(error: unknown): error is CrossMediaTableScanLimitError {
  return (
    error instanceof CrossMediaTableScanLimitError ||
    (error instanceof Error && error.name === 'CrossMediaTableScanLimitError')
  );
}

function scanResumeBytes(error: { resumeBytes?: unknown }): number {
  return typeof error.resumeBytes === 'number' && Number.isSafeInteger(error.resumeBytes) && error.resumeBytes >= 0
    ? error.resumeBytes
    : 0;
}

/** Read bounded pages until selected rows are present, EOF, or a page cannot advance. */
export async function collectSelectedDumpRows(
  input: CrossMediaTables,
  provider: Provider,
  table: string,
  options: {
    limits: CrossMediaTableScanLimits;
    select: (row: Row) => boolean;
    onRow: (row: Row) => void;
    done?: () => boolean;
    onLimit: () => void;
  },
): Promise<void> {
  let resumeBytes = options.limits.resumeBytes ?? 0;
  for (;;) {
    if (options.done?.()) return;
    let advanced = 0;
    try {
      for await (const row of input.rows(provider, table, { ...options.limits, resumeBytes })) {
        advanced += 1;
        if (!options.select(row)) continue;
        options.onRow(row);
        if (options.done?.()) return;
      }
      return;
    } catch (error) {
      if (!isCrossMediaTableScanLimitError(error)) throw error;
      const next = scanResumeBytes(error);
      if (advanced === 0 || next <= resumeBytes) {
        options.onLimit();
        return;
      }
      resumeBytes = next;
    }
  }
}

export interface CrossMediaTables {
  rows(provider: Provider, table: string, limits?: CrossMediaTableScanLimits): AsyncIterable<Row>;
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
  workLinkSnapshot?: { scope: string[]; digest: string; complete: boolean };
  credits: BangumiCreatorCreditDraft[];
  franchises: Record<Franchise, { bangumi: string[]; vndb: string[] }>;
  members: CrossMediaMember[];
  /** Actual selected type-2 anime appearances. */
  characterAppearances?: BangumiCharacterAppearance[];
  /** Actual selected type-4 Game appearances, kept separate from anime. */
  gameCharacterAppearances?: BangumiCharacterAppearance[];
  /** Exact Bangumi person identities admitted by the finite selected-family people cap. */
  creatorImageKeys?: readonly string[];
  gaps: CrossMediaGap[];
  relationScope: string[];
  relationSnapshotDigest: string;
  relationSnapshotComplete: boolean;
  /** Bounded selected VN relation evidence, independent of the Bangumi source generation. */
  vndbRelationSnapshot?: { scope: string[]; digest: string; complete: boolean };
  /** Selected-family VNDB release dates/states for the common showcase publisher. */
  releaseFacts?: CrossMediaReleaseFacts;
  /** Exact selected VNDB release platform and medium rows for source-vocabulary admission. */
  releasePlatforms?: ReadonlyMap<string, VndbReleasePlatformFacts>;
  coverSources?: readonly BangumiCoverSource[];
  /** Exact API receipts for careers and PersonDetail dates read from selected Bangumi Person records. */
  personCareerSources?: readonly BangumiPersonCareerSource[];
  personSources?: readonly BangumiPersonCareerSource[];
  /** Exact API receipts for selected creator images acquired from PersonDetail. */
  creatorImageSources?: readonly BangumiCoverSource[];
};

export type CrossMediaSelection = {
  bangumi: readonly number[];
  vndb: readonly string[];
  includeReleases?: boolean;
  peoplePerProvider?: number;
};

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

/** Selected review and fence capability; producers take this from the contract, not publication. */
export type ShowcaseReviewPort = Pick<
  ReturnType<typeof createImportTransport>,
  'readReviewedSubject' | 'reviewedCandidates' | 'acceptReviewedCandidate' | 'adoptReviewedCandidates'
> &
  Partial<Pick<ReturnType<typeof createImportTransport>, 'fence'>>;

export type CrossMediaReading = {
  /** Original claim target; independent reads may return its canonical Subject. */
  boundSubjectId?: string;
  source: Provider;
  externalId: string;
  subject: Awaited<ReturnType<ReturnType<typeof createImportTransport>['readReviewedSubject']>>;
  route: string;
  selection: 'selected' | 'proposed';
};

export type ShowcaseKind =
  | 'work'
  | 'person'
  | 'character'
  | 'release'
  | 'episode'
  | 'source-vocabulary'
  | 'organization';

export type ShowcaseAcknowledgement = Readonly<{
  command: BatchCommand;
  subjectId?: string;
  candidateId?: string;
  commandDigest: string;
}>;

export type ShowcaseAssertion = Readonly<{
  commandKey: string;
  candidateId: string;
  candidateDigest: string;
  /** Selected work owning an exact source-row assertion whose envelope has its own row key. */
  ownerKey?: string;
  /** Exact selected source-parent row attached to a Concept assertion. */
  tagParentPath?: string;
  property: string;
  source: BatchCommand['source'];
  statement: BatchStatement;
  rights?: Extract<BatchCommand, { op: 'propose' }>['rights'];
  citations: readonly string[];
  graphTarget?: Readonly<{
    provider: 'bangumi' | 'vndb';
    sourceKey: string;
    subjectId: string;
    nativeType: string;
    /** Work-row publication checks the current facts fence at both source endpoints. */
    factsFence?: true;
  }>;
}>;

export type ShowcaseRecord = Readonly<{
  provider: 'bangumi' | 'vndb';
  sourceAlias: string;
  sourceKey: string;
  sourceUri: string | null;
  sourceRevision: string;
  rawDigest: string;
  semanticDigest: string;
  converterRevision: string;
  kind: ShowcaseKind;
  subjectId: string | null;
  nativeType: string | null;
  readerRoute: string | null;
  assertions: readonly ShowcaseAssertion[];
}>;

export type ShowcaseVocabularyRecord = Readonly<{
  provider: 'bangumi' | 'vndb';
  sourceAlias: string;
  sourceKey: string;
  sourceUri: string | null;
  subjectId: string;
  nativeType: 'skos:ConceptScheme' | 'skos:Concept';
  schemeId: string | null;
  schemeUri?: string;
  provenance?: 'reviewed-catalogue' | 'source-parent-binding';
  assertions: readonly ShowcaseAssertion[];
}>;

/** Exact, bounded source vocabulary requirements supplied by a provider adapter. */
export type ShowcaseVocabularyRequirement = Readonly<{
  provider: 'bangumi' | 'vndb';
  ownerKey: string;
  sourceKey: string;
  source: BatchCommand['source'];
  sourceUri: string;
  nativeType: 'skos:ConceptScheme' | 'skos:Concept';
  schemeId?: string;
}>;

/** Exact selected COPY association and the current native vocabulary identity it resolves through. */
export type ShowcaseTagAssociation = Readonly<{
  workId: string;
  sourceKey: string;
  tagId: string;
  category: VndbPublicTagCategory;
  spoiler: number;
  conceptId: string | null;
  schemeId: string | null;
  conceptUri: string;
  schemeUri: string;
  releaseDigest: string;
}>;

/** Exact selected COPY associations withheld by required source-parent admission. */
export type ShowcaseTagAssociationWithdrawal = Readonly<{
  workId: string;
  sourceKey: string;
  tagId: string;
}>;

/** Source parent evidence joined to exact current Concept and category Scheme identities, before hierarchy admission. */
export type ShowcaseTagParentBinding = Readonly<{
  child: string;
  parent: string;
  main: boolean;
  category: VndbPublicTagCategory;
  path: string;
  childId: string;
  parentId: string;
  schemeId: string;
  childUri: string;
  parentUri: string;
  schemeUri: string;
  releaseDigest: string;
}>;

/** A complete selected dictionary row set that permits retiring stale source parent assertions. */
export type ShowcaseTagParentRefresh = Readonly<{
  category: VndbPublicTagCategory;
  tagId: string;
  childId: string;
  schemeId: string;
  childUri: string;
  schemeUri: string;
  releaseDigest: string;
}>;

export type ShowcaseTagParentPublication = Readonly<{
  path: string;
  childId: string;
  parentId: string;
  schemeId: string;
  status: 'proposed' | 'public' | 'withheld';
  candidateId?: string;
  rights?: ShowcaseAssertion['rights'];
  reason?: string;
}>;

export function showcaseVocabularyExternalId(sourceKey: string): string {
  if (!/^[a-z][a-z0-9_.:-]{0,127}$/u.test(sourceKey)) throw new TypeError('Invalid showcase vocabulary source key');
  return `vocabulary:${sourceKey}`;
}

export type ShowcaseOmission = Readonly<{
  provider: 'bangumi' | 'vndb';
  sourceKey: string;
  code:
    | 'source-read-missing'
    | 'candidate-ack-missing'
    | 'candidate-limit'
    | 'vocabulary-binding-missing'
    | 'source-claim-withheld'
    | 'cover-source-absent'
    | 'cover-source-unavailable'
    | 'cover-source-invalid'
    | 'cover-pending'
    | 'cover-rejected'
    | 'cover-refused'
    | 'cover-unknown'
    | 'cover-fenced'
    | 'cover-candidate-missing'
    | 'cover-not-public'
    | 'graph-endpoint-unavailable'
    | 'graph-endpoint-mismatch';
}>;

export type ShowcaseMediaRecord = Readonly<{
  sourceAlias: string;
  sourceKey: string;
  sourceUri: string;
  sourceRevision: string;
  archiveDigest: string;
  responseDigest?: string;
  etag?: string;
  sourceUrl?: string;
  status: CrossMediaMediaOutcome['status'];
  mediaState?: CrossMediaMediaOutcome['mediaState'];
  containerId: string | null;
  mediaId?: string;
  credit?: CrossMediaMediaOutcome['credit'];
  provenance?: CrossMediaMediaOutcome['provenance'];
  candidateId?: string;
  candidateDigest?: string;
  readHandoff?: { subjectId: string; readerRoute: string; property: 'schema:image'; value: string };
  gap?: string;
}>;

export type ShowcaseManifest = Readonly<{
  version: 1;
  digest: string;
  records: readonly ShowcaseRecord[];
  vocabulary: readonly ShowcaseVocabularyRecord[];
  media: readonly ShowcaseMediaRecord[];
  tagAssociations?: readonly ShowcaseTagAssociation[];
  tagAssociationWithdrawals?: readonly ShowcaseTagAssociationWithdrawal[];
  tagAssociationRefreshes?: readonly string[];
  tagParentEvidence?: readonly ShowcaseTagParentBinding[];
  tagParentGaps?: readonly CrossMediaGap[];
  tagParentRefreshes?: readonly ShowcaseTagParentRefresh[];
  tagParentPublications?: readonly ShowcaseTagParentPublication[];
  tagWeightObservations: readonly VndbTagRatingObservation[];
  tagWeightRefreshes: readonly string[];
  omissions: readonly ShowcaseOmission[];
}>;

export function showcaseDigest(value: unknown): string {
  return createHash('sha256').update(sourceDigest(value)).digest('hex');
}

export function showcaseSourceMatches(
  actual: BatchCommand['source'] | null,
  expected: BatchCommand['source'],
): boolean {
  return !!actual && showcaseDigest(actual) === showcaseDigest(expected);
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
  rows: readonly Record<string, unknown>[],
): { titles: Record<string, unknown>[]; overflow: Record<string, unknown>[]; duplicates: Record<string, unknown>[] } {
  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];
  const duplicates: Record<string, unknown>[] = [];
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

export function showcasePlanRecordDigest(plan: CrossMediaPlan): {
  records: { bangumi: unknown; vndb: unknown };
  entities: { bangumi: unknown; vndb: unknown };
} {
  const records = (rows: readonly SourceRecord[]) =>
    rows.map((row) => ({
      source: row.source,
      key: row.key,
      revision: row.revision,
      digest: sourceDigest(row.payload),
    }));
  return {
    records: { bangumi: records(plan.records.bangumi), vndb: records(plan.records.vndb) },
    entities: { bangumi: records(plan.entities.bangumi), vndb: records(plan.entities.vndb) },
  };
}
