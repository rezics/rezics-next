import type { CommandTransaction } from '../command/command.ts';
import type {
  NativeSourceCapture,
  NativeSourceFrontier,
  NativeSourceIdentity,
} from '../library/native-source-custody.ts';
import type { WorkAllowance } from '../library/collection-source.ts';
import type { IdentityJobRef, IdentityNativeReceipt } from './identity-epoch-contract.ts';
import type { IdentityReceivingRecord, IdentityReceivingSelection } from './identity-receiving-effects-types.ts';
import type { NativePublicSource } from './public-filter-source-binding.ts';
import type { PublicIdentitySourceCapture } from './identity-scoped-public-source.ts';

/** Source identity is a locator. Registration always resolves the native retained capture. */
export type IdentityScopeSource =
  | Readonly<{ kind: 'library'; identity: NativeSourceIdentity }>
  | Readonly<{ kind: 'public'; identity: NativePublicSource }>;
export type IdentityScopeKey = Readonly<{ source: IdentityScopeSource; scopeId: string }>;
export type IdentityScopeWork = Readonly<{ rows: number; points: number; statements: number; bytes: number }>;
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
      capture: NativeSourceCapture;
      frontier: NativeSourceFrontier;
      allowance: WorkAllowance;
    }>
  | Readonly<{ kind: 'public'; capture: PublicIdentitySourceCapture }>;
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
  records: readonly IdentityReceivingRecord[];
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
export type IdentityScopeRepairInput = Readonly<{ key: IdentityScopeKey; limit: number; deadline: number }>;
export type IdentityScopeRepairResult =
  | IdentityScopeFailure
  | Readonly<{
      status: 'repaired' | 'pending';
      observation: IdentityScopeObservation | null;
      work: IdentityScopeWork;
    }>;
export type IdentityScopeRetireInput = Readonly<{
  key: IdentityScopeKey;
  receiving: readonly IdentityReceivingRecord[];
  deadline: number;
}>;
export type IdentityScopeRetireResult = IdentityScopeFailure | Readonly<{ status: 'retired'; work: IdentityScopeWork }>;
export interface IdentityScopedObservations {
  register(input: IdentityScopeRegistration): Promise<IdentityScopeRegistrationResult>;
  arm(input: IdentityScopeArmInput): Promise<IdentityScopeArmResult>;
  finish(input: IdentityScopeFinishInput): Promise<IdentityScopeFinishResult>;
  revalidate(input: IdentityScopeRevalidateInput): Promise<IdentityScopeRevalidateResult>;
  repair(input: IdentityScopeRepairInput): Promise<IdentityScopeRepairResult>;
  retire(input: IdentityScopeRetireInput): Promise<IdentityScopeRetireResult>;
}
