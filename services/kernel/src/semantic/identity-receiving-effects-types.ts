import type {
  NativeLibrarySourceCustody,
  NativeSourceCaptureWork,
  NativeSourceFrontier,
  NativeSourceIdentity,
} from '../library/native-source-custody.ts';
import type {
  IdentityEffect,
  IdentityJobRef,
  IdentityNativeReceipt,
  IdentityFrontier,
} from './identity-epoch-contract.ts';

export type IdentityReceivingEffect = Extract<IdentityEffect, { kind: 'receiving' }>;
export type IdentityReceivingDisposition = 'OLD' | 'NEW' | 'first-apply' | 'handoff';
/** Selects one Source-owned effect. None of these caller keys constitute proof. */
export type IdentityReceivingSelection = Readonly<{
  job: IdentityJobRef;
  original: string;
  effectKey: string;
  owner: string;
  sourceId: string;
  scope: string;
  disposition: IdentityReceivingDisposition;
  /** Native capture locator; preparation and selection reads resolve actual retained Source records. */
  capture?: Readonly<{ identity: NativeSourceIdentity; frontier: NativeSourceFrontier }>;
}>;
/** Source-owned native provenance. Never accepted as an argument to the public preparation producer. */
export type IdentityReceivingSource = Readonly<{
  id: string;
  incarnation: string;
  generation: string;
  scope: string;
  owner: string;
  home: number;
  receivingHome: number;
  receivingEpoch: number;
  original: string;
  effectKey: string;
  disposition: IdentityReceivingDisposition;
  provenance: IdentityNativeReceipt;
  /** Exact owner declarations, not a structural copy or serialized brand. */
  native: Readonly<{ identity: NativeSourceIdentity; captureId: string; holdId: string }>;
}>;
/** Fixed version and participant; each scope/disposition has its own retained effect key. */
export type IdentityReceivingBinding = Readonly<{
  job: IdentityJobRef;
  original: string;
  effectKey: string;
  owner: string;
  step: 'library-private-follow-counts';
  version: 1;
  scopeDigest: string;
  source: IdentityReceivingSource;
}>;
export type IdentityReceivingRecord = IdentityReceivingBinding &
  Readonly<{
    plan: IdentityNativeReceipt;
    sourceHold: IdentityNativeReceipt;
    receipt: IdentityNativeReceipt;
    applied: Readonly<{ receipt: IdentityNativeReceipt; frontier: IdentityFrontier }> | null;
  }>;
export type IdentityReceivingProgress = Readonly<{
  frontier: IdentityFrontier;
}>;
/** One bounded native capture call; the caller retains the returned frontier and charges its work. */
export type IdentityReceivingCaptureInput = NativeSourceCaptureWork &
  Readonly<{
    identity: NativeSourceIdentity;
    frontier: NativeSourceFrontier | null;
    limit: number;
  }>;
export type IdentityReceivingCaptureResult =
  | Awaited<ReturnType<NativeLibrarySourceCustody['capturePage']>>
  | Awaited<ReturnType<NativeLibrarySourceCustody['finishCapture']>>;

/** Search owns these declarations. A Library capture can never stand in for its native plan. */
import type {
  SearchIdentityReceivingSelection,
  SearchIdentityReceivingSource,
  SearchIdentityReceivingHold,
} from '../search/identity-receiving-native-contract.ts';
export type {
  SearchIdentityReceivingSelection,
  SearchIdentityReceivingSource,
  SearchIdentityReceivingHold,
  SearchIdentityReceivingNative,
  SearchIdentityReceivingContext,
  SearchIdentityReceivingResult,
} from '../search/identity-receiving-native-contract.ts';

/** Semantic's Search branch retains the entire original owner binding, never a Library identity. */
export type SearchIdentityReceivingBinding = Readonly<{
  job: IdentityJobRef;
  original: string;
  effectKey: string;
  owner: string;
  step: 'search-canonical-index';
  version: 1;
  scopeDigest: string;
  source: SearchIdentityReceivingSource;
}>;
export type SearchIdentityReceivingRecord = SearchIdentityReceivingBinding &
  Readonly<{
    plan: IdentityNativeReceipt;
    sourceHold: IdentityNativeReceipt;
    receipt: IdentityNativeReceipt;
    nativeHold: SearchIdentityReceivingHold;
    applied: Readonly<{ receipt: IdentityNativeReceipt; frontier: IdentityFrontier }> | null;
  }>;
export type NativeIdentityReceivingBinding = IdentityReceivingBinding | SearchIdentityReceivingBinding;
export type NativeIdentityReceivingRecord = IdentityReceivingRecord | SearchIdentityReceivingRecord;
export type NativeIdentityReceivingSelection = IdentityReceivingSelection | SearchIdentityReceivingSelection;
