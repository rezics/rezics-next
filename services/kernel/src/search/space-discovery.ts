import { readSpaceDiscoverySummaries, spaceDiscoverySource } from '../community/space-discovery.ts';
import type {
  IndexedSpace,
  SpaceDiscoveryDependencies,
  SpaceDiscoveryKey as NativeSpaceDiscoveryKey,
  SpaceDiscoverySource as NativeSpaceDiscoverySource,
  SpaceDiscoverySummary,
  SpaceDiscoveryTupleWitness,
  SpaceDiscoveryTupleWitnessInput,
} from '../community/space-discovery.ts';
import type { SpaceDiscoveryDependencyReadiness } from '../community/space-discovery-dependencies.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import { MIXED_DISCOVERY_DOCUMENT_FORMAT } from './discovery.ts';

export const SPACE_DISCOVERY_KIND = 'space';
const MAX_BATCH = 100;
const MAX_NATIVE_POSITION = 9_223_372_036_854_775_807n;

export type SpaceDiscoveryKey = Readonly<{
  owner: 'content';
  kind: typeof SPACE_DISCOVERY_KIND;
  route: number;
  id: string;
}>;
export type SpaceDiscoverySnapshot = Readonly<{
  partition: number;
  position: bigint;
  spaces: readonly IndexedSpace[];
}>;
export type SpaceDiscoveryPage = SpaceDiscoverySnapshot & Readonly<{ next: NativeSpaceDiscoveryKey | null }>;
export type SpaceDiscoveryDocument = Readonly<{
  document_format: typeof MIXED_DISCOVERY_DOCUMENT_FORMAT;
  identity: string;
  owner: 'content';
  kind: typeof SPACE_DISCOVERY_KIND;
  id: string;
  route: number;
  partition: number;
  source_position: string;
  revision: string;
  realm_id: string | null;
  names: readonly string[];
  descriptions: readonly string[];
  name_sort: string;
}>;
export type SpaceDiscoveryAction =
  | Readonly<{ op: 'index'; id: string; version: bigint; document: SpaceDiscoveryDocument }>
  | Readonly<{ op: 'delete'; id: string; version: bigint }>;
export type SpaceDiscoveryHydration = (
  ids: readonly string[],
  context: Readonly<{ deadline: number }>,
) => Promise<ReadonlyMap<string, SpaceDiscoverySummary>>;
export type PreparedSpaceDiscoveryPage = Readonly<{
  partition: number;
  /** Position that owns the keyset frontier. */
  position: bigint;
  /** Current observation position used by every returned index/delete action. */
  observedPosition: bigint;
  next: NativeSpaceDiscoveryKey | null;
  actions: readonly SpaceDiscoveryAction[];
}>;

