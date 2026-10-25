import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../request/access.ts';
import fenceStatement from './fence.sql';
import readReceipt from './read-receipt.sql';
import readTime from './time.sql';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';

export type CommandEvent = { type: string; subject?: string; data: unknown };
export type CommandTransaction = Pick<PoolClient, 'query'>;
type CommandResult<T> = { value: T; events: CommandEvent[] };
export const MAX_COMMAND_EVENTS = 1000;

/** Principal kind marker only; never an account ID. */
export const ANONYMOUS_PRINCIPAL_ID = '00000000-0000-0000-0000-000000000000';
export type CommandPrincipal =
  | { kind: 'account'; id: string }
  | { kind: 'anonymous'; id: typeof ANONYMOUS_PRINCIPAL_ID };

/** Pure receipt-key validation; the anonymous marker never identifies an account. */
export function normalizeCommandKey(principal: CommandPrincipal, key: string): string {
  if (
    !principal ||
    (principal.kind !== 'account' && principal.kind !== 'anonymous') ||
    (principal.kind === 'anonymous' && principal.id !== ANONYMOUS_PRINCIPAL_ID) ||
    (principal.kind === 'account' &&
      (typeof principal.id !== 'string' || principal.id.length === 0 || principal.id === ANONYMOUS_PRINCIPAL_ID))
  )
    throw new TypeError('Invalid command principal');
  if (typeof key !== 'string' || key.length < 1 || key.length > 255)
    throw new TypeError('A command key must be a string of 1 to 255 characters');
  if (principal.kind === 'account') return key;
  if (
    key.length !== 36 ||
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(key)
  )
    throw new TypeError('An anonymous command key must be a canonical UUIDv4');
  return key.toLowerCase();
}

type PrincipalCommandIdentity =
  | Readonly<{
      principal: Readonly<Extract<CommandPrincipal, { kind: 'account' }>>;
      basis: Readonly<{ clientId: string; requestedBy: string | null }>;
    }>
  | Readonly<{
      principal: Readonly<Extract<CommandPrincipal, { kind: 'anonymous' }>>;
      basis: Readonly<{ clientId: null; requestedBy: null }>;
    }>;

/** Trusted verified Actor context only, never request JSON or proof of authorization. */
export function principalCommandIdentity(actor: Actor): PrincipalCommandIdentity {
  if (actor.kind === 'anonymous')
    return Object.freeze({
      principal: Object.freeze({ kind: 'anonymous', id: ANONYMOUS_PRINCIPAL_ID }),
      basis: Object.freeze({ clientId: null, requestedBy: null }),
    });
  if (actor.accountId === ANONYMOUS_PRINCIPAL_ID) throw new TypeError('The anonymous marker is not an account ID');
  return Object.freeze({
    principal: Object.freeze({ kind: 'account', id: actor.accountId }),
    basis: Object.freeze({ clientId: actor.clientId, requestedBy: actor.requestedBy }),
  });
}

export type PrincipalCommandReceipt = { kind: string; key: string; digest: Uint8Array };
export type PrincipalCommandOptions = PrincipalCommandIdentity & {
  partition: number;
  deadline?: number;
  receipt?: PrincipalCommandReceipt;
  authorization?: CommandAuthorization | undefined;
  /** Trusted service configuration only, never a request timestamp. */
  clock?: (() => Date) | undefined;
};

export type CommandReceipt = {
  actorAccountId: string;
  kind: string;
  key: string;
  digest: Uint8Array;
};

export type CommandBasis = {
  actorAccountId: string;
  clientId: string;
  requestedBy: string | null;
};

export type CommandOutcome<T> = {
  value: T;
  partition: number;
  epoch: number;
  position: bigint;
  transactionId: string;
  replayed: boolean;
};

declare const authoritativeTime: unique symbol;
/** Only runCommand can mint a time. Its value is usable for the live attempt only. */
export type AuthoritativeTime = { readonly [authoritativeTime]: true };
export type CommandAttempt = Readonly<{
  partition: number;
  basis: Readonly<CommandBasis> | null;
  time: AuthoritativeTime;
}>;
export type CommandAuthorizationMode = 'execute' | 'receipt-only';
/** Trusted service binding, never operation JSON. prepare runs with no resource
 * connection held; it can check a separately anchored parent at this attempt's T.
 * authorize makes the final resource check before any receipt is read.
 */
