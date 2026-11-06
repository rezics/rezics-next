/** Deterministic identity values. Mapping conveys no permission or native proof. */
/** Native bigint; durable encoding uses unsigned decimal strings. */
export type IdentityEpoch = bigint;
export type IdentityJobRef = Readonly<{ jobId: string; epoch: IdentityEpoch }>;
/** Persisted immutable intent, without completion flags or original-ID vectors. */
export type IdentityIntent =
  | Readonly<{ kind: 'merge'; redirected: string; survivor: string; release: string }>
  | Readonly<{
      kind: 'unmerge';
      original: string;
      undoJob: IdentityJobRef;
      verificationReceipt: string | null;
      release: string;
    }>
  | Readonly<{ kind: 'repoint'; original: string; terminal: string; release: string }>;
export type IdentityStepName = 'mapping' | 'search-canonical-index' | 'library-private-follow-counts';
/** Native receipt locator, never an authorization or in-process binding proof. */
export type IdentityNativeReceipt = Readonly<{
  partition: number;
  epoch: number;
  position: bigint;
  transactionId: string;
}>;
export type IdentityStepReceipt = Readonly<{
  job: IdentityJobRef;
  step: IdentityStepName;
  version: 1;
  native: IdentityNativeReceipt;
}>;
export type IdentityChange = Readonly<{
  original: string;
  previousTerminal: string;
  terminal: string;
}>;
export type IdentityFrontier = Readonly<{
  /** At most eight scalar keys and 2048 JSON bytes; never a serialized group. */
  after: readonly (string | number | null)[];
  segment: number;
}>;
export type NativeStepWork = Readonly<{
  rows: number;
  points: number;
  statements: number;
  bytes: number;
  engineRequests: number;
}>;
export type IdentityStepProgress = Readonly<{
  job: IdentityJobRef;
  frontier: IdentityFrontier;
  state: 'more' | 'complete';
  work: NativeStepWork;
  receipt: IdentityStepReceipt;
}>;
export type IdentityEpochState =
  | Readonly<{ state: 'published'; epoch: IdentityEpoch }>
  | Readonly<{ state: 'pending'; publishedEpoch: IdentityEpoch; job: IdentityJobRef }>
  | Readonly<{ state: 'unavailable'; reason: 'bootstrap' | 'missing-owner' | 'moved-owner' }>;
export type IdentityMapping =
  | Readonly<{ state: 'mapped'; original: string; terminal: string; epoch: IdentityEpoch }>
  | Readonly<{ state: 'pending'; original: string; job: IdentityJobRef }>
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'unavailable'; reason: 'bootstrap' | 'missing-owner' | 'moved-owner' }>;
export type IdentityEffect =
  | Readonly<{
      kind: 'receiving';
      job: IdentityJobRef;
      original: string;
      effectKey: string;
      /** Locator of the committed effect-specific receiving record, never a transaction-only allow. */
      receipt: IdentityNativeReceipt;
    }>
  | Readonly<{
      kind: 'structural';
      job: IdentityJobRef;
      original: string;
      /** Destination-local link/member writes retain the affected original. */
      destination?: string;
      /** Native input-header gate for output membership in its actual control home. */
      controlGroup?: Readonly<{ terminal: string; generation: string }>;
    }>
  | Readonly<{ kind: 'follow-count'; original: string; terminal: string; epoch: IdentityEpoch }>;
