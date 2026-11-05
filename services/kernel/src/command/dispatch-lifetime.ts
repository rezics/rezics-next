import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import type { WorkDimensions } from '../library/collection-source.ts';
import {
  SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE,
  assertSourceFenceAccount,
  assertSourceFenceOptions,
  sourceFenceResponse,
  type SourceFenceCommandDispatchOwner,
} from './dispatch-lifetime-source-fence.ts';
export {
  SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE,
  SOURCE_FENCE_COMMAND_DISPATCH_CONTROLS,
  SOURCE_FENCE_BINDING_BYTES,
} from './dispatch-lifetime-source-fence.ts';
export type {
  SourceFenceCommandDispatchOwner,
  SourceFenceCommandDispatchAllowance,
} from './dispatch-lifetime-source-fence.ts';
import type { CommandResult, CommandTransaction } from './command.ts';

export type CommandDispatchPrice = Readonly<{ work: WorkDimensions; engineRequests: 0 }>;
const price = (
  nativeRows: number,
  nativePoints: number,
  statements: number,
  bytes: number,
  emptySeeks = 0,
): CommandDispatchPrice =>
  Object.freeze({
    work: Object.freeze({
      candidateKeys: 0,
      nativeRows,
      identityMetadataRows: 0,
      nativePoints,
      witnessKeys: 0,
      statements,
      bytes,
      emptySeeks,
    }),
    engineRequests: 0,
  });

/** Prices only. No entry issues a grant, authorizes SQL, or prices a foreign child. */
export const COMMAND_DISPATCH_CONTROLS = Object.freeze({
  checkout: price(0, 0, 0, 0),
  begin: price(0, 0, 1, 0),
  lockTimeout: price(0, 0, 1, 0),
  statementTimeout: price(0, 0, 1, 12),
  time: price(1, 0, 1, 40),
  finalStatementTimeout: price(0, 0, 1, 12),
  noEffectFence: price(1, 1, 1, 105, 1),
  finalize: price(0, 0, 0, 0),
  commit: price(0, 0, 1, 0),
  cleanupRollback: price(0, 0, 1, 0),
});
export type CommandDispatchControl = keyof typeof COMMAND_DISPATCH_CONTROLS;
const effectOrder = Object.freeze([
  'checkout',
  'begin',
  'lockTimeout',
  'statementTimeout',
  'time',
  'finalStatementTimeout',
  'noEffectFence',
  'finalize',
  'commit',
] as const);
const sum = (parts: readonly CommandDispatchPrice[]): CommandDispatchPrice => {
  const work = {
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
    emptySeeks: 0,
  };
  for (const part of parts)
    for (const axis of Object.keys(work) as (keyof WorkDimensions)[]) work[axis] += part.work[axis];
  return Object.freeze({ work: Object.freeze(work), engineRequests: 0 });
};
export const COMMAND_DISPATCH_ALLOWANCE = Object.freeze({
  profile: 'single-no-effect' as const,
  effect: sum(effectOrder.map((name) => COMMAND_DISPATCH_CONTROLS[name])),
  cleanup: COMMAND_DISPATCH_CONTROLS.cleanupRollback,
  total: sum(Object.values(COMMAND_DISPATCH_CONTROLS)),
  components: COMMAND_DISPATCH_CONTROLS,
});
export type CommandDispatchAllowance = typeof COMMAND_DISPATCH_ALLOWANCE;

/** Trusted server closures over the genuine selected original and its callback.
 * validate is synchronous and must check that original's live callback, immutable Pool/deadline and
 * revocation state. reserve must atomically hold BOTH allowances from that same
 * original before returning, or throw. Neither closure is request data or authority
 * supplied by Core. Held work is never refunded, including on failed dispatch.
 */
export type CommandDispatchOwner = Readonly<{
  original: object;
  validate(): void;
  reserve(allowance: CommandDispatchAllowance): void | Promise<void>;
}>;

export class CommandDispatchLifetimeError extends Error {
  constructor(detail: string) {
    super(`Command dispatch lifetime: ${detail}`);
    this.name = 'CommandDispatchLifetimeError';
  }
}
function fail(detail: string): never {
  throw new CommandDispatchLifetimeError(detail);
}
type Scope = {
  pool: Pool;
  deadline: number;
  open: boolean;
  claimed: boolean;
  running: boolean;
  succeeded: boolean;
  validate: CommandDispatchOwner['validate'];
  reserve(): void | Promise<void>;
  accountId: string | undefined;
  done: Promise<void>;
  finish(): void;
  unchanged(): boolean;
};
const scopes = new AsyncLocalStorage<Scope>();
const activeOriginals = new WeakSet<object>();
function assertScopeLive(scope: Scope): void {
  if (!scope.open || !scope.unchanged() || scopes.getStore() !== scope || Date.now() >= scope.deadline)
    fail('closed, escaped or expired callback');
}
function validateScope(scope: Scope): void {
  assertScopeLive(scope);
  // A synchronous original guard leaves no await gap before the next dispatch.
  const result: unknown = scope.validate();
  if (result !== undefined) {
    if (result instanceof Promise) void result.catch(() => {});
    fail('validator must be synchronous and return void');
  }
  assertScopeLive(scope);
}

