import type { IdentityChange, IdentityFrontier } from '../semantic/identity-epoch-contract.ts';
import type { LibraryScopeEffectsKey } from './identity-scope-effects.ts';
import type { CanonicalRawKey } from './canonical-source-store.ts';
import type { NativeSourceFrontier } from './native-source-custody.ts';
import type { WorkAllowance, WorkReceipt } from './contract/work-dimensions.ts';

/** Native maintenance only. Neither a Source reader nor receiving application authority. */
export type LibraryIdentityPlanInput = LibraryScopeEffectsKey &
  Readonly<{
    allowance: WorkAllowance;
    deadline: number;
    limit: number;
  }>;
export type LibraryIdentityPlanResult = Readonly<{
  status: 'pending' | 'sealed' | 'unavailable';
  work: WorkReceipt;
}>;
export type LibraryIdentityPlan = {
  route: number;
  collection_id: string;
  plan_key: string;
  source_identity: LibraryScopeEffectsKey['sourceIdentity'];
  job_id: string;
  job_epoch: string;
  scope: string;
  generation: string;
  capture_id: string;
  capture_frontier: NativeSourceFrontier;
  collection_fence: string;
  account_fence: string;
  job_transaction_id: string;
  scope_digest: string;
  job_writer_fence: unknown;
  phase: 'old-references' | 'old-ready' | 'old-working' | 'raw';
  driver: CanonicalRawKey['driver'] | 'done';
  after_subject: string | null;
  after_fact: string | null;
  version: string;
  state: 'building' | 'sealed' | 'invalidated';
  old_head: string | null;
  old_state: {
    readyGeneration: string | null;
    readyBasis: string | null;
    workingGeneration: string | null;
    workingBasis: string | null;
  } | null;
  seal_transaction_id: string | null;
  frontier: IdentityFrontier;
};
export type LibraryIdentityPlannedOriginal = Readonly<{
  key: CanonicalRawKey;
  change: IdentityChange | null;
  terminal: string;
  mappingEpoch: string | null;
}>;
