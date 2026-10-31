import type { WorkAllowance, WorkReceipt } from '../library/collection-source.ts';
import type { PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import { routeOf } from '../route/route.ts';
import { MAX_NAME_SORT_CHARACTERS } from './document.ts';
import { scopeWorkAxes } from './scope-execution.ts';
import type { SearchHit } from './query.ts';
import type { ScopeBasis } from './scope-source.ts';

/** Native output order, independent of structural Collection id/ordinal traversal. */
export type ScopeNativeOrder = 'name' | 'collections';
export type ScopeNameSortTuple = readonly [name: string | null, id: string];
/** Actual public_collection_count DESC (missing zero), then name_sort/id ASC. */
export type ScopeCollectionsSortTuple = readonly [count: number, name: string | null, id: string];

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