/** Exactly one authentic runCommand per callback. Sequential fresh callbacks on
 * the same original require fresh owner validation/reservation; overlapping or
 * nested scopes and concurrent/repeated commands are refused. */
export async function withCommandDispatchLifetime<T>(
  pool: Pool,
  deadline: number,
  owner: CommandDispatchOwner,
  body: () => Promise<T>,
): Promise<T> {
  return withDispatchScope(pool, deadline, owner, () => owner.reserve(COMMAND_DISPATCH_ALLOWANCE), undefined, body);
}

/** Additive exact Source exhausted native-fence profile; preserves the callback's normal result ABI. */
export async function withSourceFenceCommandDispatchLifetime<T>(
  pool: Pool,
  deadline: number,
  owner: SourceFenceCommandDispatchOwner,
  accountId: string,
  body: () => Promise<T>,
): Promise<T> {
  assertSourceFenceAccount(accountId);
  return withDispatchScope(
    pool,
    deadline,
    owner,
    () => owner.reserve(SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE),
    accountId,
    body,
  );
}

async function withDispatchScope<T>(
  pool: Pool,
  deadline: number,
  owner: CommandDispatchOwner | SourceFenceCommandDispatchOwner,
  reserve: () => void | Promise<void>,
  accountId: string | undefined,
  body: () => Promise<T>,
): Promise<T> {
  if (scopes.getStore() || !owner.original || typeof owner.original !== 'object' || activeOriginals.has(owner.original))
    fail('nested or overlapping original');
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline - Date.now() > 2_147_483_647)
    fail('invalid immutable deadline');
  const original = owner.original;
  const originalValidate = owner.validate;
  const originalReserve = owner.reserve;
  const validate = originalValidate.bind(owner);
  let finish!: () => void;
  const scope: Scope = {
    pool,
    deadline,
    open: true,
    claimed: false,
    running: false,
    succeeded: false,
    validate,
    reserve,
    accountId,
    done: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    finish: () => finish(),
    unchanged: () =>
      owner.original === original && owner.validate === originalValidate && owner.reserve === originalReserve,
  };
  activeOriginals.add(original);
  try {
    return await scopes.run(scope, async () => {
      try {
        const answer = await body();
        if (!scope.claimed || scope.running || !scope.succeeded)
          fail('callback returned without a successful settled command');
        validateScope(scope);
        return answer;
      } finally {
        scope.open = false;
        // A descendant cannot keep effect authority after its callback returns.
        // Wait for its existing cleanup/release, without starting another command.
        if (scope.running) await scope.done;
      }
    });
  } finally {
    scope.open = false;
    activeOriginals.delete(original);
  }
}

/** Executor-only lifecycle plumbing. No native transaction is constructed here. */
export function claimCommandDispatchLifetime(
  pool: Pool,
  options: {
    deadline?: number;
    basis?: unknown;
    principal?: unknown;
    receipt?: unknown;
    authorization?: unknown;
    clock?: unknown;
  },
): CommandDispatchLifetime | undefined {
  const scope = scopes.getStore();
  if (!scope) return undefined;
  if (scope.accountId !== undefined) assertSourceFenceOptions(options);
  if (!scope.open || !scope.unchanged() || scope.claimed || scope.pool !== pool || options.deadline !== scope.deadline)
    fail('foreign, changed, closed or reused invocation');
  if (
    options.basis !== undefined ||
    options.principal !== undefined ||
    options.receipt !== undefined ||
    options.authorization !== undefined ||
    options.clock !== undefined
  )
    fail('unsupported selected command profile');
  scope.claimed = true;
  scope.running = true;
  return new CommandDispatchLifetime(scope);
}

