import type { WorkAllowance, WorkReceipt } from '../library/contract/work-dimensions.ts';
import type { PublicFilterCost } from '../semantic/index.ts';
import { routeOf } from '../route/route.ts';
import { MAX_NAME_SORT_CHARACTERS } from './document.ts';
import { scopeWorkAxes } from './scope-work.ts';
import type { SearchHit } from './query.ts';
import type { ScopeBasis } from './scope-source.ts';
import type { PublicFilterConsumerJob, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';

/** Native output order, independent of structural Collection id/ordinal traversal. */
export type ScopeNativeOrder = 'name' | 'collections';
export type ScopeNameSortTuple = readonly [name: string | null, id: string];
/** Actual public_collection_count DESC (missing zero), then name_sort/id ASC. */
export type ScopeCollectionsSortTuple = readonly [count: number, name: string | null, id: string];

/** Immutable retained output definition. Structural Source traversal keeps its own order. */
export type ScopeOrderedDefinition = Readonly<{
  nativeOrder: ScopeNativeOrder;
  pageSize: number;
  index: string;
  uuid: string;
  generation: number;
}>;

/** Native custody locators only; no Actor, permission or reconstructed start evidence. */
export type ScopeOrderedPreparation = Readonly<{
  queried: PublicFilterQueriedObservation | null;
  repair: PublicFilterConsumerJob | null;
  execution: string | null;
  populationFrontier?: string | null;
  populationComplete?: boolean;
}>;

export type ScopeOrderedPrefixRequest = (
  | { order: 'name'; after: ScopeNameSortTuple | null }
  | { order: 'collections'; after: ScopeCollectionsSortTuple | null }
) & {
  quota: number;
  budget: number;
  allowance: WorkAllowance;
};

type OrderedPrefix<Order extends ScopeNativeOrder, Tuple> = {
  order: Order;
  hits: readonly (Omit<SearchHit, 'sort'> & { sort: Tuple })[];
  basis: ScopeBasis;
  /** Last settled raw tuple; unused lookahead never advances this frontier. */
  coveredThrough: Tuple | null;
  exhausted: boolean;
  usage: {
    candidates: number;
    /** Caller-root settlement; public is its native breakdown, never another charge/refund. */
    work: WorkReceipt;
    public: PublicFilterCost;
  };
};

export type SearchScopeOrderedPrefix =
  | OrderedPrefix<'name', ScopeNameSortTuple>
  | OrderedPrefix<'collections', ScopeCollectionsSortTuple>;

function bounded(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Ordered Scope reservation is out of range');
}

function nativeOrder(order: ScopeNativeOrder): void {
  if (order !== 'name' && order !== 'collections') throw new RangeError('Invalid native Scope order');
}

/** Validate the existing caller reservation without allocating or settling another ledger. */
function allowance(value: WorkAllowance): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.reservationId !== 'string' ||
    !value.reservationId ||
    !value.remaining ||
    typeof value.remaining !== 'object' ||
    Array.isArray(value.remaining)
  )
    throw new RangeError('Missing ordered Scope allowance');
  for (const axis of scopeWorkAxes) bounded(value.remaining[axis], 0, Number.MAX_SAFE_INTEGER);
}

/** Ordered preparation cannot fall back to the legacy compatibility reservation or size. */
export function validateScopeOrderedPrepare(options: {
  nativeOrder?: ScopeNativeOrder;
  pageSize?: number;
  allowance?: WorkAllowance;
}): void {
  nativeOrder(options.nativeOrder!);
  bounded(options.pageSize!, 1, 100);
  allowance(options.allowance!);
}

/** Preserve the actual normalized native key: null missing-last and empty string are distinct.
 * The shared cursor encodes these as z and s; a full s-prefixed key fits 1537 UTF-8 bytes.
 */
function nameKey(value: unknown): void {
  if (value === null) return;
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.length > MAX_NAME_SORT_CHARACTERS ||
    Buffer.byteLength(value, 'utf8') > 3 * MAX_NAME_SORT_CHARACTERS
  )
    throw new RangeError('Invalid native Scope name key');
}

export function scopeOrderedNameKey(name: string | null): Buffer {
  nameKey(name);
  return Buffer.from(name === null ? 'z' : `s${name}`, 'utf8');
}

/** Native Lucene keyword order, including supplementary scalars and missing-last. */
export function compareScopeOrderedTuple(
  order: ScopeNativeOrder,
  left: readonly (string | number | null)[],
  right: readonly (string | number | null)[],
): number {
  if (order === 'collections' && left[0] !== right[0]) return (right[0] as number) - (left[0] as number);
  const name = Buffer.compare(
    scopeOrderedNameKey(left[left.length - 2] as string | null),
    scopeOrderedNameKey(right[right.length - 2] as string | null),
  );
  if (name !== 0) return name;
  return Buffer.compare(Buffer.from(left.at(-1) as string), Buffer.from(right.at(-1) as string));
}

/** Check actual native values without normalizing, canonicalizing or synthesizing a Hit. */
export function validateScopeOrderedHit(order: ScopeNativeOrder, hit: SearchHit, index: string): void {
  nativeOrder(order);
  const tuple = hit.sort;
  if (!Array.isArray(tuple) || tuple.length !== (order === 'name' ? 2 : 3))
    throw new RangeError('Invalid ordered Scope native hit tuple');
  if (order === 'collections') bounded(tuple[0] as number, 0, 2147483647);
  nameKey(tuple[tuple.length - 2]);
  if (hit.index !== index || routeOf(hit.id) === null || tuple.at(-1) !== hit.id)
    throw new RangeError('Ordered Scope native hit identity changed');
}

export function emptyScopePublicCost(): PublicFilterCost {
  return {
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  };
}

export function addScopePublicCost(a: PublicFilterCost, b: PublicFilterCost): PublicFilterCost {
  const result = emptyScopePublicCost();
  for (const key of Object.keys(result) as (keyof PublicFilterCost)[]) {
    const value = a[key] + b[key];
    bounded(value, 0, Number.MAX_SAFE_INTEGER);
    Object.assign(result, { [key]: value });
  }
  return result;
}

export function validateScopeOrderedPrefix(request: ScopeOrderedPrefixRequest): void {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new RangeError('Invalid ordered Scope request');
  nativeOrder(request.order);
  bounded(request.quota, 1, 99);
  bounded(request.budget, request.quota + 1, 100);
  allowance(request.allowance);
  if (request.budget > request.allowance.remaining.candidateKeys)
    throw new RangeError('Ordered Scope budget exceeds candidate reservation');
  const tuple = request.after;
  if (tuple === null) return;
  if (!Array.isArray(tuple) || tuple.length !== (request.order === 'name' ? 2 : 3))
    throw new RangeError('Invalid native Scope tuple');
  if (request.order === 'collections') bounded(tuple[0] as number, 0, 2147483647);
  nameKey(tuple[tuple.length - 2]);
  if (routeOf(tuple[tuple.length - 1] as string) === null) throw new RangeError('Invalid native Scope subject ID');
}
