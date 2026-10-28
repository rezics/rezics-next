export const DEFAULT_REQUEST_DEADLINE_MS = 2000;

import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../request/access.ts';
import { AccessUnavailableError, classifyUnavailability, CommandUnavailableError } from '../access/unavailable.ts';
export { CommandUnavailableError } from '../access/unavailable.ts';
import fenceStatement from './fence.sql';
import noEffectFenceStatement from './no-effect-fence.sql';
import readReceipt from './read-receipt.sql';
import readOwnCompletion from './read-own-completion.sql';
import readTime from './time.sql';
import { discardConnection, withConnection } from '../database/pool.ts';
import { lookupEventType, sealEventTypes } from '../events/catalogue.ts';
import { readPartition } from '../partition/partition.ts';
import { enterCommandGate } from './gate.ts';
import { deadlineFor } from '../request/deadline.ts';

export type CommandEvent = { type: string; subject?: string; data: unknown };
export type CommandTransaction = Pick<PoolClient, 'query'>;
export type CommandCallback = (transactionId: string) => void | Promise<void>;
export type CommandResult<T> = Readonly<{ value: T; events: readonly CommandEvent[] }>;
const noEffectResults = new WeakSet<object>();

/**
 * Return a successful command result without domain events. The body must make
 * no domain write; this result asserts that it did not. Its observed position
 * can be 0. Callers whose consumers require a positive position must not use
 * noEffect.
 */
export function noEffect<T>(value: T): CommandResult<T> {
  const result = Object.freeze({ value, events: Object.freeze([]) });
  noEffectResults.add(result);
  return result;
}

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

export type PrincipalCommandIdentity =
  | Readonly<{
      principal: Readonly<Extract<CommandPrincipal, { kind: 'account' }>>;
      basis: Readonly<{ clientId: string; requestedBy: string | null }>;
    }>
  | Readonly<{
      principal: Readonly<Extract<CommandPrincipal, { kind: 'anonymous' }>>;
      basis: Readonly<{ clientId: null; requestedBy: null }>;
    }>;

