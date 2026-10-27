import { accessClock } from './access-clock.ts';
import { deadlineFor } from '../request/deadline.ts';
import { throwAccessUnavailable } from './unavailable.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  authoritativeTimeValue,
  currentCommand,
  IdempotencyConflictError,
  type CommandTransaction,
} from '../command/command.ts';
import type { Access, AccessContext, AccountActor, ActionCatalogue } from '../request/access.ts';
import { withConnection } from '../database/pool.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { seal, unseal } from '../tokens/seal.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import globalRead from './bootstrap-governance-read.sql';
import { GrantDeniedError } from './grant-commands.ts';
import { LifecycleDeniedError, lifecycleExecutor, type LifecycleReceipt } from './lifecycle-20261025094010-command.ts';
import { resourceAuthorization } from './resource-authorization.ts';
import completeContinuation from './committed-continuation-complete.sql';
import insertContinuation from './committed-continuation-insert.sql';
import loadContinuation from './committed-continuation-load.sql';
import readContinuation from './committed-continuation-read.sql';
import renewContinuation from './committed-continuation-renew.sql';
import readEntry from './committed-continuation-entry-read.sql';
import { createCommittedDeletionRunner } from './committed-deletion-work.ts';
import { createOperatorFenceRunner } from './operator-fence-work.ts';

/** Distinct from workflow approvals. A sealed reference authorizes one allowlisted
 * cleanup step and never a caller's result or a later permission. */
export const COMMITTED_CONTINUATION_PURPOSE = 'access.committed-continuation.v1';
export const COMMITTED_CONTINUATION_TTL_MS = 5 * 60 * 1000;
/** The protected native workflow port gives each resumed step ten seconds. */
export const COMMITTED_CONTINUATION_RESUME_BUDGET_MS = 10_000;
/** Route-bearing continuation ids. Independent of the lifecycle fence namespace. */
export const CONTINUATION_NAMESPACE = 'b7c3d1e2-4f50-4a61-8c70-0d1e2f304152';
export const COMMITTED_CONTINUATION_ACTIONS: ActionCatalogue = new Map([
  ['account:renew_cleanup', { anonymous: false }],
]);
const DIGEST = /^[0-9a-f]{64}$/;
const PREFIX = /^wf:[0-9a-f]{64}$/;
const STEP = /^[a-z][a-z0-9-]{0,63}$/;

export class ContinuationDeniedError extends Error {
  readonly status = 403;

  constructor() {
    super('Committed cleanup continuation denied');
    this.name = 'ContinuationDeniedError';
  }
}

export type ContinuationEntry = { step: string; target: string; key: string; digest: string };
export type ContinuationBinding = {
  operationKey: string;
  operationDigest: string;
  commandKeyPrefix: string;
  approvalExpiresAt?: string;
};
export type ContinuationSnapshot = {
  route: number;
  continuationId: string;
  accountId: string;
  operationKey: string;
  operationDigest: string;
  commandKeyPrefix: string;
  barrierReceiptId: string;
  barrierTransactionId: string;
  minimumAuthnEpoch: string;
  priorHandle: string | null;
  priorOperatorAccountId: string | null;
  priorReservationId: string | null;
  allowlist: ContinuationEntry[];
  createdAt: string;
  committedExpiresAt: string;
};
export type ContinuationView = {
  reference: string;
  operationKey: string;
  operationDigest: string;
  commandKeyPrefix: string;
  barrierReceiptId: string;
  expiresAt: string;
  allowlist: ContinuationEntry[];
};
type StoredContinuation = {
  continuationId: string;
  accountId: string;
  operationKey: string;
  operationDigest: string;
  commandKeyPrefix: string;
  barrierReceiptId: string;
  barrierTransactionId: string;
  minimumAuthnEpoch: string;
  priorHandle: string | null;
  priorOperatorAccountId: string | null;
  priorReservationId: string | null;
  allowlist: unknown;
  derivedAllowlist?: unknown;
  digest: string;
  createdAt: unknown;
  committedExpiresAt: unknown;
  expiresAt: unknown;
};

