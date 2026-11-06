import { memoizedValue } from '../memoized.ts';
import { nativePermissionProjectionBound } from './permission-projection.ts';
import { AccessUnavailableError, requireAccessDeadline } from './unavailable.ts';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Neutral native dimensions, structurally compatible with the Source ledger. */
export type AccessWork = Readonly<{
  keys: number;
  points: number;
  witnesses: number;
  rows: number;
  bytes: number;
  emptySeeks: number;
}>;
export const ACCESS_WORK_AXES = ['keys', 'points', 'witnesses', 'rows', 'bytes', 'emptySeeks'] as const;
export const EMPTY_ACCESS_WORK: AccessWork = Object.freeze({
  keys: 0,
  points: 0,
  witnesses: 0,
  rows: 0,
  bytes: 0,
  emptySeeks: 0,
});

/** Implemented by the caller's EXISTING ledger. This port owns no allowance. */
export type AccessWorkSink = Readonly<{
  reserve(
    operation: string,
    bound: AccessWork,
    kind: 'native' | 'owner',
  ): Readonly<{ settle(actual: AccessWork): void }> | null;
}>;

/** Trusted resource owner: pure finite declaration, then its actual receipt.
 * `actual` must be synchronous, contain no IO, and refer to this exact invocation.
 * A missing receipt after dispatch consumes the entire bound and poisons the attempt.
 */
export type AccessWorkProducer<C, R> = Readonly<{
  bound(context: C): AccessWork | undefined;
  actual(context: C, result: R): AccessWork | undefined;
}>;

export type AccessWorkResult<T> =
  | Readonly<{ state: 'complete'; value: T; usage: AccessWork }>
  | Readonly<{ state: 'unavailable'; dependency: string; usage: AccessWork }>
  | Readonly<{ state: 'failed'; error: unknown; usage: AccessWork }>;

export function AccessWorkUnavailableError() {
  return memoizedValue(
    AccessWorkUnavailableError,
    () =>
      class AccessWorkUnavailableError extends AccessUnavailableError {
        constructor(readonly dependency: string) {
          super('overloaded');
          this.name = 'AccessWorkUnavailableError';
          this.message = `Access work unavailable: ${dependency}`;
        }
      },
  );
}
export type AccessWorkUnavailableError = InstanceType<ReturnType<typeof AccessWorkUnavailableError>>;

function copy(work: AccessWork): AccessWork {
  if (!work || ACCESS_WORK_AXES.some((axis) => !Number.isSafeInteger(work[axis]) || work[axis] < 0))
    throw new TypeError('Invalid Access work');
  return Object.freeze(Object.fromEntries(ACCESS_WORK_AXES.map((axis) => [axis, work[axis]]))) as AccessWork;
}

export function addAccessWork(...values: readonly AccessWork[]): AccessWork {
  return copy(
    Object.fromEntries(
      ACCESS_WORK_AXES.map((axis) => [axis, values.reduce((total, value) => total + value[axis], 0)]),
    ) as AccessWork,
  );
}

type AccountingFrame = { bound: AccessWork; used: AccessWork; open: boolean; active: number; deadline: number };

// Native transport composition may add SQL statement/text accounting, but must
// retain the dimensions already held by this actual owner invocation.
const nativeDispatch = new AsyncLocalStorage<boolean>();
export function isAccessWorkDispatch(): boolean {
  return nativeDispatch.getStore() === true;
}

/** Receipt accumulator only. Admission and remaining budget stay with the sink.
 * Dispatch charges the bound immediately, so timeout/parallel/failed work cannot
 * disappear from a caller's receipt while an operation is still unwinding.
 */