export type CommandAuthorization = {
  readonly action: string;
  readonly resource: Readonly<{ route: number; id: string }>;
  prepare?(attempt: CommandAttempt): Promise<unknown>;
  authorize(tx: CommandTransaction, attempt: CommandAttempt, evidence: unknown): Promise<CommandAuthorizationMode>;
  denied(): Error;
};
declare const completedAuthorization: unique symbol;
export type CompletedCommandAuthorization = Readonly<{
  [completedAuthorization]: true;
  action: string;
  resource: Readonly<{ route: number; id: string }>;
  mode: CommandAuthorizationMode;
}>;
export type CurrentCommand = CommandAttempt & Readonly<{ authorization: CompletedCommandAuthorization | null }>;
type CommandContext = { transactionId: string; time: AuthoritativeTime };
const times = new WeakMap<AuthoritativeTime, string>();
const attempts = new WeakMap<CommandTransaction, CommandAttempt>();
const commands = new WeakMap<CommandTransaction, CurrentCommand>();

export function authoritativeTimeValue(time: AuthoritativeTime): string {
  const at = times.get(time);
  if (at === undefined) throw new TypeError('Authoritative time is not from a live command attempt');
  return at;
}
/** Read-only context is unavailable before authorization or after the attempt. */
export function currentCommand(tx: CommandTransaction): CurrentCommand {
  const context = commands.get(tx);
  if (!context) throw new TypeError('No authorized live command transaction');
  return context;
}
/** Allows existing Access checks in a mutation to reuse the same attempt time. */
export function commandTime(tx: CommandTransaction): AuthoritativeTime | undefined {
  return attempts.get(tx)?.time;
}

async function mintTime(client: CommandTransaction, clock?: () => Date): Promise<AuthoritativeTime> {
  const configured = clock?.();
  if (configured && !Number.isFinite(configured.getTime())) throw new TypeError('Invalid command clock');
  const row = await readTime.run(client, { at: configured?.toISOString() ?? '' });
  if (!row) throw new TypeError('No authoritative database time');
  const time = Object.freeze({}) as AuthoritativeTime;
  times.set(time, row.at);
  return time;
}

export class IdempotencyConflictError extends Error {
  readonly partition: number;

  constructor(partition: number) {
    super(`Idempotency key was reused with a different request for partition ${partition}`);
    this.name = 'IdempotencyConflictError';
    this.partition = partition;
  }
}

export class TooManyEventsError extends Error {
  readonly partition: number;
  readonly count: number;

  constructor(partition: number, count: number) {
    super(`Command for partition ${partition} emitted ${count} events; the limit is ${MAX_COMMAND_EVENTS}`);
    this.name = 'TooManyEventsError';
    this.partition = partition;
    this.count = count;
  }
}

export class CommandUnavailableError extends Error {
  readonly reason: 'fenced' | 'moved' | 'contention' | 'deadline' | 'overloaded' | 'anonymous-receipts';
  readonly partition: number;
  readonly movedTo: string | null;
  constructor(reason: CommandUnavailableError['reason'], partition: number, movedTo: string | null = null) {
    super(`Command unavailable for partition ${partition}: ${reason}${movedTo ? ` (${movedTo})` : ''}`);
    this.name = 'CommandUnavailableError';
    this.reason = reason;
    this.partition = partition;
    this.movedTo = movedTo;
  }
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}
function remaining(deadline: number): number {
  return Math.max(1, Math.floor(deadline - Date.now()));
}
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function jitter(): Promise<void> {
  return pause(5 + Math.floor(Math.random() * 16));
}

async function boundedRead<T>(client: PoolClient, deadline: number, read: () => Promise<T>): Promise<T> {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
  try {
    await client.query(`SET LOCAL statement_timeout = '${Math.min(200, remaining(deadline))}ms'`);
    const value = await read();
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      discardConnection(client, rollbackError as Error);
    }
    throw error;
  }
}

async function waitForWritable(pool: Pool, partition: number, deadline: number): Promise<void> {
  while (Date.now() + 25 < deadline) {
    // The failed attempt has rolled back and released its client. Sleeping never
    // retains a transaction, evidence check or pool connection.
    await pause(25);
    if (Date.now() >= deadline) break;
    const state = await withConnection(pool, (client) =>
      boundedRead(client, deadline, () => readPartition(client, partition)),
    ).catch((error: unknown) => {
      if (codeOf(error) === '57014') throw new CommandUnavailableError('fenced', partition);
      throw error;
    });
    if (state?.writeState === 'active') return;
    if (state?.writeState === 'moved') throw new CommandUnavailableError('moved', partition, state.movedTo);
    if (!state) throw new CommandUnavailableError('deadline', partition);
  }
  throw new CommandUnavailableError('fenced', partition);
}

