import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  currentCommand,
  currentCommandResources,
  currentCommandReceipt,
  runCommand,
  withSingleCommandAttempt,
  DEFAULT_REQUEST_DEADLINE_MS,
  type CommandTransaction,
  type CommandBasis,
  type CommandReceipt,
  type CommandAuthorization,
  type CommandOutcome,
  type CommandResult,
} from '../command/command.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { IdentityEpochStoreError } from './identity-adapters/index.ts';
import {
  bindIdentityTerminalMutation,
  cancelUnregisteredIdentityTerminalCapture,
  drainIdentityTerminalClosure,
  releaseIdentityTerminalClaim,
} from './identity-terminal-closure.ts';
import { IdentityTerminalClaimReleaseError } from './identity-terminal-closure-errors.ts';

type Drain = NonNullable<Awaited<ReturnType<typeof drainIdentityTerminalClosure>>>;
type Scope = { pool: Pool; deadline: number; drained: Map<string, Drain> };
const scopes = new AsyncLocalStorage<Scope>();
class NeedsDrain extends Error {
  constructor(
    readonly scope: Scope,
    readonly claim: string,
    readonly terminals: readonly string[],
  ) {
    super('Native directory drain required');
  }
}
const unavailable = () =>
  new IdentityEpochStoreError('identity_epoch_unavailable', 'Native terminal drain is incomplete');

/** Called before the producer's first affected source IO. The source transaction
 * is rolled back and released before any foreign directory command is opened.
 * Receipt replay has already returned in Core before this callback is reached.
 */
export async function admitIdentityTerminalCapture(
  tx: CommandTransaction,
  originals: readonly string[],
): Promise<void> {
  const command = currentCommand(tx);
  const resources = currentCommandResources(tx);
  const local = [...new Set(originals)].filter((id) => {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Capture requires a native original');
    return partitionOf(route) === command.partition;
  });
  if (local.length > 100) throw new RangeError('Capture page exceeds 100');
  if (!local.length) return;
  const rows = (
    await tx.query(
      `SELECT * FROM semantic.identity_epoch_mapping
    WHERE route BETWEEN $1*16 AND $1*16+15 AND original=ANY($2::uuid[]) ORDER BY original FOR UPDATE`,
      [command.partition, local],
    )
  ).rows;
  const scope = scopes.getStore();
  const pending = [];
  for (const row of rows) {
    if (row.closure_state === 'legacy') continue;
    if (
      row.closure_mutation_xid &&
      (await tx.query('SELECT pg_current_xact_id()::text AS xid')).rows[0]?.xid === row.closure_mutation_xid
    )
      continue;
    const drained = scope?.drained.get(row.control_group);
    if (scope?.pool === resources.pool && drained) {
      await bindIdentityTerminalMutation(tx, row.original, drained);
      continue;
    }
    if (!row.control_group) {
      if (await cancelUnregisteredIdentityTerminalCapture(tx, row.original)) continue;
      throw unavailable();
    }
    pending.push(row.control_group);
  }
  if (!pending.length) return;
  if (!scope || scope.pool !== resources.pool) throw unavailable();
  scope.deadline = Math.min(scope.deadline, resources.deadline);
  let identity: unknown = command.transactionId;
  try {
    identity = currentCommandReceipt(tx);
  } catch {
    /* A real receipt-free native command is its own original. */
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([command.partition, identity]))
    .digest('hex');
  const claim = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  throw new NeedsDrain(scope, claim, [...new Set(pending)].sort());
}

/** Two explicit phases: authenticated source discovery, released native drain,
 * then a newly authorized source attempt consuming that exact drain. Contention
 * remains unavailable; this adds no executor retry or module backoff loop.
 */
type PrincipalOptions = Parameters<typeof runCommand>[1];
type LegacyOptions = {
  partition: number;
  deadline?: number;
  basis?: CommandBasis;
  receipt?: CommandReceipt;
  authorization?: CommandAuthorization | undefined;
  clock?: (() => Date) | undefined;
};
type Context = Parameters<Parameters<typeof runCommand>[2]>[1];
type Body<T> = (tx: CommandTransaction, context: Context) => Promise<CommandResult<T>>;
export function runIdentityTerminalCommand<T>(
  pool: Pool,
  options: LegacyOptions,
  body: Body<T>,
): Promise<CommandOutcome<T>>;
export function runIdentityTerminalCommand<T>(
  pool: Pool,
  options: PrincipalOptions,
  body: Body<T>,
): Promise<CommandOutcome<T>>;
export async function runIdentityTerminalCommand<T>(
  pool: Pool,
  options: LegacyOptions | PrincipalOptions,
  body: Body<T>,
): Promise<CommandOutcome<T>> {
  const scope: Scope = {
    pool,
    deadline: options.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS),
    drained: new Map(),
  };
  const attempt = () => {
    return scopes.run(scope, () =>
      withSingleCommandAttempt(() => {
        const selected = { ...options, deadline: scope.deadline };
        return 'principal' in selected ? runCommand(pool, selected, body) : runCommand(pool, selected, body);
      }),
    );
  };
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof NeedsDrain) || error.scope !== scope) throw error;
    let failed = false;
    let primary: unknown;
    try {
      for (const terminal of error.terminals) {
        let drained: Drain | null = null;
        // 4096 directory members, page100: at most41 advancing native pages.
        for (let page = 0; page < 41 && !drained; page++) {
          if (Date.now() >= scope.deadline) throw unavailable();
          drained = await withRequestDeadline(scope.deadline, () =>
            drainIdentityTerminalClosure(pool, terminal, error.claim),
          );
        }
        if (!drained) throw unavailable();
        scope.drained.set(terminal, drained);
      }
      return await attempt();
    } catch (failure) {
      failed = true;
      primary = failure;
      throw failure;
    } finally {
      // This is bounded retained cleanup. If the request deadline has expired,
      // native bootstrap recovery advances the same seal and source claims.
      // The same bounded release phase also covers partial group acquisition.
      // One failed home must not suppress another home's already-owed release.
      const failures: unknown[] = [];
      for (const drained of scope.drained.values()) {
        if (Date.now() >= scope.deadline) break;
        try {
          await withRequestDeadline(scope.deadline, () => releaseIdentityTerminalClaim(pool, drained));
        } catch (failure) {
          failures.push(failure);
        }
      }
      if (failures.length)
        throw new IdentityTerminalClaimReleaseError(
          failed ? [primary, ...failures] : failures,
          failed ? primary : failures[0],
        );
    }
  }
}