export class AccessWorkAccounting {
  private readonly frames = new AsyncLocalStorage<AccountingFrame>();
  private used: AccessWork = EMPTY_ACCESS_WORK;
  private failure: unknown;
  private readonly pending = new Set<{ finish(charged: AccessWork): void; bound: AccessWork }>();
  constructor(
    private readonly sink: AccessWorkSink,
    readonly deadline: number,
  ) {
    if (!Number.isFinite(deadline)) throw new TypeError('Invalid Access work deadline');
  }
  usage(): AccessWork {
    return this.used;
  }
  /** Seal unknown dispatched work before an enclosing deadline race returns. */
  fail(error: unknown): void {
    this.failure ??= error ?? new Error('Access work failed');
    for (const pending of this.pending) pending.finish(pending.bound);
  }
  async capture<T>(operation: () => Promise<T>): Promise<AccessWorkResult<T>> {
    try {
      const value = await operation();
      if (this.failure) throw this.failure;
      return { state: 'complete', value, usage: this.usage() };
    } catch (error) {
      this.fail(error);
      return error instanceof AccessWorkUnavailableError()
        ? { state: 'unavailable', dependency: error.dependency, usage: this.usage() }
        : { state: 'failed', error, usage: this.usage() };
    }
  }
  unavailable(dependency: string): never {
    throw new (AccessWorkUnavailableError())(dependency);
  }
  /** Exact receipt of this admitted invocation, independent of concurrent roots. */
  async invocation<T>(
    operation: string,
    bound: AccessWork | undefined,
    dispatch: () => Promise<T>,
    deadline = this.deadline,
  ): Promise<Readonly<{ value: T; usage: AccessWork }>> {
    let usage: AccessWork | undefined;
    const value = await this.run(
      operation,
      bound,
      async () => {
        const frame = this.frames.getStore();
        if (!frame) return this.unavailable(`${operation}: native frame`);
        const result = await dispatch();
        usage = frame.used;
        return result;
      },
      () => usage,
      'owner',
      deadline,
    );
    if (!usage) return this.unavailable(`${operation}: native receipt`);
    return { value, usage };
  }
  async run<T>(
    operation: string,
    footprint: AccessWork | undefined,
    dispatch: () => Promise<T>,
    actual?: (result: T) => AccessWork | undefined,
    kind: 'native' | 'owner' = 'native',
    notAfter = this.deadline,
  ): Promise<T> {
    if (this.failure) throw this.failure;
    if (!Number.isFinite(notAfter)) throw new TypeError('Invalid Access work invocation deadline');
    const parent = this.frames.getStore();
    const deadline = Math.min(this.deadline, parent?.deadline ?? this.deadline, notAfter);
    requireAccessDeadline(deadline);
    if (!footprint) this.unavailable(operation);
    const bound = copy(footprint);
    if (parent && !parent.open) this.unavailable(`${operation}: closed native frame`);
    // Validate the cumulative arithmetic before asking the parent to hold work.
    const next = copy(
      Object.fromEntries(
        ACCESS_WORK_AXES.map((axis) => [axis, (parent?.used ?? this.used)[axis] + bound[axis]]),
      ) as AccessWork,
    );
    if (parent && ACCESS_WORK_AXES.some((axis) => next[axis] > parent.bound[axis]))
      this.unavailable(`${operation}: native frame capacity`);
    const reservation = parent
      ? {
          settle: (charged: AccessWork) => {
            parent.active--;
            parent.used = copy(
              Object.fromEntries(
                ACCESS_WORK_AXES.map((axis) => [axis, parent.used[axis] - bound[axis] + charged[axis]]),
              ) as AccessWork,
            );
          },
        }
      : this.sink.reserve(operation, bound, kind);
    if (!reservation) this.unavailable(operation);
    // Synchronous admission cannot interleave sibling dispatches.
    if (parent) {
      parent.used = next;
      parent.active++;
    } else this.used = next;
    const frame: AccountingFrame | undefined =
      kind === 'owner' ? { bound, used: EMPTY_ACCESS_WORK, open: true, active: 0, deadline } : undefined;
    const pending = {
      bound,
      finish: (charged: AccessWork) => {
        if (!this.pending.delete(pending)) return;
        if (frame) frame.open = false;
        if (!parent)
          this.used = copy(
            Object.fromEntries(
              ACCESS_WORK_AXES.map((axis) => [axis, this.used[axis] - bound[axis] + charged[axis]]),
            ) as AccessWork,
          );
        try {
          reservation.settle(charged);
        } catch (error) {
          this.failure = error;
          throw error;
        }
      },
    };
    this.pending.add(pending);
    let charged = bound;
    try {
      const result = await nativeDispatch.run(true, () => (frame ? this.frames.run(frame, dispatch) : dispatch()));
      if (this.failure) throw this.failure;
      if (frame?.active) this.unavailable(`${operation}: unfinished native children`);
      if (actual) {
        const receipt = actual(result);
        if (!receipt) this.unavailable(`${operation}: actual receipt`);
        charged = copy(receipt);
        if (
          ACCESS_WORK_AXES.some((axis) => charged[axis] > bound[axis]) ||
          (kind === 'native' && charged.rows !== bound.rows)
        )
          throw new TypeError('Access work exceeds declaration or refunds dispatched native rows');
      }
      if (frame && ACCESS_WORK_AXES.some((axis) => charged[axis] < frame.used[axis]))
        throw new TypeError('Access owner receipt omits dispatched child work');
      requireAccessDeadline(deadline);
      return result;
    } catch (error) {
      charged = bound;
      this.fail(error);
      throw error;
    } finally {
      pending.finish(charged);
    }
  }
}