/** Trusted verified Actor context only, never request JSON or proof of authorization. */
export function principalCommandIdentity(
  actor: Extract<Actor, { kind: 'anonymous' }>,
): Extract<PrincipalCommandIdentity, { basis: { clientId: null } }>;
export function principalCommandIdentity(
  actor: Extract<Actor, { kind: 'account' }>,
): Extract<PrincipalCommandIdentity, { basis: { clientId: string } }>;
export function principalCommandIdentity(actor: Actor): PrincipalCommandIdentity;
export function principalCommandIdentity(actor: Actor): PrincipalCommandIdentity {
  if (actor.kind === 'anonymous')
    return Object.freeze({
      principal: Object.freeze({ kind: 'anonymous', id: ANONYMOUS_PRINCIPAL_ID }),
      basis: Object.freeze({ clientId: null, requestedBy: null }),
    });
  assertPrincipal({ kind: actor.kind, id: actor.accountId });
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

/** Anonymous attribution never supplies a legacy account identity. */
export type CommandAttribution =
  | CommandBasis
  | {
      principal: Readonly<Extract<CommandPrincipal, { kind: 'anonymous' }>>;
      actorAccountId: null;
      clientId: null;
      requestedBy: null;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertPrincipal(principal: CommandPrincipal): void {
  if (!principal || (principal.kind !== 'account' && principal.kind !== 'anonymous'))
    throw new TypeError('Invalid command principal');
  if (principal.kind === 'anonymous') {
    if (principal.id !== ANONYMOUS_PRINCIPAL_ID) throw new TypeError('Invalid anonymous kind marker');
  } else if (
    typeof principal.id !== 'string' ||
    principal.id.length !== 36 ||
    !UUID.test(principal.id) ||
    principal.id === ANONYMOUS_PRINCIPAL_ID
  )
    throw new TypeError('The anonymous marker is not an account ID');
}

export type CommandOutcome<T> = {
  value: T;
  partition: number;
  epoch: number;
  position: bigint;
  transactionId: string;
  replayed: boolean;
};

declare const authoritativeTime: unique symbol;
/** Opaque authoritative time minted for one live command attempt or one read. */
export type AuthoritativeTime = { readonly [authoritativeTime]: true };
export type CommandAttempt = Readonly<{
  partition: number;
  basis: Readonly<CommandAttribution> | null;
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
  /** Runs only after a successful body, before receipt/outbox writes. Never on replay. */
  finalize?(tx: CommandTransaction, attempt: CommandAttempt, evidence: unknown): Promise<void>;
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
// Exact executor object only: copying a query or callback capability conveys no receipt authority.
const receiptOwners = new WeakMap<
  CommandTransaction,
  Readonly<{ principal: Readonly<CommandPrincipal>; partition: number; deadline: number }>
>();

function assertReceipt(receipt: PrincipalCommandReceipt): void {
  // Native command kinds are strings, with no catalogue or additional syntax restriction.
  if (typeof receipt.kind !== 'string') throw new TypeError('A command kind must be a string');
  if (!(receipt.digest instanceof Uint8Array) || receipt.digest.byteLength !== 32)
    throw new TypeError('A command receipt digest must be exactly 32 bytes');
}

/** Completion metadata only. The caller must retain the queried intent's action/resource policy. */
export async function hasOwnCommandCompletion(
  tx: CommandTransaction,
  receipt: PrincipalCommandReceipt,
): Promise<boolean> {
  const owner = receiptOwners.get(tx);
  if (!owner || Date.now() >= owner.deadline) throw new TypeError('No authorized live receipt owner transaction');
  assertPrincipal(owner.principal);
  const key = normalizeCommandKey(owner.principal, receipt.key);
  assertReceipt(receipt);
  const digest = Buffer.from(receipt.digest);
  const row = await readOwnCompletion.run(tx, {
    partition_no: owner.partition,
    principal_kind: owner.principal.kind,
    principal_id: owner.principal.id,
    command_kind: receipt.kind,
    idempotency_key: key,
  });
  if (!row) return false;
  if (!Buffer.from(row.requestDigest).equals(digest)) throw new IdempotencyConflictError(owner.partition);
  return true;
}

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

const transactionCallbacks = Symbol('command callbacks');
type CallbackState = { active: boolean; callbacks: CommandCallback[] };
type CallbackTransaction = CommandTransaction & { [transactionCallbacks]?: CallbackState };

/** Register work for the current command after its body and finalizer succeed.
 * The callback receives the executor-minted transaction id and runs before the
 * receipt and outbox are written. Registration is scoped to one live attempt.
 */
export function registerCommandCallback(tx: CommandTransaction, callback: CommandCallback): void {
  const state = (tx as CallbackTransaction)[transactionCallbacks];
  if (!state?.active) throw new TypeError('No live command transaction');
  if (typeof callback !== 'function') throw new TypeError('Command callback must be a function');
  state.callbacks.push(callback);
}

/** True for the transaction and deadline-bound wrappers around it while the
 * executor attempt is live. The symbol capability is private to this module.
 */
export function hasLiveCommandTransaction(tx: CommandTransaction): boolean {
  return (tx as CallbackTransaction)[transactionCallbacks]?.active === true;
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

/** Mints an authoritative time for a read outside a command, with no command context. */
export function mintReadTime(client: CommandTransaction, clock?: () => Date): Promise<AuthoritativeTime> {
  return mintTime(client, clock);
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

function remaining(deadline: number): number {
  return Math.max(1, Math.floor(deadline - Date.now()));
}
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      if (classifyUnavailability(error) === 'deadline') throw new CommandUnavailableError('fenced', partition);
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

type NormalizedOptions = Omit<LegacyCommandOptions, 'basis' | 'receipt'> & {
  principal?: Readonly<CommandPrincipal>;
  basis?: CommandAttribution;
  receipt?: PrincipalCommandReceipt & { principal: Readonly<CommandPrincipal> };
};

function normalizeOptions(options: LegacyCommandOptions | PrincipalCommandOptions): NormalizedOptions {
  if (!('principal' in options)) {
    const { basis, receipt, ...rest } = options;
    if ((basis && 'principal' in basis) || (receipt && 'principal' in receipt))
      throw new TypeError('Mixed command identity fields');
    const principal: CommandPrincipal | undefined =
      receipt || basis ? { kind: 'account', id: receipt?.actorAccountId ?? basis!.actorAccountId } : undefined;
    if (principal) assertPrincipal(principal);
    if (basis) assertPrincipal({ kind: 'account', id: basis.actorAccountId });
    if (receipt && basis && receipt.actorAccountId !== basis.actorAccountId)
      throw new TypeError('Receipt actor must match the command basis');
    return {
      ...rest,
      ...(principal ? { principal: Object.freeze(principal) } : {}),
      ...(basis ? { basis: { ...basis } } : {}),
      ...(receipt
        ? {
            receipt: {
              principal: Object.freeze(principal!),
              kind: receipt.kind,
              key: normalizeCommandKey(principal!, receipt.key),
              digest: receipt.digest,
            },
          }
        : {}),
    };
  }
  const { principal: inputPrincipal, basis, receipt, ...rest } = options;
  assertPrincipal(inputPrincipal);
  const principal = Object.freeze({ ...inputPrincipal });
  if (
    'actorAccountId' in options ||
    'actorAccountId' in inputPrincipal ||
    !basis ||
    'actorAccountId' in basis ||
    'principal' in basis ||
    (receipt && ('actorAccountId' in receipt || 'principal' in receipt))
  )
    throw new TypeError('Mixed command identity fields');
  if (principal.kind === 'anonymous') {
    if (principal.id !== ANONYMOUS_PRINCIPAL_ID || basis.clientId !== null || basis.requestedBy !== null)
      throw new TypeError('Anonymous commands require the kind marker and null attribution');
    if (!options.authorization) throw new TypeError('Anonymous commands require authorization');
    if (!receipt) throw new TypeError('Anonymous commands require a client-generated UUIDv4 key');
    return {
      ...rest,
      principal,
      basis: { principal, actorAccountId: null, clientId: null, requestedBy: null },
      receipt: {
        principal,
        kind: receipt.kind,
        key: normalizeCommandKey(principal, receipt.key),
        digest: receipt.digest,
      },
    };
  }
  if (typeof basis.clientId !== 'string' || basis.clientId.length === 0)
    throw new TypeError('Invalid account command identity');
  return {
    ...rest,
    principal,
    basis: { actorAccountId: principal.id, clientId: basis.clientId, requestedBy: basis.requestedBy },
    ...(receipt
      ? {
          receipt: {
            principal,
            kind: receipt.kind,
            key: normalizeCommandKey(principal, receipt.key),
            digest: receipt.digest,
          },
        }
      : {}),
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
  if (options.receipt) assertReceipt(options.receipt);
  if (!Number.isInteger(partition) || partition < 0 || partition > 4095) throw new RangeError('Invalid partition');
  const receiptDigest = options.receipt ? Buffer.from(options.receipt.digest) : null;
  const basis = options.basis ? Object.freeze({ ...options.basis }) : null;
  const authorization = options.authorization;
  const deadline = options.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
  let contentionAttempts = 0;
  let lastAccessContention: AccessUnavailableError | undefined;
  while (Date.now() < deadline) {
    let time: AuthoritativeTime | undefined;
    try {
      let evidence: unknown;
      let attempt: CommandAttempt | undefined;
      if (authorization?.prepare) {
        // The clock read finishes before parent/org evidence and child checkout.
        time = await withConnection(pool, (client) =>
          boundedRead(client, deadline, () => mintTime(client, options.clock)),
        );
        attempt = Object.freeze({ partition, basis, time });
        evidence = await authorization.prepare(attempt);
      }
      const gate = await enterCommandGate(pool, partition, deadline);
      if (gate.status !== 'acquired') throw new CommandUnavailableError(gate.status, partition);
      const result = await withConnection(pool, async (client) => {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const tx: CommandTransaction = { query: client.query.bind(client) };
        const callbackState: CallbackState = { active: true, callbacks: [] };
        Object.defineProperty(tx, transactionCallbacks, { value: callbackState });
        try {
          await client.query("SET LOCAL lock_timeout = '200ms'");
          await client.query(`SET LOCAL statement_timeout = '${remaining(deadline)}ms'`);
          time ??= await mintTime(client, options.clock);
          attempt ??= Object.freeze({ partition, basis, time });
          attempts.set(tx, attempt);
          const mode = authorization ? await authorization.authorize(tx, attempt, evidence) : 'execute';
          if (mode !== 'execute' && mode !== 'receipt-only') throw new TypeError('Invalid command authorization');
          if (options.principal?.kind === 'anonymous' && mode !== 'execute') throw authorization!.denied();
          const capability = authorization
            ? (Object.freeze({
                action: authorization.action,
                resource: Object.freeze({ ...authorization.resource }),
                mode,
              }) as CompletedCommandAuthorization)
            : null;
          commands.set(tx, Object.freeze({ ...attempt, authorization: capability }));
          if (capability && mode === 'execute' && options.principal)
            receiptOwners.set(tx, Object.freeze({ principal: options.principal, partition, deadline }));
          if (options.receipt && receiptDigest) {
            const row = await readReceipt.run(client, {
              partition_no: partition,
              principal_kind: options.receipt.principal.kind,
              principal_id: options.receipt.principal.id,
              command_kind: options.receipt.kind,
              idempotency_key: options.receipt.key,
            });
            if (row) {
              if (!Buffer.from(row.requestDigest).equals(receiptDigest)) throw new IdempotencyConflictError(partition);
              receiptOwners.delete(tx);
              await client.query('COMMIT');
              sealEventTypes();
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
          const noEffect = response.events.length === 0 && noEffectResults.has(response);
          if (response.events.length === 0 && !noEffect) throw new TypeError('A command must emit at least one event');
          if (response.events.length > MAX_COMMAND_EVENTS)
            throw new TooManyEventsError(partition, response.events.length);
          const events = noEffect
            ? []
            : response.events.map(({ type, subject, data: inputData }) => {
                const validator = lookupEventType(type);
                if (!validator) throw new TypeError(`Unregistered event type: ${type}`);
                let data: unknown;
                try {
                  const serialized = JSON.stringify(inputData);
                  if (serialized === undefined) throw new TypeError('Event data must be JSON serializable');
                  data = JSON.parse(serialized);
                } catch (error) {
                  throw new TypeError(`Invalid event data for ${type}: ${String(error)}`);
                }
                if (!validator.Check(data)) {
                  const error = validator.Errors(data)[0]!;
                  throw new TypeError(`Invalid event data for ${type}: ${error.instancePath} ${error.message}`);
                }
                return { type, subject, data, id: Bun.randomUUIDv7() };
              });
          await authorization?.finalize?.(tx, attempt, evidence);
          if (noEffect && callbackState.callbacks.length > 0)
            throw new TypeError('A no-effect command registers no work');
          for (let index = 0; index < callbackState.callbacks.length; index++)
            await callbackState.callbacks[index]!(transactionId);
          let receipt: Record<string, unknown> | null = null;
          let value = response.value;
          if (options.receipt && receiptDigest) {
            const serialized = JSON.stringify({
              principal: options.receipt.principal,
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
          await client.query(`SET LOCAL statement_timeout = '${remaining(deadline)}ms'`);
          const row = noEffect
            ? await noEffectFenceStatement.run(client, {
                partition_no: partition,
                transaction_id: transactionId,
                receipt,
              })
            : await fenceStatement.run(client, {
                partition_no: partition,
                events,
                transaction_id: transactionId,
                basis: basis
                  ? { principal: options.principal, clientId: basis.clientId, requestedBy: basis.requestedBy }
                  : null,
                receipt,
              });
          if (row.length === 0) {
            receiptOwners.delete(tx);
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
          receiptOwners.delete(tx);
          await client.query('COMMIT');
          sealEventTypes();
          return {
            value,
            partition,
            epoch: row[0]!.epoch,
            position: BigInt(row[0]!.position),
            transactionId,
            replayed: false,
          };
        } catch (error) {
          receiptOwners.delete(tx);
          if (!(error instanceof AccessUnavailableError) && classifyUnavailability(error) === 'deadline') {
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
          receiptOwners.delete(tx);
          callbackState.active = false;
          callbackState.callbacks.length = 0;
          attempts.delete(tx);
          commands.delete(tx);
          if (time) times.delete(time);
        }
      }).finally(gate.release);
      if (result) return result;
      // Do not keep a failed attempt's T/capability alive during operational waits.
      if (time) times.delete(time);
      await waitForWritable(pool, partition, deadline);
    } catch (error) {
      if (time) times.delete(time);
      if (error instanceof IdempotencyConflictError) throw error;
      if (error instanceof CommandUnavailableError) throw error;
      const reason = classifyUnavailability(error);
      lastAccessContention = error instanceof AccessUnavailableError && reason === 'contention' ? error : undefined;
      if (error instanceof AccessUnavailableError && reason !== 'contention') throw error;
      if (reason === 'deadline') throw new CommandUnavailableError('deadline', partition);
      if (reason === 'contention') {
        if (Date.now() >= deadline) {
          if (error instanceof AccessUnavailableError) throw error;
          throw new CommandUnavailableError('contention', partition);
        }
        const maximum = Math.min(100, 5 * 2 ** contentionAttempts++);
        await pause(Math.min(Math.random() * maximum, Math.max(0, deadline - Date.now())));
        if (Date.now() >= deadline) {
          if (error instanceof AccessUnavailableError) throw error;
          throw new CommandUnavailableError('contention', partition);
        }
        continue;
      }
      if (Date.now() >= deadline) throw new CommandUnavailableError('deadline', partition);
      if (reason === 'overloaded') throw new CommandUnavailableError('overloaded', partition);
      throw error;
    } finally {
      if (time) times.delete(time);
    }
  }
  if (lastAccessContention) throw lastAccessContention;
  throw new CommandUnavailableError('deadline', partition);
}