export type { CommandDispatchLifetime };
class CommandDispatchLifetime {
  #scope: Scope;
  #reserved = false;
  #closed = false;
  #next = 0;
  #begun = false;
  #cleanup = false;
  #body = false;
  #query = false;
  #response = false;
  #event = false;
  #client: PoolClient | undefined;
  #tx: CommandTransaction | undefined;
  constructor(scope: Scope) {
    this.#scope = scope;
  }
  assertLive(): void {
    if (this.#closed) fail('closed command');
    assertScopeLive(this.#scope);
  }
  checkpoint(): void {
    this.assertLive();
    validateScope(this.#scope);
    this.assertLive();
  }

  assertOptions(pool: Pool, options: Parameters<typeof claimCommandDispatchLifetime>[1]): void {
    this.checkpoint();
    if (this.#scope.accountId !== undefined) assertSourceFenceOptions(options);
    if (
      pool !== this.#scope.pool ||
      options.deadline !== this.#scope.deadline ||
      options.basis !== undefined ||
      options.principal !== undefined ||
      options.receipt !== undefined ||
      options.authorization !== undefined ||
      options.clock !== undefined
    )
      fail('changed selected command profile');
  }
  async prepare(): Promise<void> {
    this.checkpoint();
    await this.#scope.reserve();
    this.checkpoint();
    this.#reserved = true;
  }
  checkout(): void {
    this.checkpoint();
    if (!this.#reserved || this.#next !== 0 || this.#client) fail('repeated or unreserved checkout');
    this.#next++;
  }
  async control<T>(name: CommandDispatchControl | 'eventFence', dispatch: () => Promise<T>): Promise<T> {
    this.checkpoint();
    // Closed identity and exact reached repetition, never SQL/prefix recognition.
    const expected = this.#event && this.#next === 6 ? 'eventFence' : effectOrder[this.#next];
    if (!this.#reserved || name !== expected || (name !== 'checkout' && !this.#client))
      fail('unknown, unbound or repeated control');
    this.#next++;
    if (name === 'begin') this.#begun = true;
    const result = await dispatch();
    this.checkpoint();
    return result;
  }
  response<T>(response: CommandResult<T>, authenticNoEffect: boolean): CommandResult<T> {
    this.checkpoint();
    if (this.#response || this.#next !== 5) fail('repeated or out-of-order response');
    this.#response = true;
    if (this.#scope.accountId === undefined) return response;
    const selected = sourceFenceResponse(response, authenticNoEffect, this.#scope.accountId);
    this.#event = !authenticNoEffect;
    return selected;
  }
  admitsEvents(): boolean {
    return this.#scope.accountId !== undefined;
  }
  async body<T>(run: () => Promise<T>): Promise<T> {
    this.checkpoint();
    this.#body = true;
    try {
      const answer = await run();
      this.checkpoint();
      if (this.#query) fail('unsettled body query');
      return answer;
    } finally {
      this.#body = false;
    }
  }
  bindQuery(tx: CommandTransaction, client: PoolClient): void {
    this.checkpoint();
    if (this.#client || this.#tx || this.#next !== 1) fail('repeated or foreign native binding');
    this.#client = client;
    this.#tx = tx;
    const original = tx.query;
    const lifetime = this;
    tx.query = async function (this: CommandTransaction, ...args: unknown[]) {
      lifetime.assertLive();
      if (this !== lifetime.#tx || !lifetime.#body || lifetime.#query || args.some((arg) => typeof arg === 'function'))
        fail('foreign, concurrent or unsupported body query');
      // pg's callback and Query/stream overloads can settle before native IO.
      // Only its Promise string/plain-config forms belong to this finite profile.
      if (args.length < 1 || args.length > 2 || (args[1] !== undefined && !Array.isArray(args[1])))
        fail('unsupported body query arguments');
      const config = args[0];
      if (typeof config !== 'string') {
        if (
          !config ||
          typeof config !== 'object' ||
          (Object.getPrototypeOf(config) !== Object.prototype && Object.getPrototypeOf(config) !== null)
        )
          fail('unsupported body query config');
        const fields = Object.getOwnPropertyDescriptors(config);
        if (
          typeof fields.text?.value !== 'string' ||
          Reflect.ownKeys(config).some(
            (key) =>
              typeof key !== 'string' ||
              !['text', 'values', 'name', 'rowMode'].includes(key) ||
              !('value' in fields[key]!),
          )
        )
          fail('unsupported body query config');
      }
      lifetime.#query = true;
      try {
        lifetime.checkpoint();
        const result: unknown = await Reflect.apply(original, tx, args);
        lifetime.checkpoint();
        if (!lifetime.#body) fail('late body query');
        return result;
      } finally {
        lifetime.#query = false;
      }
    } as unknown as CommandTransaction['query'];
  }
  async rollback(): Promise<void> {
    // A disjoint held cleanup slot survives revocation/expiry/scope closure.
    // Mark closed before dispatch; even late body query results cannot revive it.
    this.#closed = true;
    if (!this.#reserved || !this.#begun || !this.#client || this.#cleanup) return;
    this.#cleanup = true;
    await this.#client.query('ROLLBACK');
  }
  finish(succeeded: boolean): void {
    this.#closed = true;
    this.#scope.succeeded = succeeded;
    this.#scope.running = false;
    this.#scope.finish();
  }
}

/** UTC textual time has at most six year digits plus 23 fixed characters.
 * The bounded SQL projection is enforced before IO; no caller clock is supported.
 * PostgreSQL transaction_timestamp is finite. Preserve full microsecond precision. */
export const COMMAND_DISPATCH_TIME_SQL = `SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')::varchar(29) AS at`;
