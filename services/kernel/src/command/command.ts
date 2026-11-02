import { commandRecordSources, finalizeCommandRecordSources } from '../history/record-source.ts';
import { hasCommandRecordSourceSet } from '../history/record-source-set.ts';
import { commandAgentIdentitySource } from '../history/agent-identity-source.ts';
import {
  claimCommandDispatchLifetime,
  COMMAND_DISPATCH_TIME_SQL,
  type CommandDispatchLifetime,
} from './dispatch-lifetime.ts';
export const DEFAULT_REQUEST_DEADLINE_MS = 2000;

import type { Pool, PoolClient } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Actor } from '../request/access.ts';
import { AccessUnavailableError, classifyUnavailability, CommandUnavailableError } from '../access/unavailable.ts';
export { CommandUnavailableError } from '../access/unavailable.ts';
import fenceStatement from './fence.sql';
import noEffectFenceStatement from './no-effect-fence.sql';
import { claimPublisherCoordination } from './publisher-coordination.ts';
import readReceipt from './read-receipt.sql';
import readOwnCompletion from './read-own-completion.sql';
import readTime from './time.sql';
import { discardConnection, withConnection } from '../database/pool.ts';
import { lookupEventType, sealEventTypes } from '../events/catalogue.ts';
import { readPartition } from '../partition/partition.ts';
import { commandPhase, countContentionRetry, measureCommandPhase } from './timing.ts';
import { currentCommandWorkAssociation, type CommandWorkAssociation } from './work-context.ts';
import { enterCommandGate } from './gate.ts';
import { deadlineFor } from '../request/deadline.ts';
import { bindReceiptKeys, receiptKeyCandidates, receiptKeysFor } from './receipt-key.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  recordCommandHistory,
  releaseCommandHistory,
  validateCommandHistory,
  validateCommandHistoryScope,
} from '../history/record.ts';

export type CommandEvent = { type: string; subject?: string; data: unknown };
export type CommandTransaction = Pick<PoolClient, 'query'>;

// A maintenance owner may surrender automatic retries. This is scheduling policy,
// never authorization or another work allowance. Later scheduling starts a new unit.
const singleAttempt = new AsyncLocalStorage<boolean>();
export function withSingleCommandAttempt<T>(body: () => Promise<T>): Promise<T> {
  return singleAttempt.run(true, body);
}
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

/** Union-valued callers may assemble these fields separately; normalization
 * checks their correlation before acquiring a connection or reading a receipt. */
type PrincipalCommandInput = Omit<PrincipalCommandOptions, 'principal' | 'basis'> & {
  principal: Readonly<CommandPrincipal>;
  basis: Readonly<{ clientId: string | null; requestedBy: string | null }>;
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
  /** Optional trusted accounting context; it grants no request or authorization evidence. */
  commandWork?: CommandWorkAssociation;
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
export type CurrentCommand = CommandAttempt &
  Readonly<{ transactionId: string; authorization: CompletedCommandAuthorization | null }>;
type CommandContext = { transactionId: string; time: AuthoritativeTime };
const times = new WeakMap<AuthoritativeTime, string>();
const attempts = new WeakMap<CommandTransaction, CommandAttempt>();
const attemptDeadlines = new WeakMap<CommandAttempt, number>();
const commands = new WeakMap<CommandTransaction, CurrentCommand>();
const commandResources = new WeakMap<CommandTransaction, Readonly<{ pool: Pool; deadline: number }>>();
const nativeReceipts = new WeakMap<
  CommandTransaction,
  Readonly<{
    principal: CommandPrincipal;
    kind: string;
    key: string;
    storageKey: string;
  }>
>();

/** Original source writers consume the executor's actual codec result, never a second HMAC.
 * Available only after authorization and replay lookup, on the original transaction. */
export function currentCommandReceipt(tx: CommandTransaction) {
  currentCommand(tx);
  const receipt = nativeReceipts.get(tx);
  if (!receipt) throw new TypeError('No original live command receipt');
  return receipt;
}
// Exact executor object only: copying a query or callback capability conveys no receipt authority.
const receiptOwners = new WeakMap<
  CommandTransaction,
  Readonly<{
    principal: Readonly<CommandPrincipal>;
    partition: number;
    deadline: number;
    receiptKeys: KeyRing;
  }>
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
    idempotency_keys: receiptKeyCandidates(owner.receiptKeys, receipt.kind, owner.principal, key),
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
  assertSelectedCallback(tx);
  return context;
}
/** Trusted owner factories reuse the live executor resources; this grants no second checkout. */
export function currentCommandResources(tx: CommandTransaction): Readonly<{ pool: Pool; deadline: number }> {
  currentCommand(tx);
  const resources = commandResources.get(tx);
  if (!resources) throw new TypeError('No live command resources');
  return resources;
}
/** Allows existing Access checks in a mutation to reuse the same attempt time. */
export function commandTime(tx: CommandTransaction): AuthoritativeTime | undefined {
  return attempts.get(tx)?.time;
}