const deny = () => new ContinuationDeniedError();
function refused(value: unknown): asserts value {
  if (!value) throw deny();
}
function one<T>(result: T | readonly T[] | null | undefined): T | null {
  if (Array.isArray(result)) return (result[0] as T | undefined) ?? null;
  if (result == null) return null;
  return result as T;
}
async function oneRow<T>(work: () => Promise<T | readonly T[] | null>): Promise<T | null> {
  try {
    return one(await work());
  } catch (error) {
    if (error instanceof Error && error.message.includes('Expected exactly one row')) return null;
    throw error;
  }
}
export function canonicalInstant(value: unknown): string {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (!Number.isFinite(parsed.getTime())) throw deny();
  return parsed.toISOString();
}
function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
}
function entryShape(value: unknown): ContinuationEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'digest,key,step,target') return null;
  const { step, target, key, digest } = record;
  if (typeof step !== 'string' || !STEP.test(step)) return null;
  if (typeof target !== 'string' || target.length < 1 || target.length > 128) return null;
  if (typeof key !== 'string' || key.length < 1 || key.length > 240) return null;
  if (typeof digest !== 'string' || !DIGEST.test(digest)) return null;
  return { step, target, key, digest };
}
function entries(value: unknown, minimum = 1, maximum = 4): ContinuationEntry[] | null {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed) || parsed.length < minimum || parsed.length > maximum) return null;
  const allowlist: ContinuationEntry[] = [];
  for (const item of parsed) {
    const entry = entryShape(item);
    if (!entry) return null;
    allowlist.push(entry);
  }
  return allowlist;
}
export function continuationEntryDigest(entry: Pick<ContinuationEntry, 'step' | 'target' | 'key'>): string {
  return createHash('sha256')
    .update(canonicalize({ step: entry.step, target: entry.target, key: entry.key })!)
    .digest('hex');
}
export function committedContinuationDigest(snapshot: ContinuationSnapshot): string {
  return createHash('sha256').update(canonicalize(snapshot)!).digest('hex');
}
function sameEntry(left: ContinuationEntry, right: ContinuationEntry): boolean {
  return (
    left.step === right.step && left.target === right.target && left.key === right.key && left.digest === right.digest
  );
}
export function deletionAllowlist(input: {
  accountId: string;
  commandKeyPrefix: string;
  handle: string | null;
  operatorAccountId: string | null;
  reservationId: string | null;
}): ContinuationEntry[] | null {
  if (!PREFIX.test(input.commandKeyPrefix) || routeOf(input.accountId) === null) return null;
  const operator = input.operatorAccountId;
  const reservation = input.reservationId;
  if ((operator === null) !== (reservation === null)) return null;
  if (operator !== null && reservation !== null && (routeOf(operator) === null || routeOf(reservation) === null))
    return null;
  if (input.handle !== null && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.handle)) return null;
  const allowlist: ContinuationEntry[] = [];
  const push = (step: string, target: string) => {
    const key = `${input.commandKeyPrefix}:${step}`;
    if (key.length > 240 || target.length < 1 || target.length > 128) return false;
    allowlist.push({ step, target, key, digest: continuationEntryDigest({ step, target, key }) });
    return true;
  };
  if (!push('erase-auth-owner', input.accountId)) return null;
  if (operator && reservation) {
    if (!push('retire-operator', `${input.accountId}:${reservation}`)) return null;
    if (!push('release-operator', `${operator}:${reservation}`)) return null;
  }
  if (input.handle && !push('redirect-deleted-handle', input.handle)) return null;
  return allowlist.length >= 1 && allowlist.length <= 4 ? allowlist : null;
}
export function validateContinuationBinding(binding: ContinuationBinding): void {
  if (
    !binding ||
    typeof binding.operationKey !== 'string' ||
    binding.operationKey.length < 1 ||
    binding.operationKey.length > 128 ||
    !DIGEST.test(binding.operationDigest) ||
    !PREFIX.test(binding.commandKeyPrefix)
  )
    throw new LifecycleDeniedError();
}
/** Approval lifetime is admission metadata, not part of the replayed business command. */
export function continuationCommandBinding(binding: ContinuationBinding | undefined) {
  return binding
    ? {
        operationKey: binding.operationKey,
        operationDigest: binding.operationDigest,
        commandKeyPrefix: binding.commandKeyPrefix,
      }
    : null;
}
function snapshotOf(route: number, row: StoredContinuation, allowlist: ContinuationEntry[]): ContinuationSnapshot {
  return {
    route,
    continuationId: row.continuationId,
    accountId: row.accountId,
    operationKey: row.operationKey,
    operationDigest: row.operationDigest,
    commandKeyPrefix: row.commandKeyPrefix,
    barrierReceiptId: row.barrierReceiptId,
    barrierTransactionId: row.barrierTransactionId,
    minimumAuthnEpoch: row.minimumAuthnEpoch,
    priorHandle: row.priorHandle,
    priorOperatorAccountId: row.priorOperatorAccountId,
    priorReservationId: row.priorReservationId,
    allowlist,
    createdAt: canonicalInstant(row.createdAt),
    committedExpiresAt: canonicalInstant(row.committedExpiresAt),
  };
}
function viewOf(keys: KeyRing, route: number, row: StoredContinuation): ContinuationView | null {
  const allowlist = entries(row.allowlist);
  if (!allowlist || row.digest !== committedContinuationDigest(snapshotOf(route, row, allowlist))) return null;
  const derived = entries(row.derivedAllowlist ?? [], 0, Infinity);
  if (!derived) return null;
  return {
    reference: seal(keys, COMMITTED_CONTINUATION_PURPOSE, {
      route,
      continuationId: row.continuationId,
      digest: row.digest,
    }),
    operationKey: row.operationKey,
    operationDigest: row.operationDigest,
    commandKeyPrefix: row.commandKeyPrefix,
    barrierReceiptId: row.barrierReceiptId,
    expiresAt: canonicalInstant(row.expiresAt),
    allowlist: [...allowlist, ...derived],
  };
}

