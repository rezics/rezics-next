/** Native owner composition for the existing one-Collection privacy reduction. */
import { declareBound, sumBounds, type Bound } from '@rezics/bounds';
import partition from '../partition/read.sql';
import ensure from './public-filter-source-head-ensure.sql';
import lock from './public-filter-source-head-lock.sql';
import advance from './public-filter-source-head-advance.sql';
import append from './public-filter-source-log-append.sql';
import coverage from './public-filter-coverage-pending.sql';

const cost = (part: Partial<Bound>): Bound =>
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
    ...part,
  });
const uuid = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const at = '\0'.repeat(64);
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** The immutable log owns the coverage point: one unresolved dependency, no subject fanout.
 * Head/partition locks, log PK + transaction unique index, their FK/immutability triggers,
 * and pending coverage's PK/live index/owner FK are included. No definition scan occurs.
 */
export function collectionPrivacyReductionPlan(route: number, collection: string, transactionId = uuid) {
  const affected = [{ kind: 'collection', route, collection }];
  const impacts = [{ kind: 'dependency', locator: { kind: 'collection', route, collection } }];
  const operands = Object.freeze({
    partition_no: 4095,
    owner_epoch: 2_147_483_647,
    position: '9223372036854775807',
    transaction_id: transactionId,
    cause: 'collection',
    affected,
    impacts,
    recorded_at: at,
    input_keys: ['["scope","unresolved"]'],
    subjects: [],
  });
  const statement = (
    query: { sql: string; params: readonly string[] },
    rows: number,
    points: number,
    projection: number,
  ) =>
    cost({
      candidateKeys: points,
      nativeRows: rows,
      nativePoints: points,
      emptySeeks: points,
      statements: 1,
      bytes:
        Buffer.byteLength(query.sql) +
        size(query.params.map((key) => operands[key as keyof typeof operands])) +
        projection,
    });
  const terms = Object.freeze({
    partition: statement(partition, 1, 1, 512),
    ensure: statement(ensure, 2, 2, 32),
    lock: statement(lock, 2, 2, 32),
    advance: statement(advance, 5, 4, 32),
    append: statement(append, 9, 8, 32),
    coverage: statement(coverage, 12, 10, 32),
  });
  return Object.freeze({ operands, terms, total: sumBounds(...Object.values(terms)) });
}
