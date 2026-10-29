import type { Pool, PoolClient } from 'pg';
import { fenceOperationalAccount } from '../access/account-share.ts';
import { AccessUnavailableError, classifyUnavailability, CommandUnavailableError } from '../access/unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineFor } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { enqueueWorkIntent, type WorkClient, type WorkIntent } from '../work/client.ts';
import {
  DEFAULT_REQUEST_DEADLINE_MS,
  mintReadTime,
  releaseOperationalTime,
  withOperationalAttempt,
  type AuthoritativeTime,
  type CommandAttempt,
  type CommandAuthorization,
  type PrincipalCommandIdentity,
} from './command.ts';
import { enterCommandGate } from './gate.ts';
import fence from './operational-fence.sql';

declare const operational: unique symbol;
export type OperationalTransaction = Pick<PoolClient, 'query'> & { readonly [operational]: true };
type CommonOptions = {
  partition: number;
  kind: string;
  accounts: readonly string[];
  workClient: WorkClient;
  deadline?: number;
  /** Trusted service configuration only. */
  clock?: () => Date;
};
export type OperationalOptions = CommonOptions &
  (
    | (Extract<PrincipalCommandIdentity, { basis: { clientId: string } }> & {
        mode: 'request';
        authorization: CommandAuthorization;
      })
    | { mode: 'work-step'; principal?: never; basis?: never; authorization?: never }
  );
type Live = { client: PoolClient; workClient: WorkClient; accounts: readonly string[]; deadline: number };
const live = new WeakMap<OperationalTransaction, Live>();

export function hasLiveOperationalTransaction(tx: Pick<PoolClient, 'query'>): tx is OperationalTransaction {
  const state = live.get(tx as OperationalTransaction);
  return state !== undefined && Date.now() < state.deadline;
}

/** Input is a consumer-owned locator object, including the fenced accounts. */
export async function enqueueIntent(tx: OperationalTransaction, intent: WorkIntent): Promise<void> {
  const state = live.get(tx);
  if (!state || !hasLiveOperationalTransaction(tx)) throw new TypeError('No live operational transaction');
  if (
    !Array.isArray(intent.input.accounts) ||
    intent.input.accounts.length !== state.accounts.length ||
    [...intent.input.accounts].sort().some((id, index) => id !== state.accounts[index])
  )
    throw new TypeError('Operational intent must name exactly its fenced accounts');
  await enqueueWorkIntent(state.workClient, state.client, intent);
}