/** The row commits in the tombstone transaction. Its sealed reference is derived
 * later from the immutable digest; renewal changes only the live expiry. */
export async function insertDeletionContinuation(
  tx: CommandTransaction,
  input: {
    accountId: string;
    handle: string | null;
    operatorAccountId: string | null;
    reservationId: string | null;
    binding: ContinuationBinding;
    barrierReceiptId: string;
    minimumAuthnEpoch: string;
    transactionId: string;
    allowlist?: ContinuationEntry[];
  },
): Promise<void> {
  validateContinuationBinding(input.binding);
  const route = routeOf(input.accountId);
  const allowlist =
    input.allowlist ??
    deletionAllowlist({
      accountId: input.accountId,
      commandKeyPrefix: input.binding.commandKeyPrefix,
      handle: input.handle,
      operatorAccountId: input.operatorAccountId,
      reservationId: input.reservationId,
    });
  if (route === null || !allowlist || routeOf(input.barrierReceiptId) === null) throw new LifecycleDeniedError();
  const createdAt = canonicalInstant(authoritativeTimeValue(currentCommand(tx).time));
  const expires = Math.min(
    Date.parse(createdAt) + COMMITTED_CONTINUATION_TTL_MS,
    input.binding.approvalExpiresAt === undefined
      ? Infinity
      : Date.parse(input.binding.approvalExpiresAt) - COMMITTED_CONTINUATION_RESUME_BUDGET_MS,
  );
  if (!Number.isFinite(expires) || expires <= Date.parse(createdAt)) throw new LifecycleDeniedError();
  const committedExpiresAt = new Date(expires).toISOString();
  const continuationId = derivedId(CONTINUATION_NAMESPACE, `${input.accountId}:${input.binding.operationKey}`, route);
  const snapshot: ContinuationSnapshot = {
    route,
    continuationId,
    accountId: input.accountId,
    operationKey: input.binding.operationKey,
    operationDigest: input.binding.operationDigest,
    commandKeyPrefix: input.binding.commandKeyPrefix,
    barrierReceiptId: input.barrierReceiptId,
    barrierTransactionId: input.transactionId,
    minimumAuthnEpoch: input.minimumAuthnEpoch,
    priorHandle: input.handle,
    priorOperatorAccountId: input.operatorAccountId,
    priorReservationId: input.reservationId,
    allowlist,
    createdAt,
    committedExpiresAt,
  };
  const inserted = await oneRow(() =>
    insertContinuation.run(tx, {
      route,
      continuation_id: continuationId,
      account_id: input.accountId,
      operation_key: input.binding.operationKey,
      operation_digest: input.binding.operationDigest,
      command_key_prefix: input.binding.commandKeyPrefix,
      barrier_receipt_id: input.barrierReceiptId,
      barrier_transaction_id: input.transactionId,
      minimum_authn_epoch: input.minimumAuthnEpoch,
      prior_handle: input.handle ?? '',
      prior_operator_account_id: input.operatorAccountId ?? '',
      prior_reservation_id: input.reservationId ?? '',
      allowlist,
      digest: committedContinuationDigest(snapshot),
      created_at: createdAt,
      committed_expires_at: committedExpiresAt,
      expires_at: committedExpiresAt,
    }),
  );
  if (!inserted) throw new LifecycleDeniedError();
}

