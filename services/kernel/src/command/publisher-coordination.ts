import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, QueryResultRow } from 'pg';
import {
  runCommand, withSingleCommandAttempt, noEffect, IdempotencyConflictError, CommandUnavailableError,
  type CommandTransaction, type CommandOutcome, type CommandResult,
} from './command.ts';
import {
  publisherActivationInput, preparePublisherActivationResult, decodePublisherActivationResult,
} from './publisher-activation-result.ts';
import { catalogueMechanicalSelection, CATALOGUE_MECHANICAL_REPRESENTATION } from '../semantic/definition-catalogue-mechanical.ts';
import type { CatalogueMechanicalInput, CatalogueMechanicalResult } from '../semantic/definition-catalogue-types.ts';
import type { WorkDimensions } from '../library/collection-source.ts';

type Input = Extract<CatalogueMechanicalInput, { phase: 'activation-step' }>;
type Result = Extract<CatalogueMechanicalResult, { phase: 'activation-step' }>;
type Context = Parameters<Parameters<typeof runCommand>[2]>[1];
const axes = ['candidateKeys', 'nativeRows', 'identityMetadataRows', 'emptySeeks', 'nativePoints', 'witnessKeys', 'statements', 'bytes'] as const;
const cost = (nativeRows: number, nativePoints: number, statements: number, bytes: number, emptySeeks = 0): WorkDimensions =>
  Object.freeze({ candidateKeys: 0, nativeRows, identityMetadataRows: 0, emptySeeks, nativePoints, witnessKeys: 0, statements, bytes });
const sum = (...values: WorkDimensions[]): WorkDimensions => Object.freeze(Object.fromEntries(axes.map(axis => [axis, values.reduce((n, v) => n + v[axis], 0)]))) as unknown as WorkDimensions;
function finite(value: WorkDimensions): WorkDimensions {
  const copied = Object.fromEntries(axes.map(axis => [axis, value?.[axis]])) as unknown as WorkDimensions;
  if (axes.some(axis => !Number.isSafeInteger(copied[axis]) || copied[axis] < 0)) throw new TypeError('Invalid finite publisher command work');
  return Object.freeze(copied);
}

/** Structural upper bounds, never runtime prices or admission authority. Byte
 * bounds include SQL and bytea hex transport. Foreign body/representation add. */
export const PUBLISHER_COMMAND_COST = Object.freeze({
  // Includes the ordinary executor's two BEGINs, timeout controls, time, empty
  // event fence, absent-source finalization and COMMIT, plus one failure rollback.
  controls: cost(2, 1, 9, 8192, 1),
  association: cost(4, 8, 3, 2 * CATALOGUE_MECHANICAL_REPRESENTATION.resultBytes + 16384, 2),
  resolution: cost(1, 1, 1, 2 * CATALOGUE_MECHANICAL_REPRESENTATION.resultBytes + 4096, 1),
  cleanup: cost(200, 300, 1, 32768, 1),
});
export function publisherCommandWork(body: WorkDimensions): WorkDimensions {
  return finite(sum(PUBLISHER_COMMAND_COST.controls, PUBLISHER_COMMAND_COST.association, finite(body)));
}

const columns = 'original_key, input_digest, result_digest, result_bytes, epoch, position, transaction_id';
const readSQL = `SELECT ${columns} FROM core.publisher_operation WHERE partition_no=$1 AND original_key=$2`;
const bindSQL = `INSERT INTO core.publisher_operation(partition_no,original_key,input_digest,retain_until)
  VALUES($1,$2,$3,to_timestamp($4::double precision / 1000) + interval '30 days')
  ON CONFLICT DO NOTHING RETURNING original_key`;
const storeSQL = `UPDATE core.publisher_operation SET result_digest=$3,result_bytes=$4,epoch=$5,position=$6,transaction_id=$7
  WHERE partition_no=$1 AND original_key=$2 AND transaction_id IS NULL`;
const cleanupSQL = `WITH selected AS MATERIALIZED (
  SELECT original_key FROM core.publisher_operation
  WHERE partition_no=$1 AND result_bytes IS NOT NULL AND retain_until <= transaction_timestamp()
  ORDER BY retain_until,original_key LIMIT $2 FOR UPDATE
), minimized AS (
  UPDATE core.publisher_operation p SET result_bytes=NULL FROM selected s
  WHERE p.partition_no=$1 AND p.original_key=s.original_key RETURNING p.original_key
) SELECT count(*)::int AS count FROM minimized`;
interface Row extends QueryResultRow {
  original_key: string; input_digest: string; result_digest: string | null; result_bytes: Buffer | null;
  epoch: number | null; position: string | null; transaction_id: string | null;
}
export class PublisherOutcomeUncertainError extends Error {
  constructor() { super('Publisher operation has no retained durable result'); this.name = 'PublisherOutcomeUncertainError'; }
}
export type PublisherResolution =
  | Readonly<{ status: 'committed'; outcome: CommandOutcome<Result> }>
  | Readonly<{ status: 'conflicting' }>
  | Readonly<{ status: 'uncertain' }>;
function resolve(input: Input, row: Row | undefined): PublisherResolution {
  if (!row) return { status: 'uncertain' };
  if (row.input_digest !== catalogueMechanicalSelection(input).inputDigest) return { status: 'conflicting' };
  if (!row.result_bytes || !row.result_digest || row.epoch === null || row.position === null || !row.transaction_id)
    return { status: 'uncertain' };
  return { status: 'committed', outcome: {
    value: decodePublisherActivationResult(input, { originalKey: row.original_key, inputDigest: row.input_digest,
      resultDigest: row.result_digest, bytes: row.result_bytes }),
    partition: 0, epoch: row.epoch, position: BigInt(row.position), transactionId: row.transaction_id, replayed: true,
  } };
}
type Options = { partition: number; deadline: number; clock?: (() => Date) | undefined };
type Scope = { pool: Pool; options: Options; input?: Input; work: WorkDimensions; claimed: boolean };
const scopes = new AsyncLocalStorage<Scope>();

