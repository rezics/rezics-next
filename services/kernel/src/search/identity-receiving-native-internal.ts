import type { Pool } from 'pg';
import type { IdentityFrontier, IdentityNativeReceipt, NativeStepWork } from '../semantic/identity-epoch-contract.ts';
import type { PublicFilterProjectionFrontier } from '../semantic/public-filter-source-contract.ts';
import type {
  SearchIdentityReceivingLocator,
  SearchIdentityReceivingSelection,
  SearchIdentityReceivingSource,
} from './identity-receiving-native-contract.ts';

/** Operational references, never a mirrored support body or an assertion of complete eligibility. */
export type SearchNativeReceivingReferences = Readonly<{
  originalSupport: PublicFilterProjectionFrontier | null;
  terminalSupport: PublicFilterProjectionFrontier | null;
  definition: string;
  release: string;
  documentFence: IdentityNativeReceipt;
  predecessor: SearchIdentityReceivingLocator | null;
}>;
export type SearchNativeReceivingCopy = Readonly<{
  state: 'enrolled' | 'dispatched' | 'settled' | 'cancelled';
  home: number;
  consumer: string;
  physicalTarget: string;
  incarnation: string;
  writeAlias: string;
  original: string;
  close: IdentityNativeReceipt;
  enrollment: IdentityNativeReceipt | null;
  visible: IdentityNativeReceipt | null;
}>;
export type SearchNativeReceivingPreparation = Readonly<{
  selection: SearchIdentityReceivingSelection;
  source: Omit<SearchIdentityReceivingSource, 'plan'>;
  scopeDigest: string;
  references: SearchNativeReceivingReferences;
  /** SHA-256 of the native writer's exact IndexAction, using the native decimal codec. */
  actionDigest: string;
  /** Bounded operational locators. Their presence is not proof of complete copy discovery. */
  copies: readonly SearchNativeReceivingCopy[];
}>;
export type SearchNativeReceivingPlan = Readonly<{
  selection: SearchIdentityReceivingSelection;
  source: SearchIdentityReceivingSource;
  scopeDigest: string;
  references: SearchNativeReceivingReferences;
  actionDigest: string;
  initialCopyCount: number;
}>;
export type SearchNativeReceivingOperation = Readonly<{
  operationId: string;
  holdId: string;
  state: 'dispatched' | 'visible' | 'applied';
  dispatch: IdentityNativeReceipt;
  applied: IdentityNativeReceipt | null;
  frontier: IdentityFrontier | null;
}>;
export type SearchNativeReceivingConfiguration = Readonly<{ pool: Pool; index: string; consumer: string }>;
export type SearchNativeReceivingStored<T> = Readonly<{ value: T; work: NativeStepWork }>;

/** Native receipt encoding owns unsigned decimal bigint serialization. */
export type StoredReceipt = Omit<IdentityNativeReceipt, 'position'> & Readonly<{ position: string }>;
export type StoredSource = Omit<
  SearchIdentityReceivingSource,
  'enrollmentGeneration' | 'fenceGeneration' | 'originalFence' | 'plan'
> & Readonly<{
  enrollmentGeneration: string;
  fenceGeneration: string;
  originalFence: StoredReceipt;
  plan: StoredReceipt;
}>;
export type StoredReferences = Omit<
  SearchNativeReceivingReferences,
  'originalSupport' | 'terminalSupport' | 'documentFence'
> & Readonly<{
  originalSupport: (Omit<PublicFilterProjectionFrontier, 'generation'> & { generation: string }) | null;
  terminalSupport: (Omit<PublicFilterProjectionFrontier, 'generation'> & { generation: string }) | null;
  documentFence: StoredReceipt;
}>;
export type StoredCopy = Omit<SearchNativeReceivingCopy, 'close' | 'enrollment' | 'visible'> & Readonly<{
  close: StoredReceipt;
  enrollment: StoredReceipt | null;
  visible: StoredReceipt | null;
}>;
export type PlanRow = {
  source: StoredSource;
  obligations: StoredReferences;
  scope_digest: string;
  action_digest: string;
  job_id: string;
  job_epoch: string;
  effect_key: string;
  transaction_id: string;
  initial_copy_count: number;
  native_epoch: number;
  native_position: string;
};
export type HoldRow = {
  hold_id: string;
  accepted_transaction_id: string;
  accepted_epoch: number | null;
  accepted_position: string | null;
  released_transaction_id: string | null;
};
export type OperationRow = {
  operation_id: string;
  hold_id: string;
  state: SearchNativeReceivingOperation['state'];
  writer_token: string;
  writer_locator: string;
  writer_transaction_id: string;
  writer_position: string;
  dispatch_transaction_id: string;
  visible_transaction_id: string | null;
  visible_position: string | null;
  writer_evidence_digest: string | null;
  applied_transaction_id: string | null;
  frontier: IdentityFrontier | null;
  dispatch_epoch: number;
  dispatch_position: string;
  visibility_component: string | null;
  applied_position: string | null;
};
export type WriterRow = {
  consumer: string;
  incarnation: string;
  owner_epoch: number;
  write_alias: string;
  enrollment_generation: string;
  fence_generation: string;
  closed_token: string | null;
  writer_token: string | null;
  writer_transaction_id: string | null;
  writer_position: string | null;
  dispatch_state: 'enrolled' | 'dispatched' | 'settled' | 'cancelled';
  closed_job: string | null;
  closed_epoch: string | null;
  closed_transaction_id: string | null;
  closed_position: string | null;
  settled_transaction_id: string | null;
  settled_position: string | null;
  visible_transaction_id: string | null;
  visible_position: string | null;
  source_position: string | null;
  changed_in_command: boolean;
};
export type CopyRow = {
  proven: boolean;
  copy_no: number;
  locator: StoredCopy;
  reconciled_transaction_id: string | null;
  settlement: StoredReceipt | null;
};