export function isFenceContinuation(root: ContinuationSnapshot): boolean {
  return root.allowlist.some(
    (entry) =>
      ['operator-responsibility-page', 'operator-unfence-page'].includes(entry.step) && entry.target === root.accountId,
  );
}
export function isDeletionContinuation(root: ContinuationSnapshot): boolean {
  return root.allowlist.some((entry) => entry.step === 'erase-auth-owner' && entry.target === root.accountId);
}

/** Every effect checks an exact root entry and the stored expiry at its command's T.
 * The completion and the business receipt commit together; receipt replay writes neither twice. */
export async function recordCompletion(
  tx: CommandTransaction,
  located: { route: number; continuationId: string; digest: string },
  presented: ContinuationEntry,
  receiptId: string,
  receipt: LifecycleReceipt,
): Promise<{ continuationId: string; receiptId: string }> {
  refused(presented.digest === continuationEntryDigest(presented));
  const row = await oneRow(() =>
    loadContinuation.run(tx, { route: located.route, continuation_id: located.continuationId }),
  );
  refused(row);
  const stored = row as StoredContinuation;
  const allowlist = entries(stored.allowlist);
  refused(allowlist);
  const snapshot = snapshotOf(located.route, stored, allowlist);
  refused(stored.digest === located.digest && stored.digest === committedContinuationDigest(snapshot));
  refused(
    allowlist.some((item) => sameEntry(item, presented)) ||
      (await readEntry.run(tx, {
        route: located.route,
        continuation_id: stored.continuationId,
        ...presented,
      })),
  );
  const at = canonicalInstant(authoritativeTimeValue(currentCommand(tx).time));
  refused(Date.parse(canonicalInstant(stored.expiresAt)) > Date.parse(at));
  await completeContinuation.run(tx, {
    route: located.route,
    continuation_id: stored.continuationId,
    step: presented.step,
    target: presented.target,
    key: presented.key,
    digest: presented.digest,
    receipt_id: receiptId,
    receipt_key: receipt.key,
    receipt_digest: receipt.digest,
  });
  return { continuationId: stored.continuationId, receiptId };
}

