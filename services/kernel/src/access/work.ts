import { AccessUnavailableError, requireAccessDeadline } from './unavailable.ts';

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
  keys: 0, points: 0, witnesses: 0, rows: 0, bytes: 0, emptySeeks: 0,
});

/** Implemented by the caller's EXISTING ledger. This port owns no allowance. */
export type AccessWorkSink = Readonly<{
  reserve(operation: string, bound: AccessWork): Readonly<{ settle(actual: AccessWork): void }> | null;
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

export class AccessWorkUnavailableError extends AccessUnavailableError {
  constructor(readonly dependency: string) {
    super('overloaded');
    this.name = 'AccessWorkUnavailableError';
    this.message = `Access work unavailable: ${dependency}`;
  }
}

function copy(work: AccessWork): AccessWork {
  if (!work || ACCESS_WORK_AXES.some((axis) => !Number.isSafeInteger(work[axis]) || work[axis] < 0))
    throw new TypeError('Invalid Access work');
  return Object.freeze(Object.fromEntries(ACCESS_WORK_AXES.map((axis) => [axis, work[axis]]))) as AccessWork;
}

/** Receipt accumulator only. Admission and remaining budget stay with the sink.
 * Dispatch charges the bound immediately, so timeout/parallel/failed work cannot
 * disappear from a caller's receipt while an operation is still unwinding.
 */
export class AccessWorkAccounting {
  private used: AccessWork = EMPTY_ACCESS_WORK;
  private failure: unknown;
  private readonly pending = new Set<{ finish(charged: AccessWork): void; bound: AccessWork }>();
  constructor(private readonly sink: AccessWorkSink, readonly deadline: number) {
    if (!Number.isFinite(deadline)) throw new TypeError('Invalid Access work deadline');
  }
  usage(): AccessWork { return this.used; }
  /** Seal unknown dispatched work before an enclosing deadline race returns. */
  fail(error: unknown): void {
    this.failure ??= error ?? new Error('Access work failed');
    for (const pending of this.pending) pending.finish(pending.bound);
  }
  async capture<T>(operation: () => Promise<T>): Promise<AccessWorkResult<T>> {
    try { return { state: 'complete', value: await operation(), usage: this.usage() }; }
    catch (error) {
      this.fail(error);
      return error instanceof AccessWorkUnavailableError
        ? { state: 'unavailable', dependency: error.dependency, usage: this.usage() }
        : { state: 'failed', error, usage: this.usage() };
    }
  }
  unavailable(dependency: string): never { throw new AccessWorkUnavailableError(dependency); }
  async run<T>(
    operation: string,
    footprint: AccessWork | undefined,
    dispatch: () => Promise<T>,
    actual?: (result: T) => AccessWork | undefined,
  ): Promise<T> {
    if (this.failure) throw this.failure;
    requireAccessDeadline(this.deadline);
    if (!footprint) this.unavailable(operation);
    const bound = copy(footprint);
    const reservation = this.sink.reserve(operation, bound);
    if (!reservation) this.unavailable(operation);
    const before = this.used;
    // Add, rather than replace a snapshot: sibling reservations may be in flight.
    this.used = copy(Object.fromEntries(ACCESS_WORK_AXES.map((axis) => [axis, before[axis] + bound[axis]])) as AccessWork);
    const pending = {
      bound,
      finish: (charged: AccessWork) => {
        if (!this.pending.delete(pending)) return;
        this.used = copy(Object.fromEntries(ACCESS_WORK_AXES.map((axis) =>
          [axis, this.used[axis] - bound[axis] + charged[axis]],
        )) as AccessWork);
        try { reservation.settle(charged); }
        catch (error) { this.failure = error; throw error; }
      },
    };
    this.pending.add(pending);
    let charged = bound;
    try {
      const result = await dispatch();
      if (this.failure) throw this.failure;
      if (actual) {
        const receipt = actual(result);
        if (!receipt) this.unavailable(`${operation}: actual receipt`);
        charged = copy(receipt);
        if (ACCESS_WORK_AXES.some((axis) => charged[axis] > bound[axis]) || charged.rows !== bound.rows)
          throw new TypeError('Access work exceeds declaration or refunds dispatched native rows');
      }
      requireAccessDeadline(this.deadline);
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
  if (!producer) work.unavailable(operation);
  return work.run(operation, producer.bound(context), dispatch, (result) => producer.actual(context, result));
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
export function accessNativeWork<T>(
  work: AccessWorkAccounting | undefined,
  operation: 'time' | 'assignment' | 'inverse' | 'membership' | 'candidates' | 'formula',
  input: unknown,
  shape: Readonly<{
    members?: number; groups?: number; targets?: number; roles?: number; grantRoles?: number;
    explicit?: boolean; public?: boolean; global?: boolean; assignment?: boolean;
  }>,
  dispatch: () => Promise<T>,
): Promise<T> {
  if (!work) return dispatch();
  const members = shape.members ?? 0;
  const groups = shape.groups ?? 0;
  const targets = (shape.targets ?? 1) + (shape.global ? 1 : 0);
  const keys = (shape.roles ?? 0) + 2 * members;
  const branches = 1 + (shape.explicit ? 1 : 0) + (shape.public ? 1 : 0);
  const probes = targets * keys * branches;
  const grants = shape.grantRoles ?? 0;
  let points = 0, rows = 0, projection = 0, examinedKeys = 0;
  switch (operation) {
    case 'time':
      rows = 1;
      projection = bytes({ at: timestamp, databaseAt: timestamp });
      break;
    case 'assignment':
      examinedKeys = points = rows = 2; // unique assignment + its account
      projection = bytes({ valid: interval, accountId: uuid, kind: 'actor', state: 'suspended', fenced: false, operatorAccountId: uuid });
      break;
    case 'inverse':
      // Coverage point and the two account/kind ranges. The writer's canonical
      // MEMBERSHIP_LIMIT bounds their combined group cardinality, not each kind.
      points = members * 3;
      examinedKeys = rows = members * (1 + groups);
      projection = rowBytes({ accountId: uuid, complete: false, kind: 'organization', id: uuid }, members * Math.max(1, groups));
      break;
    case 'membership':
      // One group account + current and next transition seeks for BOTH roles.
      points = examinedKeys = rows = groups * (1 + 2 * 2);
      projection = rowBytes({ accountId: uuid, organizationId: uuid, kind: 'organization', state: 'suspended', fenced: false, role: 'member', member: false, valid: interval }, groups * 2);
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
      rows = native + 1 + targets + keys + branches + probes + targets * branches + targets * 6;
      if (operation === 'formula') {
        projection = rowBytes({ resourceId: uuid, allowed: false, governanceReach: false, explicit: false, publicAllowed: false, at: timestamp, live: false }, shape.targets ?? 1);
      } else projection = rowBytes({ accountId: uuid, organizationId: uuid }, keys);
      break;
    }
  }
  const bound = copy({ keys: examinedKeys, points: points + 1, witnesses: 0, rows,
    bytes: bytes(input) + projection, emptySeeks: 1 });
  return work.run(`access.${operation}`, bound, dispatch, (result) => ({
    ...bound, bytes: bytes(input) + bytes(result),
    emptySeeks: result === null || result === undefined || (Array.isArray(result) && !result.length) ? 1 : 0,
  }));
}

/** Reserve before an explicit pool checkout, including its wait and failure. */
export function accessCheckout<T>(work: AccessWorkAccounting | undefined, dispatch: () => Promise<T>): Promise<T> {
  return work ? work.run('access.pool-checkout', { ...EMPTY_ACCESS_WORK, points: 1 }, dispatch) : dispatch();
}
