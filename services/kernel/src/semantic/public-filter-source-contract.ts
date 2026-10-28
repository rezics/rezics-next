import type { Source } from '@rezics/definitions/bulk';
import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import type { AuthoritativeTime, CommandTransaction } from '../command/command.ts';
import type { SourceFenceTuple } from '../content/source-fences.ts';
import type { Partition } from '../partition/partition.ts';
import type { Access } from '../request/access.ts';
import type { FilterStatement } from '@rezics/filter';
import type { SearchPlan } from '../search/query.ts';
import type { IndexedStatement } from '../search/source.ts';
import type { Statement } from './item.ts';

/** Specification only. No runtime export, default composition or authorization certificate. */
export type PublicFilterCost = Readonly<{
  inputKeys: number;
  candidates: number;
  accessPoints: number;
  dependencyPoints: number;
  engineSearches: number;
  engineIteratorSteps: number;
  outputSlots: number;
  resultWrites: number;
  frontierWrites: number;
}>;

/** A home is the existing native partition, not an account or identity-group member. */
export type PublicFilterHome = Partition['partitionNo'];
export type PrivacyReductionHead = Readonly<{
  partition: PublicFilterHome;
  epoch: Partition['epoch'];
  position: bigint;
}>;

export type PublicFilterDependency =
  | Readonly<{ kind: 'subject'; route: number; subject: string }>
  | Readonly<{ kind: 'selection'; route: number; subject: string; slot: string; candidate: string }>
  | Readonly<{ kind: 'sourceTuple'; tuple: SourceFenceTuple }>
  | Readonly<{ kind: 'consent'; route: number; account: string; subject: string; candidate: string }>
  | Readonly<{ kind: 'collection'; route: number; collection: string }>;

/** Local selection evidence; dependency heads separately invalidate foreign changes. */
export type PublicFilterProjectionObservation = Readonly<{
  partition: PublicFilterHome;
  epoch: Partition['epoch'];
  position: Partition['position'];
  subject: string;
  terminal: string;
  revision: number;
  securityRevision: string;
  currentRelease: string;
}>;

export type PublicFilterProjectionMeaning = Readonly<{
  /** Exact stored release digest, validated against releaseDigest(release). */
  digest: string;
  release: Release;
  type: string;
}>;

export type PublicFilterProjectionRecord = Readonly<{
  subject: string;
  terminal: string;
  slot: string;
  candidate: string;
  revision: number;
  release: string;
  rank: 'normal' | 'preferred';
  ordinal: number;
  source: Source | null;
  /** Native value/qualifiers retain datatype, units, unknown values and association. */
  statement: Statement;
  /** Existing matcher representation; never the only identity or provenance. */
  indexed: IndexedStatement;
  dependencies: readonly PublicFilterDependency[];
}>;

/** Opaque durable build reference, never a serialized whole subject or saved verdict. */
export type PublicFilterProjectionFrontier = Readonly<{ build: string; generation: bigint; continuation: string }>;
export type PublicFilterProjectionRequest = Readonly<{
  subject: string;
  meaning: PublicFilterProjectionMeaning;
  /** Includes rejects, rereads and lookahead; 1..1000, not just output LIMIT. */
  inputLimit: number;
  frontier: PublicFilterProjectionFrontier | null;
}>;

type Unready = Readonly<{
  status: 'unready';
  reason: 'owner_pending' | 'identity_pending' | 'dependency_pending' | 'metadata_missing';
  cost: PublicFilterCost;
}>;
type Unavailable = Readonly<{
  status: 'unavailable';
  reason: 'missing_owner' | 'moved' | 'deadline' | 'dependency_unavailable';
  cost: PublicFilterCost;
}>;
export type PublicFilterProjectionPage =
  | Readonly<{
      status: 'progress';
      source: PublicFilterProjectionObservation;
      records: readonly PublicFilterProjectionRecord[];
      repairLocators: readonly PublicFilterRepairLocator[];
      frontier: PublicFilterProjectionFrontier;
      cost: PublicFilterCost;
    }>
  | Readonly<{
      status: 'complete';
      source: PublicFilterProjectionObservation;
      records: readonly PublicFilterProjectionRecord[];
      repairLocators: readonly PublicFilterRepairLocator[];
      /** Completes this build's earlier pages, not merely this last page. */
      frontier: PublicFilterProjectionFrontier;
      /** Bounded heads from this step; the retained build holds earlier dependency observations. */
      requiredHeads: readonly PrivacyReductionHead[];
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'changed'; frontier: PublicFilterProjectionFrontier; cost: PublicFilterCost }>
  | Unready
  | Unavailable;

/** Keys are released filter properties or actual Search order declarations, never labels/Concept IDs. */
export type PublicFilterDependencyKey =
  | Readonly<{ kind: 'property'; property: FilterStatement['property'] }>
  | Readonly<{ kind: 'type' }>
  | Readonly<{ kind: 'order'; order: SearchPlan['sort'] }>;

/** Internal routing includes selected but ineligible inputs; never publish these IDs as public facts. */
export type PublicFilterRepairLocator = Readonly<{
  subject: string;
  slot: string;
  candidate: string;
  property: FilterStatement['property'];
  dependencies: readonly PublicFilterDependency[];
}>;

