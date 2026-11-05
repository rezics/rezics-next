import type { WorkAllowance, WorkReceipt } from '../library/collection-source.ts';
import type { CollectionOutputRef } from '../library/collection-source-output.ts';
import type { NativeOutputActivation } from '../library/native-source-output-types.ts';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import type { PublicFilterSourceDefinition } from './public-filter-source-binding.ts';

/** A released locator. Every use resolves the immutable accepted record in its original home. */
export type PublicIdentityOutputCapture = Readonly<{
  kind: 'public-output';
  partition: number;
  captureId: string;
  bindingDigest: string;
}>;
export type PublicIdentityOutputWork = Readonly<{ deadline: number; allowance: WorkAllowance }>;
export type PublicIdentityOutputRefusal = Readonly<{
  status: 'changed' | 'unavailable';
  reason: 'binding' | 'provenance' | 'current' | 'closure' | 'fenced' | 'continuation' | 'foreign_closure_missing';
  dependency?: string;
  work: WorkReceipt;
}>;
export type PublicIdentityOutputAcceptance = Readonly<{
  captureId: string;
  definition: PublicFilterSourceDefinition;
  publication: CollectionOutputRef & Readonly<{ activation: NativeOutputActivation }>;
}>;
export type PublicIdentityOutputSeal = Readonly<{
  capture: PublicIdentityOutputCapture;
  manifestDigest: string;
  native: IdentityNativeReceipt;
}>;
export type PublicIdentityOutputResult<T extends object> =
  | PublicIdentityOutputRefusal
  | Readonly<T & { work: WorkReceipt }>;
