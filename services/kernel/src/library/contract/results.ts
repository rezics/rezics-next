/** Application result types. Callers and tests alias these; adapters do not own them. */

import type { FollowCountRuntime } from './follow-counts.ts';
import type { LibraryActor } from './actors.ts';
import type { LibraryCapabilities } from './capabilities.ts';
import type { ProgressOperationApplication } from './progress-operations.ts';
import type { MembershipPage, NestedAdmissionAccount, OccurrenceDraft } from './membership.ts';
import type { CollectionSourceObservation, PreparedCollectionSource } from './source.ts';
import type { WorkAllowance, WorkReceipt } from './work-dimensions.ts';
import type { OwnerQueryInput, OwnerQueryOpen } from './owner-query.ts';

export type SourceCaptureResult = Readonly<{
  source: PreparedCollectionSource;
  work: WorkReceipt;
  privateWorking: boolean;
}>;

export type MemberPreparationResult = Readonly<{
  page: MembershipPage;
  admission: NestedAdmissionAccount;
  ownerFence: string | null;
}>;

export type PublicationAdmissionResult = Readonly<{
  admitted: boolean;
  phase: 'staging' | 'awaiting_activation' | 'unavailable';
  privateWorking: boolean;
  activatedPublic: boolean;
  locator: Readonly<{
    route: number;
    ownerAccountId: string;
    collectionId: string;
    publicationId: string;
  }> | null;
}>;

export type EntryProgressAdmission = Readonly<{
  admitted: boolean;
  actor: LibraryActor;
  deadline: number;
  original: string | null;
  terminal: string | null;
  admission: NestedAdmissionAccount;
}>;

export type LibraryDomain = LibraryCapabilities &
  Readonly<{
    followCounts?: FollowCountRuntime;
    ownerQuery: {
      open(input: OwnerQueryInput): Promise<OwnerQueryOpen>;
    };
    sourceCapture: {
      capture(input: {
        actor: LibraryActor;
        collectionId: string;
        deadline: number;
        at: unknown;
        allowance: WorkAllowance;
        logical?: boolean;
        ordinaryPage?: boolean;
      }): Promise<SourceCaptureResult>;
    };
    memberPreparation: {
      prepare(input: {
        actor: LibraryActor;
        collectionId: string;
        deadline: number;
        occurrences: readonly OccurrenceDraft[];
        filter?: unknown;
        releaseDigest?: string;
        ownerFence?: string | null;
        observation?: CollectionSourceObservation;
      }): Promise<MemberPreparationResult>;
    };
    publicationAdmission: {
      admit(input: {
        locator: PublicationAdmissionResult['locator'];
        privateWorking: boolean;
        observation: CollectionSourceObservation | null;
        episodePresent: boolean;
        initiator?: unknown;
      }): PublicationAdmissionResult;
    };
    entryProgress: {
      admit(input: {
        actor: LibraryActor;
        deadline: number;
        subjectId: string;
        at?: unknown;
      }): Promise<EntryProgressAdmission>;
    };
    progressOperations: ProgressOperationApplication;
  }>;