type LegacyCommandOptions = {
  partition: number;
  deadline?: number;
  basis?: CommandBasis;
  receipt?: CommandReceipt;
  authorization?: CommandAuthorization | undefined;
  /** Trusted service configuration only, never a request timestamp. */
  clock?: (() => Date) | undefined;
};

function normalizeOptions(options: LegacyCommandOptions | PrincipalCommandOptions): LegacyCommandOptions {
  if (!('principal' in options)) return options;
  const { principal, basis, receipt, ...rest } = options;
  if (principal.kind === 'anonymous') {
    if (principal.id !== ANONYMOUS_PRINCIPAL_ID || basis.clientId !== null || basis.requestedBy !== null)
      throw new TypeError('Anonymous commands require the kind marker and null attribution');
    // This guard remains required when anonymous receipt storage becomes available.
    if (!options.authorization) throw new TypeError('Anonymous commands require authorization');
    throw new CommandUnavailableError('anonymous-receipts', options.partition);
  }
  if (principal.kind !== 'account' || principal.id === ANONYMOUS_PRINCIPAL_ID || basis.clientId === null)
    throw new TypeError('Invalid account command identity');
  return {
    ...rest,
    basis: { actorAccountId: principal.id, clientId: basis.clientId, requestedBy: basis.requestedBy },
    ...(receipt ? { receipt: { ...receipt, actorAccountId: principal.id } } : {}),
  };
}