const remaining = (deadline: number) => Math.max(1, Math.floor(deadline - Date.now()));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Derived records and their DBOS intent commit together, without command effects. */
export async function runOperationalTransaction<T>(
  pool: Pool,
  options: OperationalOptions,
  body: (tx: OperationalTransaction) => Promise<T>,
): Promise<T> {
  const { partition, kind } = options;
  const unavailable = (reason: CommandUnavailableError['reason']) =>
    Object.assign(new CommandUnavailableError(reason, partition), { operationKind: kind });
  if (typeof kind !== 'string' || !/^[\x20-\x7e]{1,255}$/.test(kind))
    throw new TypeError('Operation kind must contain 1 to 255 printable ASCII characters');
  if (!Number.isInteger(partition) || partition < 0 || partition > 4095) throw new RangeError('Invalid partition');
  if (
    !Array.isArray(options.accounts) ||
    options.accounts.length > 2 ||
    options.accounts.some((id) => routeOf(id) === null) ||
    new Set(options.accounts).size !== options.accounts.length
  )
    throw new TypeError(`Invalid accounts for ${kind}`);
  const accounts = Object.freeze([...options.accounts].sort());
  if (options.mode !== 'request' && options.mode !== 'work-step') throw new TypeError('Invalid operational mode');
  const authorization = options.authorization;
  if (
    options.mode === 'request' &&
    (!authorization ||
      options.principal?.kind !== 'account' ||
      routeOf(options.principal.id) === null ||
      !options.basis?.clientId ||
      'actorAccountId' in options.basis ||
      'receipt' in options ||
      authorization.resource.route >>> 4 !== partition)
  )
    throw new TypeError(`Invalid request identity for ${kind}`);
  if (options.mode === 'work-step' && (authorization || options.principal || options.basis))
    throw new TypeError('Work steps have no actor or authorization');
  const basis =
    options.mode === 'request'
      ? Object.freeze({
          actorAccountId: options.principal.id,
          clientId: options.basis.clientId,
          requestedBy: options.basis.requestedBy,
        })
      : null;
  const deadline = options.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
  let contentionAttempts = 0;
  let lastAccessContention: AccessUnavailableError | undefined;
  while (Date.now() < deadline) {
    let time: AuthoritativeTime | undefined;
    try {
      const gate = await enterCommandGate(pool, partition, deadline);
      if (gate.status !== 'acquired') throw unavailable(gate.status);
      try {
        // Mint once before Access preparation, holding no connection during preparation.
        time = await withConnection(pool, async (client) => {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
          try {
            await client.query(`SET LOCAL statement_timeout = '${remaining(deadline)}ms'`);
            const minted = await mintReadTime(client, options.clock);
            await client.query('COMMIT');
            return minted;
          } catch (error) {
            await client.query('ROLLBACK').catch((failure: Error) => discardConnection(client, failure));
            throw error;
          }
        });
        const attempt: CommandAttempt = Object.freeze({ partition, basis, time });
        const evidence = await authorization?.prepare?.(attempt);
        if (Date.now() >= deadline) throw unavailable('deadline');
        return await withConnection(pool, async (client) => {
          let active = true;
          const query = new Proxy(client.query, {
            apply(target, _receiver, args) {
              if (!active) throw new TypeError('No live operational transaction');
              if (Date.now() >= deadline) throw unavailable('deadline');
              return Reflect.apply(target, client, args);
            },
          });
          // Access deadline clients inherit this object and shadow its query method.
          const tx = { query } as OperationalTransaction;
          await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          try {
            return await withOperationalAttempt(tx, attempt, async () => {
              await client.query("SET LOCAL lock_timeout = '200ms'");
              await client.query(`SET LOCAL statement_timeout = '${remaining(deadline)}ms'`);
              if (authorization && (await authorization.authorize(tx, attempt, evidence)) !== 'execute')
                throw authorization.denied();
              if (!(await fence.run(tx, { partition_no: partition }))) throw unavailable('fenced');
              if (Date.now() >= deadline) throw unavailable('deadline');
              live.set(tx, { client, workClient: options.workClient, accounts, deadline });
              for (const id of accounts) await fenceOperationalAccount(tx, id);
              const value = await body(tx);
              await authorization?.finalize?.(tx, attempt, evidence);
              if (Date.now() >= deadline) throw unavailable('deadline');
              live.delete(tx);
              active = false;
              await client.query(`SET LOCAL statement_timeout = '${remaining(deadline)}ms'`);
              await client.query('COMMIT');
              return value;
            });
          } catch (error) {
            await client.query('ROLLBACK').catch((failure: Error) => discardConnection(client, failure));
            throw error;
          } finally {
            active = false;
            live.delete(tx);
          }
        });
      } finally {
        gate.release();
      }
    } catch (error) {
      if (error instanceof Error && Object.isExtensible(error)) Object.assign(error, { operationKind: kind });
      if (error instanceof CommandUnavailableError) throw error;
      const reason = classifyUnavailability(error);
      lastAccessContention = error instanceof AccessUnavailableError && reason === 'contention' ? error : undefined;
      if (error instanceof AccessUnavailableError && reason !== 'contention') throw error;
      if (reason === 'deadline') throw unavailable('deadline');
      if (reason === 'contention') {
        if (Date.now() >= deadline) throw lastAccessContention ?? unavailable('contention');
        const maximum = Math.min(100, 5 * 2 ** contentionAttempts++);
        await pause(Math.min(Math.random() * maximum, Math.max(0, deadline - Date.now())));
        continue;
      }
      if (Date.now() >= deadline) throw unavailable('deadline');
      if (reason === 'overloaded') throw unavailable('overloaded');
      throw error;
    } finally {
      if (time) releaseOperationalTime(time);
    }
  }
  throw lastAccessContention ?? unavailable('deadline');
}
