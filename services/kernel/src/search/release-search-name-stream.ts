import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  SubjectCanonicalHome,
  SubjectCanonicalNameKey,
  SubjectCanonicalNames,
  SubjectCanonicalPopulation,
} from '../semantic/subject-source-key-pages.ts';
import { subjectPartition } from './source.ts';
import { ReleaseGroupingRestartRequired, ReleaseGroupingUnavailable } from './release-search-grouping.ts';

export type ReleaseSearchNamePool = Readonly<{ id: string; names: SubjectCanonicalNames }>;

/** Native dispatch allowance, reserved before reads, including empty and replayed seeks.
 * Each home seek performs two population observations and one owner read inside the native reader.
 * This accounts for the name frontier only; matching, disclosure and card work need their own reservations.
 */
export type ReleaseSearchNameReservation = Readonly<{
  pool: string;
  observations: number;
  ownerReads: number;
  nameSeeks: number;
  keys: number;
}>;
type Context = Readonly<{
  deadline: number;
  reserve: (reservation: ReleaseSearchNameReservation) => void;
}>;
export type ReleaseSearchNameCut = Readonly<{
  epoch: string;
  pools: readonly Readonly<{ id: string; population: SubjectCanonicalPopulation }>[];
}>;
type Candidate = SubjectCanonicalNameKey & Readonly<{ pool: string; partition: number; securityRevision: number }>;
type Position = { version: 1; epoch: string; key: SubjectCanonicalNameKey | null };

const MAX_KEYS = 200;
const MAX_HOMES = 4096;

function unavailable(): never {
  throw new ReleaseGroupingUnavailable();
}

function orderedPools(pools: readonly ReleaseSearchNamePool[]): ReleaseSearchNamePool[] {
  const result = pools.map(({ id, names }) => ({ id, names })).sort((left, right) => compareText(left.id, right.id));
  if (!result.length || result.some((pool, index) => !pool.id || pool.id === result[index - 1]?.id)) unavailable();
  return result;
}