export type PrivacyReductionImpact =
  | Readonly<{ kind: 'subject'; route: number; subject: string }>
  | Readonly<{ kind: 'keys'; route: number; subject: string; keys: readonly PublicFilterDependencyKey[] }>
  /** Must resolve to affected SOURCE keys through complete internal routing before noEffect or ACK. */
  | Readonly<{ kind: 'dependency'; locator: PublicFilterDependency }>;

export type PrivacyReduction = Readonly<{
  /** The authoritative command's home, checked against currentCommand(tx).partition. */
  partition: PublicFilterHome;
  transactionId: string;
  time: AuthoritativeTime;
  cause: 'subject' | 'candidate' | 'selection' | 'sourceTuple' | 'consent' | 'collection';
  /** 1..1000 bounded affected identities, no fact bodies or copied permissions. */
  affected: readonly PublicFilterDependency[];
  impacts: readonly PrivacyReductionImpact[];
}>;
export type PrivacyReductionLogEntry = Readonly<{
  head: PrivacyReductionHead;
  transactionId: string;
  cause: PrivacyReduction['cause'];
  affected: readonly PublicFilterDependency[];
  impacts: readonly PrivacyReductionImpact[];
}>;
export type PrivacyReductionLogRequest = Readonly<{
  partition: PublicFilterHome;
  epoch: Partition['epoch'];
  after: bigint;
  through: bigint;
  inputLimit: number;
}>;
export type PrivacyReductionLogPage =
  | Readonly<{
      status: 'progress' | 'complete';
      head: PrivacyReductionHead;
      entries: readonly PrivacyReductionLogEntry[];
      /** Last examined key, including rejected records. Never advance past unexamined lookahead. */
      after: bigint;
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'changed'; cost: PublicFilterCost }>
  | Unready
  | Unavailable;
/** Identity of a Search-owned registered consumer; this is a locator, never supplied ACK truth. */
export type PublicFilterConsumer = Readonly<{
  physicalTarget: string;
  incarnation: string;
  consumerGeneration: string;
  projectionGeneration: string;
  /** null only when that consumer has no meaning/read-definition dependency. */
  meaningDigest: string | null;
  readDefinition: string | null;
}>;

/** Native retained consistent cut, NOT a wall clock, UUID order, head vector or permission certificate. */
export type PrivacyReductionStart = Readonly<{ observation: string }>;
export type PrivacyReductionObservationRequest =
  | Readonly<{ kind: 'home'; partition: PublicFilterHome }>
  | Readonly<{
      kind: 'population';
      /** null means NO acknowledgement exists: every nonzero head is behind. */
      consumer: PublicFilterConsumer | null;
      /** null records the start; otherwise revalidate that exact native cut. */
      start: PrivacyReductionStart | null;
    }>;
export type PrivacyReductionObservation =
  | Readonly<{
      status: 'home';
      head: PrivacyReductionHead;
      cost: PublicFilterCost;
    }>
  | Readonly<{
      status: 'observed';
      coverage: 'all_native_homes';
      start: PrivacyReductionStart;
      /** Current heads only for behind/changed homes, not a 4096-entry vector. */
      unacknowledged: readonly PrivacyReductionHead[];
      changed: readonly PrivacyReductionHead[];
      /** False means native foreign routing cannot establish irrelevance; queries prepare. */
      routingComplete: boolean;
      cost: PublicFilterCost;
    }>
  | Unready
  | Unavailable;

/** Future semantic/public-filter-source.ts export publicFilterSource, additive to subjectSource. */
export type PublicFilterSource = Readonly<{
  readPublicFilterProjectionPage(request: PublicFilterProjectionRequest): Promise<PublicFilterProjectionPage>;
  readPrivacyReductionHeads(request: PrivacyReductionObservationRequest): Promise<PrivacyReductionObservation>;
  readPrivacyReductionPage(request: PrivacyReductionLogRequest): Promise<PrivacyReductionLogPage>;
}>;
export type PublicFilterSourceFactory = (
  config: Readonly<{
    pool: Pool;
    routeKey: Uint8Array;
    access: Access;
  }>,
) => PublicFilterSource;

/** Future named export recordPrivacyReduction in the same module. Must not open another transaction. */
export type RecordPrivacyReduction = (
  tx: CommandTransaction,
  reduction: PrivacyReduction,
) => Promise<PrivacyReductionLogEntry>;

/** Evidence requirements only. Search owns actual ACK storage/writer and admission interfaces. */
export type PublicFilterAcknowledgementNeeds = Readonly<{
  consumer: PublicFilterConsumer;
  started: PrivacyReductionStart;
  revalidated: PrivacyReductionObservation;
  filterAndOrderKeys: readonly PublicFilterDependencyKey[];
  returnedSubjects: readonly string[];
  /** Contiguous prefixes established by actual native ACK reads for this consumer. */
  refreshVisible: readonly PrivacyReductionHead[];
  dependentForeignRepairComplete: boolean;
  dependencyRegistrationComplete: boolean;
  sourceAndSinkVersionsFenced: boolean;
  identityEpochPending: boolean;
}>;
