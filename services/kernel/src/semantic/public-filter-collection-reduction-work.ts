import { memoizedValue } from '../memoized.ts';
import { statementBytes } from '../database/statement-bytes.ts';
import { BOUND_AXES, declareBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import { currentCommandWorkAssociation } from '../command/work-context.ts';
import ownerRead from './public-filter-collection-reduction-owner.sql';
import ensure from './public-filter-source-head-ensure.sql';
import lock from './public-filter-source-head-lock.sql';
import advance from './public-filter-source-head-advance.sql';
import append from './public-filter-source-log-append.sql';
import coverage from './public-filter-coverage-pending.sql';

type Query = Readonly<{ sql: string; params: readonly string[] }>;
type Statement = Readonly<{
  query: Query;
  maximum: Readonly<Record<string, unknown>>;
  work: Partial<Bound>;
  projection: Readonly<Record<string, unknown>>;
}>;

const uuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const int = 2147483647;
const bigint = '9223372036854775807';
const time = '9999-12-31T23:59:59.999999Z';
const dependency = { kind: 'dependency', locator: { kind: 'collection', route: 65535, collection: uuid } };
const affected = [{ kind: 'collection', route: 65535, collection: uuid }];
const jsonKeys = ['["scope","unresolved"]'];
function statements(): Readonly<Record<string, Statement>> {
  return memoizedValue(statements, () =>
    Object.freeze({
      owner: {
        query: ownerRead,
        maximum: { partition_no: 4095 },
        work: { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
        projection: { epoch: int, writeState: 'active' },
      },
      ensure: {
        query: ensure,
        maximum: { partition_no: 4095, owner_epoch: int },
        work: { candidateKeys: 2, nativeRows: 2, nativePoints: 2, emptySeeks: 2 },
        projection: { position: bigint },
      },
      lock: {
        query: lock,
        maximum: { partition_no: 4095, owner_epoch: int },
        work: { candidateKeys: 2, nativeRows: 2, nativePoints: 2, emptySeeks: 2 },
        projection: { position: bigint },
      },
      advance: {
        query: advance,
        maximum: { partition_no: 4095, owner_epoch: int },
        work: { candidateKeys: 2, nativeRows: 2, nativePoints: 2, emptySeeks: 2 },
        projection: { position: bigint },
      },
      append: {
        query: append,
        maximum: {
          partition_no: 4095,
          owner_epoch: int,
          position: bigint,
          transaction_id: uuid,
          cause: 'collection',
          affected,
          impacts: [dependency],
          recorded_at: time,
        },
        work: { candidateKeys: 1, nativeRows: 1, nativePoints: 1 },
        projection: { position: bigint },
      },
      coverage: {
        query: coverage,
        maximum: {
          partition_no: 4095,
          owner_epoch: int,
          position: bigint,
          transaction_id: uuid,
          input_keys: jsonKeys,
          subjects: [],
        },
        work: { candidateKeys: 2, nativeRows: 2, nativePoints: 2 },
        projection: { position: bigint },
      },
    }),
  );
}

const zero = (): Bound =>
  declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
    engineRequests: 0,
  });

function valuesFor(query: Query, input: Readonly<Record<string, unknown>>): readonly unknown[] {
  return query.params.map((name) => {
    const value = input[name];
    if (value === undefined) throw new TypeError(`Missing Collection public-reduction bind: ${name}`);
    return value;
  });
}

function bound(statement: Statement, input: Readonly<Record<string, unknown>>): Bound {
  const values = valuesFor(statement.query, input);
  const request = statementBytes(statement.query) + Buffer.byteLength(JSON.stringify(values));
  const result = Buffer.byteLength(JSON.stringify([statement.projection]));
  return declareBound({ ...zero(), ...statement.work, statements: 1, bytes: request + result });
}

function statementBounds() {
  return memoizedValue(statementBounds, () =>
    Object.freeze(
      Object.fromEntries(Object.entries(statements()).map(([id, item]) => [id, bound(item, item.maximum)])),
    ),
  );
}

export function PUBLIC_FILTER_COLLECTION_REDUCTION_DECLARATION() {
  return memoizedValue(PUBLIC_FILTER_COLLECTION_REDUCTION_DECLARATION, () =>
    Object.freeze({
      version: 1,
      axes: BOUND_AXES,
      statements: statementBounds(),
      cost: sumBounds(...Object.values(statementBounds())),
    }),
  );
}

/** Execute one actual Collection reduction statement against its immutable local maximum. */
export function runPublicFilterCollectionReductionQuery<Client, Input extends object, Result>(
  id: keyof ReturnType<typeof statements>,
  query: Readonly<{ sql: string; params: readonly string[]; run(client: Client, input: Input): Promise<Result> }>,
  client: Client,
  input: Input,
): Promise<Result> {
  const item = statements()[id];
  if (item.query.sql !== query.sql) throw new TypeError(`Collection public-reduction SQL owner mismatch: ${id}`);
  const actual = bound(item, input as Readonly<Record<string, unknown>>);
  const ceiling = statementBounds()[id];
  if (!withinCeiling(actual, ceiling))
    throw new TypeError(`Collection public-reduction bind exceeds its ceiling: ${id}`);
  const association = currentCommandWorkAssociation();
  const { engineRequests: _engineRequests, ...work } = actual;
  return association
    ? association.run(`semantic.public-filter-collection-reduction.${id}`, work, () => query.run(client, input))
    : query.run(client, input);
}