function compareText(left: string, right: string): number {
  // Native name order uses PostgreSQL COLLATE "C" (UTF-8), not JavaScript UTF-16 order.
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compare(left: SubjectCanonicalNameKey, right: SubjectCanonicalNameKey): number {
  if (left.name === null && right.name !== null) return 1;
  if (left.name !== null && right.name === null) return -1;
  return (left.name === null ? 0 : compareText(left.name, right.name!)) || compareText(left.id, right.id);
}

function key(value: unknown): value is SubjectCanonicalNameKey {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  try {
    return (
      typeof row.id === 'string' &&
      row.id === row.id.toLowerCase() &&
      subjectPartition(row.id) >= 0 &&
      (row.name === null || (typeof row.name === 'string' && row.name.length <= 512 && row.name.isWellFormed()))
    );
  } catch {
    return false;
  }
}

function position(after: string | null, epoch: string): SubjectCanonicalNameKey | null {
  if (after === null) return null;
  try {
    const value = JSON.parse(after) as Position;
    if (!value || value.version !== 1 || (value.key !== null && !key(value.key))) unavailable();
    if (value.epoch !== epoch) throw new ReleaseGroupingRestartRequired();
    return value.key;
  } catch (error) {
    if (error instanceof ReleaseGroupingRestartRequired) throw error;
    return unavailable();
  }
}

function validHome(home: SubjectCanonicalHome): boolean {
  return (
    Number.isInteger(home.partition) &&
    home.partition >= 0 &&
    home.partition < MAX_HOMES &&
    Number.isSafeInteger(home.epoch) &&
    home.epoch > 0 &&
    /^[1-9][0-9]*$/.test(home.generation) &&
    /^[0-9]+$/.test(home.position)
  );
}

/** Retain every pool, including those with no occupied home, so new population invalidates progress. */
export async function observeReleaseSearchNames(
  pools: readonly ReleaseSearchNamePool[],
  context: Context,
): Promise<ReleaseSearchNameCut> {
  const retained: ReleaseSearchNameCut['pools'][number][] = [];
  const partitions = new Set<number>();
  for (const pool of orderedPools(pools)) {
    context.reserve({ pool: pool.id, observations: 1, ownerReads: 0, nameSeeks: 0, keys: 0 });
    const population = structuredClone(await pool.names.observe(context));
    if (!population.generation || population.homes.length > MAX_HOMES) unavailable();
    let previous = -1;
    for (const home of population.homes) {
      if (!validHome(home) || home.partition <= previous || partitions.has(home.partition)) unavailable();
      previous = home.partition;
      partitions.add(home.partition);
    }
    retained.push({ id: pool.id, population });
  }
  return { epoch: createHash('sha256').update(JSON.stringify(retained)).digest('hex'), pools: retained };
}

/** Complete native candidate stream for both group discovery and per-work child discovery.
 * The caller classifies and matches these current keys using complete native evidence; a key alone grants
 * neither disclosure nor ownership. Private positions must pass through the existing encrypted cursors.
 * A common frontier lets each pool replay unconsumed lookahead without a growing per-pool cursor or seen set.
 */
export async function readReleaseSearchNames(input: {
  pools: readonly ReleaseSearchNamePool[];
  cut: ReleaseSearchNameCut;
  after: string | null;
  size: number;
  context: Context;
}): Promise<{ keys: Candidate[]; after: string; exhausted: boolean }> {
  const { size, context } = input;
  if (!Number.isInteger(size) || size < 1 || size > MAX_KEYS) throw new TypeError('Invalid native name page size');
  // Own the complete read plan before any asynchronous reservation or source observation.
  const pools = orderedPools(input.pools);
  const cut = structuredClone(input.cut);
  const after = position(input.after, cut.epoch);
  const assertCurrent = async () => {
    if (!isDeepStrictEqual(await observeReleaseSearchNames(pools, context), cut))
      throw new ReleaseGroupingRestartRequired();
  };
  await assertCurrent();
  let frontier: Candidate[] = [];
  let nativeEnd = true;
  // Keep at most one page plus one home's lookahead, independent of the population's fanout.
  for (const pool of pools) {
    const population = cut.pools.find((retained) => retained.id === pool.id)?.population;
    if (!population) throw new ReleaseGroupingRestartRequired();
    for (const home of population.homes) {
      context.reserve({ pool: pool.id, observations: 2, ownerReads: 1, nameSeeks: 1, keys: size });
      const page = await pool.names.read({ partition: home.partition, after, limit: size }, population, context);
      if (!isDeepStrictEqual(page.home, home)) throw new ReleaseGroupingRestartRequired();
      if (page.candidates.length > size) unavailable();
      nativeEnd &&= page.candidates.length < size;
      let previous = after;
      for (const candidate of page.candidates) {
        if (
          !key(candidate) ||
          subjectPartition(candidate.id) !== home.partition ||
          !Number.isSafeInteger(candidate.securityRevision) ||
          candidate.securityRevision < 0 ||
          (previous !== null && compare(previous, candidate) >= 0)
        )
          unavailable();
        previous = candidate;
        frontier.push({
          id: candidate.id,
          name: candidate.name,
          securityRevision: candidate.securityRevision,
          partition: home.partition,
          pool: pool.id,
        });
      }
      frontier.sort(compare);
      // Discarded lookahead is sought and reserved again from the unchanged shared frontier on resume.
      if (frontier.length > size) {
        nativeEnd = false;
        frontier.length = size;
      }
    }
  }
  await assertCurrent();
  const last = frontier.at(-1);
  return {
    keys: frontier,
    after: JSON.stringify({ version: 1, epoch: cut.epoch, key: last ? { name: last.name, id: last.id } : after }),
    exhausted: nativeEnd,
  };
}
