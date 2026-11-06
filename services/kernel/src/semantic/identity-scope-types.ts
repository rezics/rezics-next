import type { CommandTransaction } from '../command/command.ts';
import type {
  NativeSourceCapture,
  NativeSourceFrontier,
  NativeSourceIdentity,
} from '../library/native-source-custody.ts';
import type { NativePublicOutputIdentity } from '../library/native-source-output-types.ts';
import type { WorkAllowance, WorkReceipt } from '../library/contract/work-dimensions.ts';
import type { IdentityJobRef, IdentityNativeReceipt } from './identity-epoch-contract.ts';
import type { IdentityReceivingRecord, IdentityReceivingSelection } from './identity-receiving-effects-types.ts';
import type { NativePublicSource } from './public-filter-source-binding.ts';
import type { PublicIdentityOutputCapture } from './identity-public-output-types.ts';
import type { PublicIdentitySourceCapture } from './identity-scoped-public-source.ts';

export type IdentityScopeLibraryIdentity = NativeSourceIdentity | NativePublicOutputIdentity;
export type IdentityScopeLibraryCapture = Omit<NativeSourceCapture, 'identity'> &
  Readonly<{ identity: IdentityScopeLibraryIdentity }>;

/** Source identity is a locator. Registration always resolves the native retained capture. */
export type IdentityScopeSource =
  | Readonly<{ kind: 'library'; identity: IdentityScopeLibraryIdentity }>
  | Readonly<{ kind: 'public'; identity: NativePublicSource }>;
export type IdentityScopeKey = Readonly<{ source: IdentityScopeSource; scopeId: string }>;
export type IdentityScopeWork = Readonly<{
  rows: number;
  points: number;
  statements: number;
  bytes: number;
  /** Complete eight-axis debit for the explicit public-output branch, instead of its legacy projection. */
  outputWork?: WorkReceipt;
}>;
export type IdentityScopeFailure = Readonly<{
  status: 'unavailable' | 'stale';
  reason:
    | 'source_unready'
    | 'capture_incomplete'
    | 'owner_moved'
    | 'pending_claim'
    | 'summary_missing'
    | 'custody_missing'
    | 'deadline';
  work: IdentityScopeWork;
}>;
export type IdentityScopeCapture =
  | Readonly<{
      kind: 'library';
      capture: IdentityScopeLibraryCapture;
      frontier: NativeSourceFrontier;
      allowance: WorkAllowance;
    }>
  | Readonly<{ kind: 'public'; capture: PublicIdentitySourceCapture }>
  | Readonly<{ kind: 'public-output'; capture: PublicIdentityOutputCapture; allowance: WorkAllowance }>;
export type IdentityScopeRegistration = Readonly<{
  key: IdentityScopeKey;
  capture: IdentityScopeCapture;
  deadline: number;
}>;
/** Only the committed revision belongs in the existing Source/cursor basis. No allocated epoch. */
export type IdentityScopeObservation = Readonly<{
  key: IdentityScopeKey;
  captureId: string;
  committedRevision: bigint;
}>;
export type IdentityScopeRegistrationResult =
  | IdentityScopeFailure
  | Readonly<{
      status: 'registered';
      observation: IdentityScopeObservation;
      work: IdentityScopeWork;
    }>
  | Readonly<{ status: 'pending'; work: IdentityScopeWork }>;
export type IdentityScopeArmInput = Readonly<{
  key: IdentityScopeKey;
  job: IdentityJobRef;
  attempt: IdentityNativeReceipt;
  receiving: IdentityReceivingSelection;
  deadline: number;
}>;
export type IdentityScopeArmResult =
  | IdentityScopeFailure
  | Readonly<{
      status: 'armed' | 'pending';
      scope: IdentityScopeKey;
      job: IdentityJobRef;
      work: IdentityScopeWork;
    }>;
export type IdentityScopeFinishInput = Readonly<{
  key: IdentityScopeKey;
  job: IdentityJobRef;
  attempt: IdentityNativeReceipt;
  /** Locators only. finish resolves each exact native receiving record in its own home. */
  records?: readonly IdentityReceivingRecord[];
  /** One original reservation, shared with native enumeration and final Source guards. */
  allowance: WorkAllowance;
  deadline: number;
}>;
export type IdentityScopeFinishResult =
  | IdentityScopeFailure
  | Readonly<{
      status: 'finished' | 'pending';
      scope: IdentityScopeKey;
      committedRevision: bigint;
      work: IdentityScopeWork;
    }>;
export type IdentityScopeRevalidateInput = Readonly<{
  key: IdentityScopeKey;
  expected: IdentityScopeObservation;
  deadline: number;
  /** Required for public-output current validation; transferred from the caller's existing frame. */
  allowance?: WorkAllowance;
  /** Optional source-local command; never opens a foreign connection while this is held. */
  tx?: CommandTransaction;
}>;
export type IdentityScopeRevalidateResult =
  | IdentityScopeFailure
  | Readonly<{
      status: 'current';
      observation: IdentityScopeObservation;
      work: IdentityScopeWork;
    }>;
export type IdentityScopeRepairInput = Readonly<{
  key: IdentityScopeKey;
  limit: number;
  deadline: number;
  allowance?: WorkAllowance;
}>;
export type IdentityScopeRepairResult =
  | IdentityScopeFailure
  | Readonly<{
      status: 'repaired' | 'pending';
      observation: IdentityScopeObservation | null;
      work: IdentityScopeWork;
    }>;
export type IdentityScopeRetireInput = Readonly<{
  key: IdentityScopeKey;
  receiving?: readonly IdentityReceivingRecord[];
  allowance: WorkAllowance;
  deadline: number;
}>;
export type IdentityScopeRetireResult =
  | IdentityScopeFailure
  | Readonly<{ status: 'retired' | 'pending'; work: IdentityScopeWork }>;
export interface IdentityScopedObservations {
  register(input: IdentityScopeRegistration): Promise<IdentityScopeRegistrationResult>;
  arm(input: IdentityScopeArmInput): Promise<IdentityScopeArmResult>;
  finish(input: IdentityScopeFinishInput): Promise<IdentityScopeFinishResult>;
  revalidate(input: IdentityScopeRevalidateInput): Promise<IdentityScopeRevalidateResult>;
  repair(input: IdentityScopeRepairInput): Promise<IdentityScopeRepairResult>;
  retire(input: IdentityScopeRetireInput): Promise<IdentityScopeRetireResult>;
}