export type SpaceDiscoveryAdapter = Readonly<{
  owner: 'content';
  kind: typeof SPACE_DISCOVERY_KIND;
  source: Readonly<{
    dependencies(): Promise<SpaceDiscoveryDependencyReadiness>;
    tupleWitnesses?(
      partition: number,
      ids: readonly string[],
    ): Promise<ReadonlyMap<string, SpaceDiscoveryTupleWitness>>;
    registerTupleProducer?(input: Readonly<{ generation: string; cut: string; complete: true }>): Promise<void>;
    publishTupleWitness?(input: SpaceDiscoveryTupleWitnessInput): Promise<SpaceDiscoveryTupleWitness>;
    read(partition: number, ids: readonly string[]): Promise<SpaceDiscoverySnapshot>;
    count(partition: number): Promise<Readonly<{ partition: number; position: bigint; count: number }>>;
    page(partition: number, after: NativeSpaceDiscoveryKey | null, limit: number): Promise<SpaceDiscoveryPage>;
  }>;
  hydrate(
    ids: readonly string[],
    context: Readonly<{ deadline: number }>,
  ): Promise<ReadonlyMap<string, SpaceDiscoverySummary>>;
  project(snapshot: SpaceDiscoverySnapshot, keys: readonly NativeSpaceDiscoveryKey[]): readonly SpaceDiscoveryAction[];
  preparePage(
    partition: number,
    after: NativeSpaceDiscoveryKey | null,
    limit: number,
  ): Promise<PreparedSpaceDiscoveryPage>;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function assertPartition(partition: number): void {
  if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new RangeError('Space discovery requires a native partition');
}

function assertPosition(position: unknown): asserts position is bigint {
  if (typeof position !== 'bigint' || position < 0n || position > MAX_NATIVE_POSITION)
    throw new TypeError('Space discovery requires an exact native position');
}

function key(value: unknown, partition: number): NativeSpaceDiscoveryKey {
  if (!record(value) || !exactKeys(value, ['route', 'id']) || typeof value.id !== 'string')
    throw new TypeError('Invalid Space discovery key');
  const route = routeOf(value.id);
  if (route === null || route !== value.route || partitionOf(route) !== partition)
    throw new TypeError('Space discovery key does not belong to its native partition');
  return { route, id: value.id };
}

function searchKey(value: NativeSpaceDiscoveryKey, partition: number): SpaceDiscoveryKey {
  const native = key(value, partition);
  return { owner: 'content', kind: SPACE_DISCOVERY_KIND, ...native };
}

function compare(left: NativeSpaceDiscoveryKey, right: NativeSpaceDiscoveryKey): number {
  return left.route === right.route ? (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) : left.route - right.route;
}

function indexedSpace(value: unknown, partition: number): IndexedSpace {
  if (
    !record(value) ||
    !exactKeys(value, ['id', 'realmId', 'name', 'description', 'revision']) ||
    typeof value.id !== 'string' ||
    (value.realmId !== null && typeof value.realmId !== 'string') ||
    typeof value.name !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.revision !== 'string'
  )
    throw new TypeError('Invalid Space discovery projection');
  key({ route: routeOf(value.id), id: value.id }, partition);
  if (value.realmId !== null && routeOf(value.realmId) === null)
    throw new TypeError('Invalid Space discovery Realm identity');
  if (routeOf(value.revision) === null) throw new TypeError('Invalid Space discovery revision');
  return {
    id: value.id,
    realmId: value.realmId,
    name: value.name,
    description: value.description,
    revision: value.revision,
  };
}

function snapshot(value: unknown, partition: number, requested?: ReadonlySet<string>): SpaceDiscoverySnapshot {
  assertPartition(partition);
  if (
    !record(value) ||
    !exactKeys(value, ['partition', 'position', 'spaces']) ||
    value.partition !== partition ||
    !Array.isArray(value.spaces)
  )
    throw new TypeError('Invalid Space discovery snapshot');
  assertPosition(value.position);
  if (value.spaces.length > MAX_BATCH) throw new RangeError('Space discovery snapshot exceeds its batch limit');
  const spaces = value.spaces.map((row) => indexedSpace(row, partition));
  const seen = new Set<string>();
  for (const space of spaces) {
    if ((requested && !requested.has(space.id)) || seen.has(space.id))
      throw new TypeError('Space discovery returned an unrequested or duplicate key');
    seen.add(space.id);
  }
  return { partition, position: value.position, spaces };
}

function validatePage(
  value: unknown,
  partition: number,
  after: NativeSpaceDiscoveryKey | null,
  limit: number,
): SpaceDiscoveryPage {
  assertPartition(partition);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH)
    throw new RangeError('Space discovery page limit must be 1..100');
  const frontier = after === null ? null : key(after, partition);
  if (!record(value) || !exactKeys(value, ['partition', 'position', 'spaces', 'next']))
    throw new TypeError('Invalid complete Space discovery page');
  const { next: rawNext, ...rawSnapshot } = value;
  const current = snapshot(rawSnapshot, partition);
  if (current.spaces.length > limit) throw new RangeError('Space discovery page exceeds its requested limit');
  let previous = frontier;
  for (const space of current.spaces) {
    const nextKey = key({ route: routeOf(space.id), id: space.id }, partition);
    if (previous !== null && compare(previous, nextKey) >= 0)
      throw new TypeError('Space discovery page keys must advance in native order');
    previous = nextKey;
  }
  const next = rawNext === null ? null : key(rawNext, partition);
  if (next !== null) {
    if ((frontier !== null && compare(frontier, next) >= 0) || (previous !== null && compare(previous, next) > 0))
      throw new TypeError('Space discovery frontier does not cover its complete page');
  }
  return { ...current, next };
}

