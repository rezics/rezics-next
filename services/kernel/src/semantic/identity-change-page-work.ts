import type { WorkDimensions } from '../library/contract/work-dimensions.ts';
import { libraryIdentityNativeOperationFootprint } from '../library/identity-native-bounds.ts';
import { memoizedValue } from '../memoized.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/contract.ts';
import { identityChangeTransformSQL } from './identity-epoch-store-change-transform.ts';
import inputs from './identity-epoch-store-select-input.sql';
import originals from './identity-epoch-store-select-original.sql';

const uuid = (value: unknown) =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const partition = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < PARTITIONS;
const jobHome = (home: unknown, job: unknown) => {
  const route = typeof job === 'string' ? routeOf(job) : null;
  return route !== null && home === partitionOf(route);
};

const maxId = 'ffffffff-ffff-7fff-bfff-ffffffffffff';
const maxEpoch = '9223372036854775807';
const maxHome = PARTITIONS - 1;
// Only the fixed kind and UUID columns cross the wire. The full persisted intent has no byte ceiling here.
const transformBytes = Buffer.byteLength(
  JSON.stringify({
    kind: 'unmerge',
    survivor: maxId,
    original: maxId,
    terminal: maxId,
    remainder_terminal: maxId,
  }),
);

type ChangePageCost = Readonly<{
  sql: string;
  work: WorkDimensions;
  footprint(values: readonly unknown[]): WorkDimensions | undefined;
}>;

// Search's metadata axis funds full Identity basis sweeps. These reads each use one keyed
// index seek, so reuse the Identity caller's query costs as native work in this ledger.
function indexedRead(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  const cost = libraryIdentityNativeOperationFootprint(sql, values);
  return cost && Object.freeze({ ...cost, identityMetadataRows: 0 });
}

export function identityChangePageCosts(): readonly ChangePageCost[] {
  return memoizedValue(identityChangePageCosts, () => {
    const declare = (sql: string, values: readonly unknown[], footprint: ChangePageCost['footprint']) => {
      const work = footprint(values);
      if (!work) throw new TypeError('Missing Identity change page work declaration');
      return Object.freeze({ sql, work, footprint });
    };
    return Object.freeze([
      declare(identityChangeTransformSQL, [maxHome, maxId, maxEpoch], (values) => {
        const [home, job, epoch] = values;
        if (
          values.length !== 3 ||
          !jobHome(home, job) ||
          typeof epoch !== 'string' ||
          !/^[1-9][0-9]{0,18}$/.test(epoch) ||
          (epoch.length === maxEpoch.length && epoch > maxEpoch)
        )
          return undefined;
        return Object.freeze({
          candidateKeys: 0,
          identityMetadataRows: 0,
          nativeRows: 1,
          nativePoints: 1,
          witnessKeys: 0,
          statements: 1,
          bytes:
            Buffer.byteLength(identityChangeTransformSQL) + Buffer.byteLength(JSON.stringify(values)) + transformBytes,
          emptySeeks: 1,
        });
      }),
      declare(inputs.sql, [maxHome, maxId], (values) =>
        values.length === 2 && jobHome(values[0], values[1]) ? indexedRead(inputs.sql, values) : undefined,
      ),
      declare(originals.sql, [maxId, maxId, 100, maxId, maxHome], (values) => {
        const [generation, after, limit, terminal, home] = values;
        return values.length === 5 &&
          uuid(generation) &&
          (after === null || uuid(after)) &&
          (limit === 50 || limit === 100) &&
          uuid(terminal) &&
          partition(home)
          ? indexedRead(originals.sql, values)
          : undefined;
      }),
    ]);
  });
}
