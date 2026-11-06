import type { IdentityEpochParticipantPorts, IdentityParticipantStepPort } from './identity-epoch-ports.ts';
import type { IdentityJobRef, IdentityStepProgress } from './identity-values.ts';
import type { ItemDataType, ItemFactRow, ItemMetadata, ItemReleaseSlice, StoredItemFact } from './item-values.ts';

/** Deterministic digest used by item projection; the native hasher is bound by composition. */
export type HashPort = Readonly<{
  sha256Hex(canonical: string): string;
}>;

/** Route and derived-id selection; native encoding stays behind this port. */
export type RoutePort = Readonly<{
  routeOf(id: string): number | null;
  derivedId(namespace: string, name: string, route: number): string;
  partitionOf(route: number): number;
}>;

/** Library ALL-coverage participant plus Source custody observations for one identity job. */
export type LibraryCustodyPort<Native> = Readonly<{
  stepIdentityEpoch: IdentityParticipantStepPort<Native>;
  readSourcePage(
    native: Native,
    job: IdentityJobRef,
    after?: string | null,
  ): Promise<IdentityStepProgress | { state: 'unavailable'; reason: 'missing-job' | 'unready' }>;
}>;

/** Search canonical-index currentness for one identity job. */
export type SearchCurrentnessPort<Native> = Readonly<{
  stepCanonicalIndex: IdentityParticipantStepPort<Native>;
}>;

export type ContentImportedFieldGroup = 'facts' | 'summary' | 'cover';
export type ContentQueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};
export type ContentCoverSource = Readonly<{
  source: string;
  external_id: string;
  field_group: ContentImportedFieldGroup;
}>;
export type ContentCoverObligation = 'cc:Attribution' | 'cc:ShareAlike' | 'cc:Notice' | 'cc:SourceCode';
export type ContentCoverCredit = Readonly<{
  rightsHolder: string;
  via: Readonly<{ name: string; url: string }>;
  license: string;
  obligations: ContentCoverObligation[];
}>;
export type ContentCoverRef = Readonly<{
  id: string;
  digest: string;
  containerId: string;
  source: ContentCoverSource;
  width?: number;
  height?: number;
  placeholder?: Readonly<{ thumbhash: string; color: string }>;
  variants?: readonly Readonly<{ format: 'avif' | 'webp'; width: number }>[];
  focalPoint?: Readonly<{ x: number; y: number }> | null;
  credit?: ContentCoverCredit;
}>;

/** Content cover availability and imported-tuple home selection. */
export type ContentLifecyclePort = Readonly<{
  checkCover(client: ContentQueryClient, id: string): Promise<ContentCoverRef | null>;
  checkCovers(client: ContentQueryClient, ids: readonly string[]): Promise<Map<string, ContentCoverRef | null>>;
  importedTupleRoute(routeKey: Uint8Array, source: string, externalId: string): number;
}>;

/** Rating maps Semantic review outcomes onto its owned stale/unavailable errors. */
export type RatingReviewPort = Readonly<{
  subjectChanged(): Error;
  identityEpochChanged(): Error;
  pending(): Error;
  moved(home: number): Error;
  absent(): Error;
  undisclosed(): Error;
  unavailable(): Error;
  foreignControl(): Error;
}>;

/** Released native-home epoch witness used by Rating vote review. */
export type IdentityRatingEpochObservation = Readonly<{ partition: number; epoch: string }>;

export type SubjectFactStorePort<Tx> = Readonly<{
  writeFacts(
    tx: Tx,
    input: {
      route: number;
      subject_id: string;
      transaction_id: string;
      facts: readonly StoredItemFact[];
    },
  ): Promise<void>;
  initializeIdentity(tx: Tx, original: string): Promise<void>;
}>;

/** Fixed, versioned Semantic domain composition. Extra keys are dropped at install. */
export type SemanticDomainPorts<Native, Tx = unknown> = Readonly<{
  version: 1;
  identityEpoch: IdentityEpochParticipantPorts<Native>;
  libraryCustody: LibraryCustodyPort<Native>;
  searchCurrentness: SearchCurrentnessPort<Native>;
  ratingReview: RatingReviewPort;
  contentLifecycle: ContentLifecyclePort;
  hashing: HashPort;
  routing: RoutePort;
  facts: SubjectFactStorePort<Tx>;
}>;

export type ItemProjectionRequest = Readonly<{
  subjectId: string;
  input: unknown;
  type?: string;
  release?: ItemReleaseSlice;
}>;

export type ItemResolveRequest = Readonly<{
  subjectId: string;
  rows: readonly ItemFactRow[];
  type: string;
  dataTypes: Readonly<Record<string, ItemDataType>>;
  metadata: ItemMetadata;
}>;