/** Executor-owned budget for source preparation; copied attempts have no budget. */
export function commandAttemptDeadline(attempt: CommandAttempt): number {
  authoritativeTimeValue(attempt.time);
  const deadline = attemptDeadlines.get(attempt);
  if (deadline === undefined || Date.now() >= deadline) throw new TypeError('No live command attempt budget');
  return deadline;
}

/** Executor internals: lend Access an attempt time without granting command authority.
 * Operational attempts never enter commands, receiptOwners or the callback registry.
 */
export async function withOperationalAttempt<T>(
  tx: CommandTransaction,
  attempt: CommandAttempt,
  run: () => Promise<T>,
): Promise<T> {
  if (attempts.has(tx) || hasLiveCommandTransaction(tx)) throw new TypeError('Transaction already has an attempt');
  attempts.set(tx, attempt);
  try {
    return await run();
  } finally {
    attempts.delete(tx);
    times.delete(attempt.time);
  }
}

/** Release an executor time when preparation fails before resource checkout. */
export function releaseOperationalTime(time: AuthoritativeTime): void {
  times.delete(time);
}

const transactionCallbacks = Symbol('command callbacks');
type CallbackState = { active: boolean; callbacks: CommandCallback[] };
type CallbackTransaction = CommandTransaction & { [transactionCallbacks]?: CallbackState };
// Optional-path copies must not inherit callback authority by copying a symbol.
const selectedCallbacks = new WeakMap<CallbackState, { tx: CommandTransaction; dispatch: CommandDispatchLifetime }>();
function assertSelectedCallback(tx: CommandTransaction): void {
  const state = (tx as CallbackTransaction)[transactionCallbacks];
  const selected = state && selectedCallbacks.get(state);
  if (!selected) return;
  if (selected.tx !== tx) throw new TypeError('No original dispatch transaction');
  selected.dispatch.checkpoint();
}

/** Register work for the current command after its body and finalizer succeed.
 * The callback receives the executor-minted transaction id and runs before the
 * receipt and outbox are written. Registration is scoped to one live attempt.
 */
export function registerCommandCallback(tx: CommandTransaction, callback: CommandCallback): void {
  const state = (tx as CallbackTransaction)[transactionCallbacks];
  if (!state?.active) throw new TypeError('No live command transaction');
  assertSelectedCallback(tx);
  // This optional profile never admits callbacks, including descendants that try
  // to register while final controls await after the body's association check.
  if (selectedCallbacks.has(state)) throw new TypeError('Unsupported dispatch lifetime callback profile');
  if (typeof callback !== 'function') throw new TypeError('Command callback must be a function');
  state.callbacks.push(callback);
}

/** True for the transaction and deadline-bound wrappers around it while the
 * executor attempt is live. The symbol capability is private to this module.
 */