function requestedKeys(values: readonly NativeSpaceDiscoveryKey[], partition: number): NativeSpaceDiscoveryKey[] {
  if (!Array.isArray(values) || values.length > MAX_BATCH)
    throw new RangeError('Space discovery accepts at most 100 keys');
  const unique = new Map<string, NativeSpaceDiscoveryKey>();
  for (const value of values) {
    const checked = key(value, partition);
    unique.set(checked.id, checked);
  }
  return [...unique.values()];
}

function documentId(id: string): string {
  if (routeOf(id) === null) throw new TypeError('Space discovery requires a routable Space identity');
  return `discovery-v1:${encodeURIComponent(SPACE_DISCOVERY_KIND)}:${id}`;
}

function projectSnapshot(
  current: SpaceDiscoverySnapshot,
  keys: readonly NativeSpaceDiscoveryKey[],
): readonly SpaceDiscoveryAction[] {
  const checked = requestedKeys(keys, current.partition);
  const requested = new Set(checked.map(({ id }) => id));
  const observed = snapshot(current, current.partition, requested);
  const spaces = new Map(observed.spaces.map((space) => [space.id, space]));
  return checked.map((native) => {
    const id = documentId(native.id);
    const space = spaces.get(native.id);
    if (!space) return { op: 'delete', id, version: observed.position } as const;
    const identity = searchKey(native, observed.partition);
    return {
      op: 'index',
      id,
      version: observed.position,
      document: {
        document_format: MIXED_DISCOVERY_DOCUMENT_FORMAT,
        identity: id,
        owner: identity.owner,
        kind: identity.kind,
        id: identity.id,
        route: identity.route,
        partition: observed.partition,
        source_position: observed.position.toString(),
        revision: space.revision,
        realm_id: space.realmId,
        names: [space.name],
        descriptions: [space.description],
        name_sort: space.name,
      },
    } as const;
  });
}

function validateSummaryMap(
  value: unknown,
  requested: ReadonlySet<string>,
): ReadonlyMap<string, SpaceDiscoverySummary> {
  if (!value || typeof (value as ReadonlyMap<string, unknown>).entries !== 'function')
    throw new TypeError('Space discovery hydration must return a keyed map');
  const summaries = new Map<string, SpaceDiscoverySummary>();
  for (const [id, raw] of value as ReadonlyMap<string, unknown>) {
    if (!requested.has(id) || !record(raw) || !exactKeys(raw, ['id', 'realmId', 'name', 'description', 'avatar']))
      throw new TypeError('Space discovery returned an unrequested or malformed summary');
    if (
      raw.id !== id ||
      routeOf(id) === null ||
      (raw.realmId !== null && (typeof raw.realmId !== 'string' || routeOf(raw.realmId) === null)) ||
      typeof raw.name !== 'string' ||
      typeof raw.description !== 'string' ||
      (raw.avatar !== null && !record(raw.avatar))
    )
      throw new TypeError('Space discovery summary does not match its canonical identity');
    summaries.set(id, raw as unknown as SpaceDiscoverySummary);
  }
  return summaries;
}

/**
 * Search leaf over Content's complete native candidate source. It validates a whole page before returning its
 * frontier and re-reads page hits at current native position before creating index actions.
 */