export function runCommand<T>(
  pool: Pool,
  options: LegacyCommandOptions,
  body: (tx: CommandTransaction, context: CommandContext) => Promise<CommandResult<T>>,
): Promise<CommandOutcome<T>>;
export function runCommand<T>(
  pool: Pool,
  options: PrincipalCommandOptions,
  body: (tx: CommandTransaction, context: CommandContext) => Promise<CommandResult<T>>,
): Promise<CommandOutcome<T>>;
export async function runCommand<T>(
  pool: Pool,
  input: LegacyCommandOptions | PrincipalCommandOptions,
  body: (tx: CommandTransaction, context: CommandContext) => Promise<CommandResult<T>>,
): Promise<CommandOutcome<T>> {
  const options = normalizeOptions(input);
  const { partition } = options;
  if (
    options.basis?.actorAccountId === ANONYMOUS_PRINCIPAL_ID ||
    options.receipt?.actorAccountId === ANONYMOUS_PRINCIPAL_ID
  )
    throw new TypeError('The anonymous marker is not an account ID');
  if (options.receipt && (!(options.receipt.digest instanceof Uint8Array) || options.receipt.digest.byteLength !== 32))
    throw new TypeError('A command receipt digest must be exactly 32 bytes');
  if (!Number.isInteger(partition) || partition < 0 || partition > 4095) throw new RangeError('Invalid partition');
  const receiptDigest = options.receipt ? Buffer.from(options.receipt.digest) : null;
  const basis = options.basis ? Object.freeze({ ...options.basis }) : null;
  const authorization = options.authorization;
  if (options.receipt && basis && options.receipt.actorAccountId !== basis.actorAccountId)
    throw new TypeError('Receipt actor must match the command basis');
  const deadline = options.deadline ?? Date.now() + 2000;
  let contentionAttempts = 0;
  while (Date.now() < deadline) {
    let time: AuthoritativeTime | undefined;
    try {
      let evidence: unknown;
      if (authorization?.prepare) {
        // The clock read finishes before parent/org evidence and child checkout.
        time = await withConnection(pool, (client) =>
          boundedRead(client, deadline, () => mintTime(client, options.clock)),
        );
        evidence = await authorization.prepare(Object.freeze({ partition, basis, time }));
      }
      const result = await withConnection(pool, async (client) => {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const tx: CommandTransaction = { query: client.query.bind(client) };
        try {
          await client.query("SET LOCAL lock_timeout = '200ms'");
          await client.query(`SET LOCAL statement_timeout = '${remaining(deadline)}ms'`);
          time ??= await mintTime(client, options.clock);
          const attempt = Object.freeze({ partition, basis, time });
          attempts.set(tx, attempt);
          const mode = authorization ? await authorization.authorize(tx, attempt, evidence) : 'execute';
          if (mode !== 'execute' && mode !== 'receipt-only') throw new TypeError('Invalid command authorization');
          const capability = authorization
            ? (Object.freeze({
                action: authorization.action,
                resource: Object.freeze({ ...authorization.resource }),
                mode,
              }) as CompletedCommandAuthorization)
            : null;
          commands.set(tx, Object.freeze({ ...attempt, authorization: capability }));
          if (options.receipt && receiptDigest) {
            const row = await readReceipt.run(client, {
              partition_no: partition,
              actor_account_id: options.receipt.actorAccountId,
              command_kind: options.receipt.kind,
              idempotency_key: options.receipt.key,
            });
            if (row) {
              if (!Buffer.from(row.requestDigest).equals(receiptDigest)) throw new IdempotencyConflictError(partition);
              await client.query('COMMIT');
              return {
                value: row.response as T,
                partition,
                epoch: row.epoch,
                position: BigInt(row.position),
                transactionId: row.transactionId,
                replayed: true,
              };
            }
          }
          if (mode === 'receipt-only') throw authorization!.denied();
          const transactionId = Bun.randomUUIDv7();
          const response = await body(tx, { transactionId, time });
          if (response.events.length === 0) throw new TypeError('A command must emit at least one event');
          if (response.events.length > MAX_COMMAND_EVENTS)
            throw new TooManyEventsError(partition, response.events.length);
          let receipt: Record<string, unknown> | null = null;
          let value = response.value;
          if (options.receipt && receiptDigest) {
            const serialized = JSON.stringify({
              actorAccountId: options.receipt.actorAccountId,
              kind: options.receipt.kind,
              key: options.receipt.key,
              digest: receiptDigest.toString('base64'),
              response: response.value,
            });
            if (serialized === undefined) throw new TypeError('A command receipt value must be JSON serializable');
            receipt = JSON.parse(serialized) as Record<string, unknown>;
            if (!Object.hasOwn(receipt, 'response'))
              throw new TypeError('A command receipt value must be JSON serializable');
            value = receipt.response as T;
          }
          const events = response.events.map((event) => ({ ...event, id: Bun.randomUUIDv7() }));
          await client.query(`SET LOCAL statement_timeout = '${remaining(deadline)}ms'`);
          const row = await fenceStatement.run(client, {
            partition_no: partition,
            events,
            transaction_id: transactionId,
            basis,
            receipt,
          });
          if (row.length === 0) {
            try {
              await client.query('ROLLBACK');
            } catch (rollbackError) {
              discardConnection(client, rollbackError as Error);
              throw rollbackError;
            }
            attempts.delete(tx);
            commands.delete(tx);
            times.delete(time);
            const state = await boundedRead(client, deadline, () => readPartition(client, partition));
            if (state?.writeState === 'moved') throw new CommandUnavailableError('moved', partition, state.movedTo);
            if (state?.writeState === 'fenced' || state?.writeState === 'active') {
              return null;
            }
            throw new CommandUnavailableError('deadline', partition);
          }
          await client.query('COMMIT');
          return {
            value,
            partition,
            epoch: row[0]!.epoch,
            position: BigInt(row[0]!.position),
            transactionId,
            replayed: false,
          };
        } catch (error) {
          if (codeOf(error) === '57014') {
            try {
              await client.query('ROLLBACK');
            } catch (rollbackError) {
              discardConnection(client, rollbackError as Error);
            }
            throw new CommandUnavailableError('deadline', partition);
          }
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(client, rollbackError as Error);
            throw rollbackError;
          }
          throw error;
        } finally {
          attempts.delete(tx);
          commands.delete(tx);
          if (time) times.delete(time);
        }
      });
      if (result) return result;
      // Do not keep a failed attempt's T/capability alive during operational waits.
      if (time) times.delete(time);
      await waitForWritable(pool, partition, deadline);
    } catch (error) {
      if (time) times.delete(time);
      if (error instanceof IdempotencyConflictError) throw error;
      if (error instanceof CommandUnavailableError) throw error;
      if (codeOf(error) === '57014' || Date.now() >= deadline) throw new CommandUnavailableError('deadline', partition);
      if (
        codeOf(error) === '53300' ||
        (error instanceof Error && /timeout exceeded when trying to connect/i.test(error.message))
      )
        throw new CommandUnavailableError('overloaded', partition);
      if (['40001', '40P01', '55P03'].includes(codeOf(error) ?? '')) {
        contentionAttempts++;
        if (contentionAttempts >= 3) throw new CommandUnavailableError('contention', partition);
        await jitter();
        continue;
      }
      throw error;
    } finally {
      if (time) times.delete(time);
    }
  }
  throw new CommandUnavailableError('deadline', partition);
}