export function hasLiveCommandTransaction(tx: CommandTransaction): boolean {
  if ((tx as CallbackTransaction)[transactionCallbacks]?.active !== true) return false;
  try {
    assertSelectedCallback(tx);
    return true;
  } catch {
    return false;
  }
}

async function mintTime(
  client: CommandTransaction,
  clock?: () => Date,
  dispatch?: CommandDispatchLifetime,
): Promise<AuthoritativeTime> {
  const configured = clock?.();
  if (configured && !Number.isFinite(configured.getTime())) throw new TypeError('Invalid command clock');
  const row = dispatch
    ? (await dispatch.control('time', () => client.query<{ at: string }>(COMMAND_DISPATCH_TIME_SQL))).rows[0]
    : await readTime.run(client, { at: configured?.toISOString() ?? '' });
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

/** Carries no receipt identity, removed value or scope provenance. */
export class CommandResultErasedError extends Error {
  constructor() {
    super('Command result erased');
    this.name = 'CommandResultErasedError';
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

function normalizeOptions(options: LegacyCommandOptions | PrincipalCommandInput): NormalizedOptions {
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
  options: PrincipalCommandInput,
  body: (tx: CommandTransaction, context: CommandContext) => Promise<CommandResult<T>>,
): Promise<CommandOutcome<T>>;
export async function runCommand<T>(
  pool: Pool,
  input: LegacyCommandOptions | PrincipalCommandInput,
  body: (tx: CommandTransaction, context: CommandContext) => Promise<CommandResult<T>>,
): Promise<CommandOutcome<T>> {
  commandPhase('command_overhead');
  const dispatch = claimCommandDispatchLifetime(pool, input);
  const publisher = claimPublisherCoordination(pool, input);
  let succeeded = false;
  try {
    if (dispatch) await dispatch.prepare();
    const result = await executeCommand(pool, input, body, dispatch, publisher);
    dispatch?.checkpoint();
    succeeded = true;
    return result;
  } finally {
    dispatch?.finish(succeeded);
    publisher?.finish();
    commandPhase('request_completion');
  }
}

async function executeCommand<T>(
  pool: Pool,
  input: LegacyCommandOptions | PrincipalCommandInput,
  body: (tx: CommandTransaction, context: CommandContext) => Promise<CommandResult<T>>,
  dispatch?: CommandDispatchLifetime,
  publisher?: ReturnType<typeof claimPublisherCoordination>,
): Promise<CommandOutcome<T>> {
  const options = normalizeOptions(input);
  dispatch?.assertOptions(pool, options);
  if (publisher && (dispatch || options.authorization || options.principal || options.receipt || options.basis))
    throw new TypeError('Publisher coordination is a receipt-free mechanical command');
  const { partition } = options;
  if (options.receipt) assertReceipt(options.receipt);
  if (!Number.isInteger(partition) || partition < 0 || partition > 4095) throw new RangeError('Invalid partition');
  const receiptKeys = options.principal ? receiptKeysFor(pool) : undefined;
  const receiptCandidates = options.receipt
    ? receiptKeyCandidates(receiptKeys!, options.receipt.kind, options.receipt.principal, options.receipt.key)
    : [];
  const receiptDigest = options.receipt ? Buffer.from(options.receipt.digest) : null;
  const basis = options.basis ? Object.freeze({ ...options.basis }) : null;
  const authorization = options.authorization;
  const commandWork = currentCommandWorkAssociation();
  const deadline = commandWork
    ? Math.min(options.deadline ?? commandWork.deadline, commandWork.deadline)
    : (options.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS));
  if (commandWork && commandWork.deadline !== deadline)
    throw new TypeError('Command work association must use the original command deadline');
  let contentionAttempts = 0;
  let lastAccessContention: AccessUnavailableError | undefined;
  let singleAttemptCount = 0;
  while (Date.now() < deadline) {
    if (singleAttempt.getStore() && singleAttemptCount++ > 0)
      throw new CommandUnavailableError('contention', partition);
    let time: AuthoritativeTime | undefined;
    try {
      let evidence: unknown;
      let attempt: CommandAttempt | undefined;
      if (authorization?.prepare) {
        // The clock read finishes before parent/org evidence and child checkout.
        time = await measureCommandPhase('time_mint', () =>
          withConnection(pool, (client) => boundedRead(client, deadline, () => mintTime(client, options.clock))),
        );
        attempt = Object.freeze({ partition, basis, time, ...(commandWork ? { commandWork } : {}) });
        attemptDeadlines.set(attempt, deadline);
        evidence = await measureCommandPhase('access_prepare', () => authorization.prepare!(attempt!));
      }
      dispatch?.checkpoint();
      const gate = await measureCommandPhase('gate_wait', () => enterCommandGate(pool, partition, deadline));
      if (gate.status !== 'acquired') throw new CommandUnavailableError(gate.status, partition);
      commandPhase('transaction_pool_wait');
      const checkout = async <R>(work: (client: PoolClient) => Promise<R>): Promise<R> => {
        dispatch?.checkout();
        return withConnection(pool, (client) => {
          // Actual acquisition boundary, inside withConnection's release custody.
          // Do not wrap the whole transaction as a checkout await: its client has
          // already been released when that outer await settles.
          dispatch?.checkpoint();
          return work(client);
        });
      };
      const result = await checkout(async (client) => {
        commandPhase('transaction_body');
        if (!dispatch) await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const tx: CommandTransaction = { query: client.query.bind(client) };
        if (publisher) {
          const query = tx.query;
          tx.query = new Proxy(query, {
            apply(target, receiver, args) {
              return publisher.query(() => Reflect.apply(target, receiver, args));
            },
          });
        }
        dispatch?.bindQuery(tx, client);
        if (receiptKeys) bindReceiptKeys(tx, receiptKeys);
        const callbackState: CallbackState = { active: true, callbacks: [] };
        Object.defineProperty(tx, transactionCallbacks, { value: callbackState });
        if (dispatch) selectedCallbacks.set(callbackState, { tx, dispatch });
        try {
          dispatch?.checkpoint();
          if (dispatch) await dispatch.control('begin', () => client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'));
          else await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          if (dispatch) await dispatch.control('lockTimeout', () => client.query("SET LOCAL lock_timeout = '200ms'"));
          else await client.query("SET LOCAL lock_timeout = '200ms'");
          if (dispatch)
            await dispatch.control('statementTimeout', () =>
              client.query(`SET LOCAL statement_timeout = '${remaining(deadline)}ms'`),
            );
          else await client.query(`SET LOCAL statement_timeout = '${remaining(deadline)}ms'`);
          time ??= await measureCommandPhase('time_mint', () => mintTime(client, options.clock, dispatch));
          attempt ??= Object.freeze({ partition, basis, time, ...(commandWork ? { commandWork } : {}) });
          attemptDeadlines.set(attempt, deadline);
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
          const transactionId = Bun.randomUUIDv7();
          commands.set(tx, Object.freeze({ ...attempt, transactionId, authorization: capability }));
          commandResources.set(tx, Object.freeze({ pool, deadline }));
          if (capability && mode === 'execute' && options.principal)
            receiptOwners.set(
              tx,
              Object.freeze({ principal: options.principal, partition, deadline, receiptKeys: receiptKeys! }),
            );
          const receiptInput = options.receipt;
          if (receiptInput && receiptDigest) {
            const row = await readReceipt.run(client, {
              partition_no: partition,
              principal_kind: receiptInput.principal.kind,
              principal_id: receiptInput.principal.id,
              command_kind: receiptInput.kind,
              idempotency_keys: receiptCandidates,
            });
            if (row) {
              if (!Buffer.from(row.requestDigest).equals(receiptDigest)) throw new IdempotencyConflictError(partition);
              if (row.payloadState === 'minimized') throw new CommandResultErasedError();
              receiptOwners.delete(tx);
              await measureCommandPhase('commit', () => client.query('COMMIT'));
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
          if (publisher) {
            const replay = await publisher.lookup(client);
            if (replay) {
              publisher.assertLive();
              await client.query('COMMIT');
              return replay as CommandOutcome<T>;
            }
          }
          if (receiptInput)
            nativeReceipts.set(
              tx,
              Object.freeze({
                principal: Object.freeze({ ...receiptInput.principal }),
                kind: receiptInput.kind,
                key: receiptInput.key,
                storageKey: receiptCandidates.find((key) => key.startsWith(`rk1.${receiptKeys!.current}.`))!,
              }),
            );
          const rawResponse = dispatch
            ? await dispatch.body(() => body(tx, { transactionId, time: time! }))
            : publisher
              ? await publisher.body(() => body(tx, { transactionId, time: time! }))
              : await body(tx, { transactionId, time });
          const response = dispatch ? dispatch.response(rawResponse, noEffectResults.has(rawResponse)) : rawResponse;
          const noEffect = response.events.length === 0 && noEffectResults.has(response);
          if (publisher && (noEffect || response.events.length))
            throw new TypeError('Publisher coordination changes require an eventless coordination fence');
          if (response.events.length === 0 && !noEffect && !publisher)
            throw new TypeError('A command must emit at least one event');
          if (response.events.length > MAX_COMMAND_EVENTS)
            throw new TooManyEventsError(partition, response.events.length);
          if (dispatch || publisher) {
            dispatch?.checkpoint();
            if (
              (dispatch && !noEffect && !dispatch.admitsEvents()) ||
              callbackState.callbacks.length ||
              commandRecordSources(tx).length ||
              hasCommandRecordSourceSet(tx) ||
              commandAgentIdentitySource(tx)
            )
              throw new TypeError('Unsupported dispatch lifetime history, callback or event profile');
          }
          validateCommandHistoryScope(tx, options.receipt?.kind, response.events);
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
          validateCommandHistory(tx, options.receipt?.kind, response.value, events);
          await authorization?.finalize?.(tx, attempt, evidence);
          dispatch?.checkpoint();
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
              key: currentCommandReceipt(tx).storageKey,
              digest: receiptDigest.toString('base64'),
              response: response.value,
            });
            if (serialized === undefined) throw new TypeError('A command receipt value must be JSON serializable');
            receipt = JSON.parse(serialized) as Record<string, unknown>;
            if (!Object.hasOwn(receipt, 'response'))
              throw new TypeError('A command receipt value must be JSON serializable');
            value = receipt.response as T;
          }
          if (dispatch)
            await dispatch.control('finalStatementTimeout', () =>
              client.query(`SET LOCAL statement_timeout = '${remaining(deadline)}ms'`),
            );
          else await client.query(`SET LOCAL statement_timeout = '${remaining(deadline)}ms'`);
          const noEffectFence = () =>
            noEffectFenceStatement.run(client, {
              partition_no: partition,
              transaction_id: transactionId,
              receipt,
            });
          const eventFence = () =>
            fenceStatement.run(client, {
              partition_no: partition,
              events,
              transaction_id: transactionId,
              basis: basis
                ? { principal: options.principal, clientId: basis.clientId, requestedBy: basis.requestedBy }
                : null,
              receipt,
            });
          const row = noEffect
            ? await (dispatch ? dispatch.control('noEffectFence', noEffectFence) : noEffectFence())
            : await (dispatch ? dispatch.control('eventFence', eventFence) : eventFence());
          if (row.length === 0) {
            if (dispatch || singleAttempt.getStore()) throw new CommandUnavailableError('contention', partition);
            receiptOwners.delete(tx);
            try {
              await client.query('ROLLBACK');
            } catch (rollbackError) {
              discardConnection(client, rollbackError as Error);
              throw rollbackError;
            }
            attempts.delete(tx);
            commands.delete(tx);
            commandResources.delete(tx);
            times.delete(time);
            const state = await boundedRead(client, deadline, () => readPartition(client, partition));
            if (state?.writeState === 'moved') throw new CommandUnavailableError('moved', partition, state.movedTo);
            if (state?.writeState === 'fenced' || state?.writeState === 'active') {
              return null;
            }
            throw new CommandUnavailableError('deadline', partition);
          }
          receiptOwners.delete(tx);
          if (options.receipt && receipt)
            await recordCommandHistory(tx, {
              principal: options.receipt.principal,
              kind: options.receipt.kind,
              storageKey: receipt.key as string,
              position: BigInt(row[0]!.position),
            });
          if (dispatch)
            await dispatch.control('finalize', () => finalizeCommandRecordSources(tx, BigInt(row[0]!.position)));
          else await finalizeCommandRecordSources(tx, BigInt(row[0]!.position));
          if (publisher) {
            await publisher.store(client, {
              epoch: row[0]!.epoch, position: row[0]!.position, transactionId,
            }, value);
            publisher.assertLive();
          }
          await measureCommandPhase('commit', () =>
            dispatch ? dispatch.control('commit', () => client.query('COMMIT')) : client.query('COMMIT'),
          );
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
          if (dispatch) {
            try {
              await dispatch.rollback();
            } catch (rollbackError) {
              discardConnection(client, rollbackError as Error);
              throw new AggregateError([error, rollbackError], 'Command and cleanup ROLLBACK failed', { cause: error });
            }
            throw error;
          }
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
          releaseCommandHistory(tx);
          nativeReceipts.delete(tx);
          receiptOwners.delete(tx);
          callbackState.active = false;
          callbackState.callbacks.length = 0;
          attempts.delete(tx);
          commands.delete(tx);
          commandResources.delete(tx);
          if (time) times.delete(time);
        }
      }).finally(() => {
        gate.release();
        commandPhase('command_overhead');
      });
      if (result) return result;
      // Do not keep a failed attempt's T/capability alive during operational waits.
      if (time) times.delete(time);
      await measureCommandPhase('writable_wait', () => waitForWritable(pool, partition, deadline));
    } catch (error) {
      if (time) times.delete(time);
      if (dispatch) {
        // Preserve native single-attempt classifications without retrying or
        // dropping the original failure/uncertain COMMIT evidence.
        if (error instanceof CommandUnavailableError || error instanceof AggregateError) throw error;
        const reason = classifyUnavailability(error);
        if (error instanceof AccessUnavailableError && reason !== 'contention') throw error;
        if (reason) {
          const unavailable = new CommandUnavailableError(reason, partition);
          unavailable.cause = error;
          throw unavailable;
        }
        throw error;
      }
      if (error instanceof IdempotencyConflictError) throw error;
      if (error instanceof CommandUnavailableError) throw error;
      const reason = classifyUnavailability(error);
      lastAccessContention = error instanceof AccessUnavailableError && reason === 'contention' ? error : undefined;
      if (error instanceof AccessUnavailableError && reason !== 'contention') throw error;
      if (reason === 'deadline') throw new CommandUnavailableError('deadline', partition);
      if (reason === 'contention') {
        if (singleAttempt.getStore()) throw new CommandUnavailableError('contention', partition);
        if (Date.now() >= deadline) {
          if (error instanceof AccessUnavailableError) throw error;
          throw new CommandUnavailableError('contention', partition);
        }
        const maximum = Math.min(100, 5 * 2 ** contentionAttempts++);
        countContentionRetry();
        await measureCommandPhase('contention_pause', () =>
          pause(Math.min(Math.random() * maximum, Math.max(0, deadline - Date.now()))),
        );
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