export function createSpaceDiscoveryAdapter(
  native: NativeSpaceDiscoverySource,
  hydrateCurrent: SpaceDiscoveryHydration,
): SpaceDiscoveryAdapter {
  const source = Object.freeze({
    dependencies() {
      return native.dependencies();
    },
    ...(native.tupleWitnesses
      ? {
          tupleWitnesses(partition: number, ids: readonly string[]) {
            assertPartition(partition);
            if (!Array.isArray(ids) || ids.length > MAX_BATCH)
              throw new RangeError('Space discovery accepts at most 100 tuple witness keys');
            const keys = requestedKeys(
              ids.map((id) => ({ route: routeOf(id) ?? -1, id })),
              partition,
            );
            return native.tupleWitnesses!(
              partition,
              keys.map(({ id }) => id),
            );
          },
        }
      : {}),
    ...(native.registerTupleProducer
      ? {
          registerTupleProducer(input: Readonly<{ generation: string; cut: string; complete: true }>) {
            return native.registerTupleProducer!(input);
          },
        }
      : {}),
    ...(native.publishTupleWitness
      ? {
          publishTupleWitness(input: SpaceDiscoveryTupleWitnessInput) {
            return native.publishTupleWitness!(input);
          },
        }
      : {}),
    async read(partition: number, ids: readonly string[]) {
      assertPartition(partition);
      if (!Array.isArray(ids) || ids.length > MAX_BATCH)
        throw new RangeError('Space discovery accepts at most 100 keys');
      const keys = requestedKeys(
        ids.map((id) => ({ route: routeOf(id) ?? -1, id })),
        partition,
      );
      const requested = new Set(keys.map(({ id }) => id));
      const result = await native.read(
        partition,
        keys.map(({ id }) => id),
      );
      return snapshot(result, partition, requested);
    },
    async count(partition: number) {
      assertPartition(partition);
      const result: unknown = await native.count(partition);
      if (
        !record(result) ||
        !exactKeys(result, ['partition', 'position', 'count']) ||
        result.partition !== partition ||
        !Number.isSafeInteger(result.count) ||
        (result.count as number) < 0
      )
        throw new TypeError('Invalid Space discovery generation census');
      assertPosition(result.position);
      return { partition, position: result.position, count: result.count as number };
    },
    async page(partition: number, after: NativeSpaceDiscoveryKey | null, limit: number) {
      assertPartition(partition);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH)
        throw new RangeError('Space discovery page limit must be 1..100');
      const frontier = after === null ? null : key(after, partition);
      const result = await native.page(partition, frontier, limit);
      return validatePage(result, partition, frontier, limit);
    },
  });

  return Object.freeze({
    owner: 'content' as const,
    kind: SPACE_DISCOVERY_KIND,
    source,
    async hydrate(ids, context) {
      if (!Array.isArray(ids) || ids.length > MAX_BATCH)
        throw new RangeError('Space discovery accepts at most 100 hydration keys');
      const keys = [...new Set(ids)].map((id) => {
        if (typeof id !== 'string' || routeOf(id) === null)
          throw new TypeError('Invalid Space discovery hydration key');
        return id;
      });
      return validateSummaryMap(await hydrateCurrent(keys, context), new Set(keys));
    },
    project: projectSnapshot,
    async preparePage(partition, after, limit) {
      const admitted = await source.page(partition, after, limit);
      const keys = admitted.spaces.map(({ id }) => ({ route: routeOf(id)!, id }));
      const current = keys.length
        ? await source.read(
            partition,
            keys.map(({ id }) => id),
          )
        : { partition, position: admitted.position, spaces: [] };
      if (current.position < admitted.position)
        throw new TypeError('Current Space discovery observation precedes its page position');
      const actions = projectSnapshot(current, keys);
      return {
        partition,
        position: admitted.position,
        observedPosition: current.position,
        next: admitted.next,
        actions,
      };
    },
  });
}

/** Production assembly uses the Content producer's native source and anonymous current-summary reader. */
export function nativeSpaceDiscoveryAdapter(
  deps: SpaceDiscoveryDependencies,
  context?: Readonly<{ deadline: number }>,
): SpaceDiscoveryAdapter {
  return createSpaceDiscoveryAdapter(spaceDiscoverySource(deps, context), (ids, readContext) =>
    readSpaceDiscoverySummaries(deps, ids, readContext),
  );
}