/** Internal executor association. Only an invocation of the consumer API can
 * select this eventless branch; arbitrary empty-event/noEffect values cannot. */
export function claimPublisherCoordination(pool: Pool, options: object) {
  const scope = scopes.getStore();
  if (!scope) return undefined;
  if (scope.claimed || scope.pool !== pool || scope.options !== options) throw new TypeError('Publisher command association changed');
  scope.claimed = true;
  let bodyOpen = false;
  let finished = false;
  let statements = 0;
  let pending = 0;
  const assertLive = () => {
    if (finished) throw new TypeError('Publisher command lifetime ended');
    if (Date.now() >= scope.options.deadline) throw new CommandUnavailableError('deadline', 0);
  };
  return {
    assertLive,
    query(dispatch: () => unknown) {
      assertLive();
      if (!bodyOpen || ++statements > scope.work.statements) throw new TypeError('Publisher body exceeds declared finite command work');
      const value = dispatch();
      if (!value || typeof (value as PromiseLike<unknown>).then !== 'function') throw new TypeError('Publisher body queries must be awaited promises');
      pending++;
      return Promise.resolve(value).then(result => { assertLive(); return result; }).finally(() => { pending--; });
    },
    async lookup(tx: CommandTransaction): Promise<CommandOutcome<Result> | undefined> {
      assertLive();
      if (!scope.input) return;
      const input = scope.input;
      const selected = catalogueMechanicalSelection(input);
      // This uncommitted row serializes competing processes before either body.
      // It cannot be observed as a durable completion outside this transaction.
      const inserted = await tx.query(bindSQL, [0, selected.originalKey, selected.inputDigest, input.deadline]);
      const row = (await tx.query<Row>(`${readSQL} FOR UPDATE`, [0, selected.originalKey])).rows[0];
      assertLive();
      if (inserted.rowCount) return;
      const resolution = resolve(input, row);
      if (resolution.status === 'conflicting') throw new IdempotencyConflictError(0);
      if (resolution.status === 'uncertain') throw new PublisherOutcomeUncertainError();
      return resolution.outcome;
    },
    async body<T>(dispatch: () => Promise<CommandResult<T>>): Promise<CommandResult<T>> {
      assertLive();
      bodyOpen = true;
      try {
        const response = await dispatch();
        assertLive();
        if (pending) throw new TypeError('Publisher body left unawaited SQL');
        return response;
      } finally { bodyOpen = false; }
    },
    async store(tx: CommandTransaction, outcome: { epoch: number; position: string | bigint; transactionId: string }, value: unknown) {
      assertLive();
      if (!scope.input) return;
      const result = preparePublisherActivationResult(scope.input, value as Result);
      const written = await tx.query(storeSQL, [0, result.originalKey, result.resultDigest, result.bytes,
        outcome.epoch, outcome.position.toString(), outcome.transactionId]);
      if (written.rowCount !== 1) throw new PublisherOutcomeUncertainError();
      assertLive();
    },
    finish() { bodyOpen = false; finished = true; },
  };
}

/** Semantic owns the body and result phase. The body receives the genuine native
 * transaction/currentCommand association and must use structurally bounded SQL.
 * Its declared work is additive with Core controls and representation constants. */
export function runPublisherActivation(
  pool: Pool,
  options: Readonly<{ input: Input; bodyWork: WorkDimensions; deadline?: number; clock?: (() => Date) | undefined }>,
  body: (tx: CommandTransaction, context: Context) => Promise<Result>,
): Promise<CommandOutcome<Result>> {
  const input = publisherActivationInput(options.input);
  const bodyWork = finite(options.bodyWork);
  publisherCommandWork(bodyWork);
  const selected: Options = { partition: 0, deadline: Math.min(options.deadline ?? input.deadline, input.deadline), clock: options.clock };
  if (!Number.isSafeInteger(selected.deadline)) throw new TypeError('Invalid publisher deadline');
  return scopes.run({ pool, options: selected, input, work: bodyWork, claimed: false }, () =>
    withSingleCommandAttempt(() => runCommand(pool, selected, async (tx, context) => {
      const prepared = preparePublisherActivationResult(input, await body(tx, context));
      return { value: decodePublisherActivationResult(input, prepared), events: [] };
    })));
}

/** A fresh request deadline may resolve an older operation. Its immutable input
 * deadline still participates in the binding; absence never proves rollback. */
export async function resolvePublisherActivation(pool: Pool, input: Input, deadline: number): Promise<PublisherResolution> {
  const selected = publisherActivationInput(input);
  const key = catalogueMechanicalSelection(selected).originalKey;
  return (await withSingleCommandAttempt(() => runCommand(pool, { partition: 0, deadline }, async tx =>
    noEffect(resolve(selected, (await tx.query<Row>(readSQL, [0, key])).rows[0]))))).value;
}

/** At most 100 expired canonical payloads are minimized per native transaction.
 * Identity/digest/fence tombstones remain, so a late retry never repeats effects. */
export async function cleanupPublisherResults(pool: Pool, deadline: number, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid publisher cleanup limit');
  const options: Options = { partition: 0, deadline };
  return scopes.run({ pool, options, work: PUBLISHER_COMMAND_COST.cleanup, claimed: false }, async () =>
    (await withSingleCommandAttempt(() => runCommand(pool, options, async tx => ({
      value: (await tx.query<{ count: number }>(cleanupSQL, [0, limit])).rows[0]!.count, events: [],
    })))).value);
}