export type CommittedContinuations = {
  /** Trusted kernel recovery port. Each iteration commits one bounded page. */
  continueCommitted(reference: string): Promise<void>;
  continueCommittedPage(
    reference: string,
    cursor?: string,
    previous?: string,
  ): Promise<{ next: string | null; pageKey: string }>;

  read(operationKey: string, accountId: string): Promise<ContinuationView | null>;
  authorizeStep(reference: string, entry: ContinuationEntry): Promise<{ continuationId: string; receiptId: string }>;
  renew(
    token: string,
    continuationId: string,
  ): Promise<{ continuationId: string; expiresAt: string; receiptId: string }>;
};

/** Trusted server port. Callers pass a sealed reference, never request JSON. */
export function createCommittedContinuations(config: {
  pool: Pool;
  access: Access;
  referenceKeys: KeyRing;
  clock?: () => Date;
  pageSize?: number;
}): CommittedContinuations {
  const clock = config.clock ?? accessClock(config.access);
  const execute = (frozenClock?: () => Date) => lifecycleExecutor(config.pool, frozenClock ?? clock);
  function unsealed(reference: string): { route: number; continuationId: string; digest: string } {
    const payload = unseal(config.referenceKeys, COMMITTED_CONTINUATION_PURPOSE, reference);
    refused(payload && typeof payload === 'object' && !Array.isArray(payload));
    const record = payload as Record<string, unknown>;
    refused(Object.keys(record).sort().join(',') === 'continuationId,digest,route');
    const { route, continuationId, digest } = record;
    refused(
      typeof route === 'number' &&
        Number.isInteger(route) &&
        typeof continuationId === 'string' &&
        routeOf(continuationId) === route &&
        typeof digest === 'string' &&
        DIGEST.test(digest),
    );
    return { route, continuationId, digest };
  }
  async function loadRoot(reference: string): Promise<ContinuationSnapshot> {
    const located = unsealed(reference);
    const row = await withConnection(config.pool, (client) =>
      oneRow(() =>
        loadContinuation.run(client, {
          route: located.route,
          continuation_id: located.continuationId,
        }),
      ),
    );
    refused(row);
    const stored = row as StoredContinuation;
    const allowlist = entries(stored.allowlist);
    refused(allowlist);
    const snapshot = snapshotOf(located.route, stored, allowlist);
    refused(stored.digest === located.digest && stored.digest === committedContinuationDigest(snapshot));
    refused(Date.parse(canonicalInstant(stored.expiresAt)) > clock().getTime());
    return snapshot;
  }
  async function authorizeStep(reference: string, entry: ContinuationEntry) {
    let sealedReference: { route: number; continuationId: string; digest: string };
    try {
      sealedReference = unsealed(reference);
    } catch (error) {
      if (error instanceof ContinuationDeniedError) throw error;
      throw deny();
    }
    const presented = entryShape(entry);
    refused(presented && presented.digest === continuationEntryDigest(presented));
    const commandKey = `committed:${presented.key}`;
    refused(commandKey.length <= 240);
    // Core receipt replay skips the body, so expiry also guards admission to replay.
    await loadRoot(reference);
    try {
      const outcome = await execute()(
        {
          route: sealedReference.route,
          id: sealedReference.continuationId,
          kind: 'cleanup-continuation.recorded',
          key: commandKey,
          input: {
            continuationId: sealedReference.continuationId,
            step: presented.step,
            target: presented.target,
            key: presented.key,
            digest: presented.digest,
          },
        },
        (tx, transactionId, receipt) => recordCompletion(tx, sealedReference, presented, transactionId, receipt),
      );
      return outcome.value;
    } catch (error) {
      if (error instanceof ContinuationDeniedError) throw error;
      if (error instanceof IdempotencyConflictError) throw deny();
      throw error;
    }
  }
  const fenceWork = createOperatorFenceRunner({
    pool: config.pool,
    referenceKeys: config.referenceKeys,
    clock,
    ...(config.pageSize === undefined ? {} : { pageSize: config.pageSize }),
    async root(reference) {
      const snapshot = await loadRoot(reference);
      refused(isFenceContinuation(snapshot));
      return snapshot;
    },
    async record(tx, root, entry, receiptId, receipt) {
      await recordCompletion(
        tx,
        { route: root.route, continuationId: root.continuationId, digest: committedContinuationDigest(root) },
        entry,
        receiptId,
        receipt,
      );
    },
  });
  const deletionWork = createCommittedDeletionRunner({
    pool: config.pool,
    clock,
    async root(reference) {
      const snapshot = await loadRoot(reference);
      refused(isDeletionContinuation(snapshot));
      return snapshot;
    },
    authorizeStep,
    async live(root) {
      const row = await withConnection(config.pool, (client) =>
        oneRow(() => loadContinuation.run(client, { route: root.route, continuation_id: root.continuationId })),
      );
      refused(row && Date.parse(canonicalInstant((row as StoredContinuation).expiresAt)) > clock().getTime());
    },
  });
  return {
    async continueCommitted(reference) {
      const root = await loadRoot(reference);
      if (isFenceContinuation(root)) return fenceWork.continueCommitted(reference);
      refused(isDeletionContinuation(root));
      return deletionWork.continueCommitted(reference);
    },
    continueCommittedPage: fenceWork.page,
    async read(operationKey, accountId) {
      const route = routeOf(accountId);
      if (route === null || typeof operationKey !== 'string' || operationKey.length < 1 || operationKey.length > 128)
        return null;
      const row = await withConnection(config.pool, async (client) => {
        await client.query('BEGIN READ ONLY');
        try {
          const result = await oneRow(() => readContinuation.run(client, { route, operation_key: operationKey }));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
      return row ? viewOf(config.referenceKeys, route, row as StoredContinuation) : null;
    },
    authorizeStep,
    async renew(token, continuationId) {
      const route = routeOf(continuationId);
      if (route === null) throw new GrantDeniedError();
      const at = clock();
      if (!Number.isFinite(at.getTime())) throw new GrantDeniedError();
      const frozen = () => new Date(at.getTime());
      const deadline = deadlineFor(COMMITTED_CONTINUATION_RESUME_BUDGET_MS);
      const context: AccessContext = { pool: config.pool, deadline };
      let actor: AccountActor;
      try {
        actor = await config.access.authenticate(token, context);
      } catch (error) {
        throwAccessUnavailable(error, context.deadline);
        throw new GrantDeniedError();
      }
      const authorization = resourceAuthorization({
        access: config.access,
        actor,
        action: 'account:renew_cleanup',
        anchor: {
          resource: PLATFORM_RESOURCE,
          async validate(client) {
            const global = await globalRead.run(client, {
              route: PLATFORM_RESOURCE.route,
              resource_id: PLATFORM_RESOURCE.id,
            });
            return global?.global === true;
          },
        },
        context: { pool: config.pool, deadline, partition: partitionOf(route) },
      });
      const iso = at.toISOString();
      try {
        const outcome = await execute(frozen)(
          {
            route,
            id: continuationId,
            kind: 'cleanup-continuation.renewed',
            key: `renew:${continuationId}:${iso}`,
            input: { continuationId, at: iso },
            actor,
            deadline,
            authorization,
          },
          async (tx) => {
            const authoritative = canonicalInstant(authoritativeTimeValue(currentCommand(tx).time));
            const expiresAt = new Date(Date.parse(authoritative) + COMMITTED_CONTINUATION_TTL_MS).toISOString();
            const renewed = await oneRow(() =>
              renewContinuation.run(tx, { route, continuation_id: continuationId, expires_at: expiresAt }),
            );
            if (!renewed) throw new GrantDeniedError();
            const storedExpiry = canonicalInstant((renewed as { expiresAt: unknown }).expiresAt);
            const receiptId = derivedId(CONTINUATION_NAMESPACE, `${continuationId}:renew:${storedExpiry}`, route);
            return { continuationId, expiresAt: storedExpiry, receiptId };
          },
        );
        return outcome.value;
      } catch (error) {
        if (error instanceof GrantDeniedError || error instanceof IdempotencyConflictError)
          throw new GrantDeniedError();
        throw error;
      }
    },
  };
}
