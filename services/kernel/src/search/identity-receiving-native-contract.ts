import type { CommandTransaction } from '../command/command.ts';
import type {
  IdentityFrontier,
  IdentityJobRef,
  IdentityNativeReceipt,
  NativeStepWork,
} from '../semantic/identity-epoch-contract.ts';
import type {
  NativeIdentityReceivingBinding,
  NativeIdentityReceivingRecord,
} from '../semantic/identity-receiving-effects-types.ts';
import type { SearchWriterBarrierLocator } from './writer-guard.ts';
import { serializeIdentityValue } from '../semantic/identity-epoch-store.ts';

/** An operational locator. Resolving it must read committed native custody. */
export type SearchIdentityReceivingLocator = Readonly<{
  kind: 'search-canonical-index';
  version: 1;
  partition: number;
  planId: string;
}>;

export type SearchIdentityReceivingSelection = Readonly<{
  job: IdentityJobRef;
  original: string;
  effectKey: string;
  owner: string;
  sourceId: string;
  scope: string;
  disposition: 'OLD' | 'NEW' | 'first-apply' | 'handoff';
  native: SearchIdentityReceivingLocator;
}>;

/** Search-owned source identity; no Library capture or account custody is interchangeable. */
export type SearchIdentityReceivingSource = Readonly<{
  locator: SearchIdentityReceivingLocator;
  original: string;
  terminal: string;
  documentId: string;
  owner: string;
  sourceId: string;
  scope: string;
  disposition: SearchIdentityReceivingSelection['disposition'];
  receivingHome: number;
  receivingEpoch: number;
  consumer: string;
  physicalTarget: string;
  incarnation: string;
  writeAlias: string;
  physicalGeneration: number;
  enrollmentGeneration: bigint;
  fenceGeneration: bigint;
  barrier: SearchWriterBarrierLocator;
  originalFence: IdentityNativeReceipt;
  plan: IdentityNativeReceipt;
}>;

export type SearchIdentityReceivingHold = Readonly<{
  locator: SearchIdentityReceivingLocator;
  holdId: string;
  source: SearchIdentityReceivingSource;
}>;

export type SearchIdentityReceivingContext = Readonly<{
  deadline: number;
  /** Reserved from the caller's original frame; this does not mint an allowance. */
  allowance: NativeStepWork;
}>;

export type SearchIdentityReceivingResult<T> =
  | Readonly<{ status: 'ready'; value: T; work: NativeStepWork }>
  | Readonly<{ status: 'changed' | 'draining' | 'unavailable'; work: NativeStepWork }>;

/** Library's public aliases stay Library-only. Select Search from the canonical native unions. */
export type SearchIdentityReceivingBinding = Extract<NativeIdentityReceivingBinding, { step: 'search-canonical-index' }>;
export type SearchIdentityReceivingRecord = Extract<NativeIdentityReceivingRecord, { step: 'search-canonical-index' }>;

export const SEARCH_IDENTITY_RECEIVING_FRONTIER_MAX_BYTES = 1792;
/** Snapshot scalar data before an await. JSON coercions, accessors and inherited fields cannot
 * change the frontier between its admission, native mutation and late common/step callbacks.
 */
export function snapshotSearchIdentityReceivingFrontier(value: unknown): IdentityFrontier | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== 2)
      return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (!fields.after || !('value' in fields.after) || !fields.segment || !('value' in fields.segment)) return null;
    const { value: after } = fields.after;
    const { value: segment } = fields.segment;
    if (!Array.isArray(after) || Object.getPrototypeOf(after) !== Array.prototype || after.length > 8 ||
      Reflect.ownKeys(after).length !== after.length + 1 || !Number.isSafeInteger(segment) || segment < 0) return null;
    const keys: (string | number | null)[] = [];
    for (let i = 0; i < after.length; i++) {
      const field = Object.getOwnPropertyDescriptor(after, i);
      if (!field || !('value' in field)) return null;
      const item: unknown = field.value;
      if (!(item === null || typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)))) return null;
      keys.push(item);
    }
    const snapshot = Object.freeze({ after: Object.freeze(keys), segment });
    return Buffer.byteLength(serializeIdentityValue(snapshot)) <= SEARCH_IDENTITY_RECEIVING_FRONTIER_MAX_BYTES ? snapshot : null;
  } catch { return null; }
}
/** Validate before serialization: JSON would silently turn nonfinite numbers into null. */
export function validSearchIdentityReceivingFrontier(value: IdentityFrontier): boolean {
  return snapshotSearchIdentityReceivingFrontier(value) !== null;
}

/** Selected owner ABI. A declaration neither installs an adapter nor grants admission. */
export interface SearchIdentityReceivingNative {
  resolvePlanned(
    selection: SearchIdentityReceivingSelection,
    context: SearchIdentityReceivingContext,
  ): Promise<SearchIdentityReceivingResult<SearchIdentityReceivingSource>>;
  readAndHold(
    tx: CommandTransaction,
    binding: SearchIdentityReceivingBinding,
    context: SearchIdentityReceivingContext,
  ): Promise<SearchIdentityReceivingResult<SearchIdentityReceivingHold>>;
  revalidateHold(
    tx: CommandTransaction,
    record: SearchIdentityReceivingRecord,
    context: SearchIdentityReceivingContext,
  ): Promise<SearchIdentityReceivingResult<SearchIdentityReceivingHold>>;
  recordApplied(
    tx: CommandTransaction,
    record: SearchIdentityReceivingRecord,
    frontier: IdentityFrontier,
    context: SearchIdentityReceivingContext,
  ): Promise<SearchIdentityReceivingResult<Readonly<{ holdId: string }>>>;
  reconcileOriginal(
    locator: SearchIdentityReceivingLocator,
    after: string | null,
    context: SearchIdentityReceivingContext,
  ): Promise<SearchIdentityReceivingResult<Readonly<{ after: string | null; state: 'progress' | 'settled' }>>>;
  releaseHold(
    tx: CommandTransaction,
    record: SearchIdentityReceivingRecord,
    context: SearchIdentityReceivingContext,
  ): Promise<SearchIdentityReceivingResult<Readonly<{ holdId: string }>>>;
}
