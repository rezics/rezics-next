import type { Source } from '@rezics/definitions/bulk';
import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import type { AuthoritativeTime, CommandTransaction } from '../command/command.ts';
import type { SourceFenceTuple } from '../content/source-fences.ts';
import type { Partition } from '../partition/partition.ts';
import type { Access } from '../request/access.ts';
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
export type PrivacyHead = Readonly<{
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
export type PublicFacetSource = Readonly<{
  partition: PublicFilterHome;
  epoch: Partition['epoch'];
  position: Partition['position'];
  subject: string;
  terminal: string;
  revision: number;
  securityRevision: string;
  currentRelease: string;
}>;

export type PublicFacetMeaning = Readonly<{
  /** Exact stored release digest, validated against releaseDigest(release). */
  digest: string;
  release: Release;
  type: string;
}>;

export type PublicFacetRecord = Readonly<{
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
export type PublicFacetFrontier = Readonly<{ build: string; generation: bigint; continuation: string }>;
export type PublicFacetRequest = Readonly<{
  subject: string;
  meaning: PublicFacetMeaning;
  /** Includes rejects, rereads and lookahead; 1..1000, not just output LIMIT. */
  inputLimit: number;
  frontier: PublicFacetFrontier | null;
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
export type PublicFacetPage =
  | Readonly<{
      status: 'progress';
      source: PublicFacetSource;
      records: readonly PublicFacetRecord[];
      frontier: PublicFacetFrontier;
      cost: PublicFilterCost;
    }>
  | Readonly<{
      status: 'complete';
      source: PublicFacetSource;
      records: readonly PublicFacetRecord[];
      /** Completes this build's earlier pages, not merely this last page. */
      frontier: PublicFacetFrontier;
      requiredHeads: readonly PrivacyHead[];
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'changed'; frontier: PublicFacetFrontier; cost: PublicFilterCost }>
  | Unready
  | Unavailable;

export type PrivacyReduction = Readonly<{
  /** The authoritative command's home, checked against currentCommand(tx).partition. */
  partition: PublicFilterHome;
  transactionId: string;
  time: AuthoritativeTime;
  cause: 'subject' | 'candidate' | 'selection' | 'sourceTuple' | 'consent' | 'collection';
  /** 1..1000 bounded affected identities, no fact bodies or copied permissions. */
  affected: readonly PublicFilterDependency[];
}>;
export type PrivacyLogEntry = Readonly<{
  head: PrivacyHead;
  transactionId: string;
  cause: PrivacyReduction['cause'];
  affected: readonly PublicFilterDependency[];
}>;
export type PrivacyLogRequest = Readonly<{
  partition: PublicFilterHome;
  epoch: Partition['epoch'];
  after: bigint;
  through: bigint;
  inputLimit: number;
}>;
export type PrivacyLogPage =
  | Readonly<{
      status: 'progress' | 'complete';
      head: PrivacyHead;
      entries: readonly PrivacyLogEntry[];
      /** Last examined key, including rejected records. Never advance past unexamined lookahead. */
      after: bigint;
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'changed'; cost: PublicFilterCost }>
  | Unready
  | Unavailable;
export type PrivacyHeadsPage =
  | Readonly<{
      status: 'observed';
      /** Exactly the requested homes, including explicitly initialized pristine zero heads. */
      heads: readonly PrivacyHead[];
      cost: PublicFilterCost;
    }>
  | Unready
  | Unavailable;

/** Future semantic/public-filter-source.ts export publicFilterSource, additive to subjectSource. */
export type PublicFilterSource = Readonly<{
  pagePublicFacets(request: PublicFacetRequest): Promise<PublicFacetPage>;
  readPrivacyHeads(partitions: readonly PublicFilterHome[]): Promise<PrivacyHeadsPage>;
  pagePrivacyLog(request: PrivacyLogRequest): Promise<PrivacyLogPage>;
}>;
export type PublicFilterSourceFactory = (
  config: Readonly<{
    pool: Pool;
    routeKey: Uint8Array;
    access: Access;
  }>,
) => PublicFilterSource;

/** Future named export recordPrivacyReduction in the same module. Must not open another transaction. */
export type RecordPrivacyReduction = (tx: CommandTransaction, reduction: PrivacyReduction) => Promise<PrivacyLogEntry>;

/** Names only the consumer's evidence needs; Search owns its writer, storage and admission interface. */
export type PublicFilterAcknowledgementNeeds = Readonly<{
  started: readonly PrivacyHead[];
  revalidated: readonly PrivacyHead[];
  refreshVisible: readonly PrivacyHead[];
  dependentForeignRepairComplete: boolean;
  dependencyRegistrationComplete: boolean;
  sourceAndSinkVersionsFenced: boolean;
  identityEpochPending: boolean;
}>;