export async function accessOwnerWork<C, R>(
  work: AccessWorkAccounting | undefined,
  operation: string,
  producer: AccessWorkProducer<C, R> | undefined,
  context: C,
  dispatch: () => Promise<R>,
): Promise<R> {
  if (!work) return dispatch();
  if (!producer) return work.unavailable(operation);
  // This envelope holds a finite maximum BEFORE entering foreign code. Its
  // successful receipt sums only the owner's actually dispatched native plans;
  // branches never dispatched are not native-row refunds. Unknown failure burns
  // the envelope in full, exactly like a failed composition in the caller ledger.
  return work.run(operation, producer.bound(context), dispatch, (result) => producer.actual(context, result), 'owner');
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null');
/** PostgreSQL timestamp/range text has a finite calendar (six-digit AD year,
 * microseconds, zone and BC suffix). 64 ASCII bytes cover a timestamp; a range
 * has two endpoints, quotes, separator and brackets. No native text body is read.
 */
const timestamp = 'x'.repeat(64);
const interval = 'x'.repeat(2 * (64 + 2) + 3);
const uuid = 'x'.repeat(36);
const rowBytes = (row: unknown, count: number) => 2 + count * (bytes(row) + 1);

/** Owner declarations for the explicit SQL call sites, never a SQL classifier.
 * Rows are dispatched plan work (including empty probes), NEVER result rowCount.
 * Byte reservations cover parameters and the closed projection. Only bytes and
 * the outer empty seek can settle below their bound on a completed statement.
 */
export function accessNativeDeclaration(
  operation:
    | 'time'
    | 'assignment'
    | 'inverse'
    | 'membership'
    | 'candidates'
    | 'formula'
    | 'account-state'
    | 'account-profile'
    | 'opening'
    | 'opening-partition'
    | 'opening-moved-target'
    | 'transaction',
  input: unknown,
  shape: Readonly<{
    members?: number;
    groups?: number;
    targets?: number;
    roles?: number;
    grantRoles?: number;
    explicit?: boolean;
    public?: boolean;
    global?: boolean;
    assignment?: boolean;
    movedToBytes?: number;
  }>,
) {
  const members = shape.members ?? 0;
  const groups = shape.groups ?? 0;
  const targets = (shape.targets ?? 1) + (shape.global ? 1 : 0);
  const keys = (shape.roles ?? 0) + 2 * members;
  const branches = 1 + (shape.explicit ? 1 : 0) + (shape.public ? 1 : 0);
  const probes = targets * keys * branches;
  const grants = shape.grantRoles ?? 0;
  let points = 0,
    rows = 0,
    projection = 0,
    examinedKeys = 0;
  switch (operation) {
    case 'account-state':
      // unnest contributes one input row and the unique account point contributes
      // at most one candidate per full key, including absent accounts.
      examinedKeys = points = shape.targets ?? 1;
      rows = examinedKeys * 2;
      projection = rowBytes(
        {
          id: uuid,
          kind: 'organization',
          state: 'suspended',
          fenced: false,
          operatorAccountId: uuid,
          minimumAuthnEpoch: '9'.repeat(19),
        },
        examinedKeys,
      );
      break;
    case 'account-profile':
      // One full-key active unfenced account. Closed private fields, never stored URLs.
      examinedKeys = points = rows = 1;
      projection = bytes({
        id: uuid,
        kind: 'organization',
        handle: 'x'.repeat(64),
        displayName: 'x'.repeat(4096),
        bio: 'x'.repeat(4096),
        links: Array.from({ length: 5 }, () => ({ label: 'x'.repeat(64), url: 'x'.repeat(2048) })),
        avatar: uuid,
        publicViews: { posts: false, reviews: false, collections: false, realms: false },
        speakersListed: false,
        operatorAccountId: uuid,
      });
      break;
    case 'opening':
      examinedKeys = points = 1; // exact Global group/time exclusion-key probe
      rows = 2; // authority scalar and at most one nonoverlapping opening
      projection = bytes({ open: false, at: timestamp });
      break;
    case 'opening-partition':
      examinedKeys = points = rows = 1; // core.partition unique primary key
      projection = bytes({ writeState: 'fenced', movedToBytes: 2147483647 }); // SQL int4 octet_length
      break;
    case 'opening-moved-target': {
      const length = shape.movedToBytes;
      if (length === undefined || !Number.isSafeInteger(length) || length < 0)
        throw new TypeError('Invalid native partition handoff byte bound');
      examinedKeys = points = rows = 1;
      // Every source byte can require at most six JSON bytes (e.g. a control
      // character escaped as a Unicode sequence). No locator body is constructed
      // to declare this bound; SQL enforces the same admitted length.
      projection = bytes({ movedTo: '' }) + 6 * length;
      break;
    }
    case 'transaction':
      // A control statement has no tuple projection. The call site returns void,
      // avoiding pg's transport metadata as a fabricated data receipt.
      projection = bytes(null);
      break;
    case 'time':
      rows = 1;
      projection = bytes({ at: timestamp, databaseAt: timestamp });
      break;
    case 'assignment':
      examinedKeys = points = rows = 2; // unique assignment + its account
      projection = bytes({
        valid: interval,
        accountId: uuid,
        kind: 'actor',
        state: 'suspended',
        fenced: false,
        operatorAccountId: uuid,
      });
      break;
    case 'inverse':
      // Coverage point and the two account/kind ranges. The writer's canonical
      // MEMBERSHIP_LIMIT bounds their combined group cardinality, not each kind.
      points = members * 3;
      examinedKeys = rows = members * (1 + groups);
      projection = rowBytes(
        { accountId: uuid, complete: false, kind: 'organization', id: uuid },
        members * Math.max(1, groups),
      );
      break;
    case 'membership':
      // One group account + current and next transition seeks for BOTH roles.
      points = examinedKeys = rows = groups * (1 + 2 * 2);
      projection = rowBytes(
        {
          accountId: uuid,
          organizationId: uuid,
          kind: 'organization',
          state: 'suspended',
          fenced: false,
          role: 'member',
          member: false,
          valid: interval,
        },
        groups * 2,
      );
      break;
    case 'candidates':
    case 'formula': {
      // Per (target, branch, key): action grant, each configured role grant,
      // three denial reasons. Temporal exclusion/last-range LIMIT 1 bounds each seek/reason.
      const native = probes * (1 + grants + 3); // resource / suspension / realm_ban denials
      points = native + (operation === 'formula' && shape.assignment ? 1 : 0);
      examinedKeys = points;
      // Include the finite input/target/key/branch/probe/decision intermediates
      // and final equality joins as well as native tuple candidates.
      rows =
        native + (shape.assignment ? 1 : 0) + 1 + targets + keys + branches + probes + targets * branches + targets * 6;
      if (operation === 'formula') {
        projection = rowBytes(
          {
            resourceId: uuid,
            allowed: false,
            governanceReach: false,
            explicit: false,
            publicAllowed: false,
            ...nativePermissionProjectionBound,
            at: timestamp,
            live: false,
          },
          shape.targets ?? 1,
        );
      } else projection = rowBytes({ accountId: uuid, organizationId: uuid }, keys);
      break;
    }
  }
  const bound = copy({
    keys: examinedKeys,
    points: points + 1,
    witnesses: 0,
    rows,
    bytes: bytes(input) + projection,
    emptySeeks: 1,
  });
  return {
    bound,
    actual: (result: unknown): AccessWork => ({
      ...bound,
      bytes: bytes(input) + bytes(result),
      emptySeeks: result === null || result === undefined || (Array.isArray(result) && !result.length) ? 1 : 0,
    }),
  };
}

export function accessNativeWork<T>(
  work: AccessWorkAccounting | undefined,
  operation: Parameters<typeof accessNativeDeclaration>[0],
  input: unknown,
  shape: Parameters<typeof accessNativeDeclaration>[2],
  dispatch: () => Promise<T>,
): Promise<T> {
  if (!work) return dispatch();
  const declaration = accessNativeDeclaration(operation, input, shape);
  return work.run(`access.${operation}`, declaration.bound, dispatch, declaration.actual);
}

/** Reserve before an explicit pool checkout, including its wait and failure. */
export function accessCheckout<T>(work: AccessWorkAccounting | undefined, dispatch: () => Promise<T>): Promise<T> {
  return work ? work.run('access.pool-checkout', { ...EMPTY_ACCESS_WORK, points: 1 }, dispatch) : dispatch();
}

/** Explicit transaction control; no SQL inspection or hidden queries. */
export function accessTransaction(
  work: AccessWorkAccounting | undefined,
  client: import('../request/access.ts').AccessClient,
  statement: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' | 'BEGIN READ ONLY' | 'COMMIT' | 'ROLLBACK',
): Promise<void> {
  return accessNativeWork(work, 'transaction', { statement }, {}, async () => {
    await client.query(statement);
  });
}
