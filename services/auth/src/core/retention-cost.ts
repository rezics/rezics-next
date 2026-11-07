import {
  AUTH_SDK_RETIREMENT_DISPATCH,
  AUTH_SDK_DELETE_DISPATCH,
  WORKFLOW_RETENTION_BATCH_SIZE,
  WORKFLOW_RETENTION_MAX_BATCHES,
  WORKFLOW_RETENTION_DEADLINE_MS,
  type AuthSdkRetirementDispatch,
  type AuthRetentionClosureWork,
  type AuthRetentionInvocation,
  type AuthRetentionPhase,
  type AuthRetentionWork,
} from '../contract/index.ts';

const zero = (): AuthRetentionWork => ({ rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 });
function add(a: AuthRetentionWork, b: AuthRetentionWork): AuthRetentionWork {
  return {
    rows: a.rows + b.rows,
    points: a.points + b.points,
    statements: a.statements + b.statements,
    bytes: a.bytes + b.bytes,
    engineRequests: a.engineRequests + b.engineRequests,
  };
}
function sum(parts: readonly AuthRetentionWork[]): AuthRetentionWork {
  return parts.reduce(add, zero());
}
function native(
  rows: number,
  points: number,
  statements: number,
  bytes: number,
  engineRequests = 0,
): AuthRetentionWork {
  return Object.freeze({ rows, points, statements, bytes, engineRequests });
}

/** Admission ceilings, not observations. Owning native capture measures examined
 * rows, nested statements, buffers and wire bytes independently of these prices. */
export const AUTH_RETENTION_PHASE_COST: Readonly<Record<AuthRetentionPhase, AuthRetentionWork>> = Object.freeze({
  preparation: native(1, 1, 4, 8192, 1), // Includes prepaid rollback.
  initialization: native(2, 2, 2, 8192, 1),
  examination: native(1001, 2, 6, 1000 * 2048 + 8192, 1),
  consumer: native(6, 6, 12, 65536 + 16384, 12),
  'closure-recorder': native(1 + 16 + 1 + 1 + 1, 5, 6, 16384),
  'deletion-custody': native(139 + 2, 8, 9, 10 * 1024 * 1024 + 8192),
  // Two admitted coverage passes: roles, source, request, status, ledger,
  // seven physical families, stream and pending write, with BEGIN/COMMIT/rollback.
  custody: native(17 + 140 + 139 + 10, 17 + 16, 24, 10 * 1024 * 1024 + 140 * 384 + 17 * 128 + 16384, 1),
  receipt: native(8, 8, 8, 16384),
  'fence-read': native(1, 1, 1, 8192, 1),
  'state-read': native(2, 2, 1, 8192, 2),
  absence: native(8, 8, 8, 8192, 8),
  'absent-write': native(140, 2, 8, 140 * 384 + 8192, 1),
});

export const AUTH_WORKFLOW_RETENTION_COST = Object.freeze({
  rawLimit: WORKFLOW_RETENTION_BATCH_SIZE,
  maxPages: WORKFLOW_RETENTION_MAX_BATCHES,
  preparation: Object.freeze({
    statements: 3,
    connections: 1,
    description: 'BEGIN/read/COMMIT of the singleton continuation',
  }),
  examination: Object.freeze({ statements: 5, connections: 1, description: 'BEGIN/read/page/update/COMMIT' }),
  initialization: Object.freeze({
    statements: 10,
    description: 'preparation plus SDK upper-key seek and continuation write',
  }),
  emptyOmitsPage: Object.freeze({ statements: 3, description: 'empty upper key skips SDK page query' }),
  fundedClose: Object.freeze(
    sum([
      AUTH_SDK_RETIREMENT_DISPATCH.connect,
      AUTH_SDK_RETIREMENT_DISPATCH.rollback,
      AUTH_SDK_RETIREMENT_DISPATCH.begin,
      AUTH_SDK_RETIREMENT_DISPATCH.settings,
      AUTH_SDK_RETIREMENT_DISPATCH.reconcile,
      AUTH_SDK_RETIREMENT_DISPATCH.retire,
      AUTH_SDK_RETIREMENT_DISPATCH.commit,
    ]),
  ),
  technicalDelete: Object.freeze({
    ...sum(Object.values(AUTH_SDK_DELETE_DISPATCH)),
    applicationStatements: 4,
    controlStatements: 2,
    description: 'per exact workflow: supported maintainWorkflowOnce, four deletes, native lock and settings',
  }),
  requestTrigger: Object.freeze({ statements: 1, description: 'exact native request consumer on SDK status deletion' }),
  absenceProbes: Object.freeze({ families: 8, description: 'exact physical family probes after payload deletion' }),
  personalCopy: Object.freeze({
    artifacts: 139,
    bytes: 10 * 1024 * 1024,
    roles: 16,
    resultBytes: 64 * 1024,
    description: 'original admitted custody; two inspections, recorder and request-trigger expansion',
  }),
});

export class AuthRetentionBudgetError extends Error {
  override readonly name = 'AuthRetentionBudgetError';
}

/** All ceilings are fixed before the first native effect. A replay uses another
 * admitted page; it cannot refund earlier closure/deletion dispatches. Callers
 * explicitly admit extra pages when retrying within the same operation. */
export function createAuthRetentionInvocation(
  options: {
    deadline?: number;
    signal?: AbortSignal;
    maxAttempts?: number;
    maxPages?: number;
    now?: () => number;
  } = {},
): AuthRetentionInvocation {
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? now() + WORKFLOW_RETENTION_DEADLINE_MS;
  const maxPages = options.maxPages ?? 1;
  const maxAttempts = options.maxAttempts ?? 1;
  if (
    !Number.isFinite(deadline) ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > WORKFLOW_RETENTION_MAX_BATCHES ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 8
  )
    throw new AuthRetentionBudgetError('Invalid Auth retention admission');
  const slots = maxPages * WORKFLOW_RETENTION_BATCH_SIZE;
  const dispatches: Record<string, number> = {};
  const closures: AuthRetentionClosureWork[] = [];
  let reserved = zero();
  let pages = 0;
  let examined = 0;
  let copies = 0;
  let technical = 0;
  function check() {
    if (options.signal?.aborted)
      throw options.signal.reason ?? new AuthRetentionBudgetError('Auth retention cancelled');
    if (now() >= deadline) throw new AuthRetentionBudgetError('Auth retention deadline has expired');
  }
  function charge(key: string, cost: AuthRetentionWork, limit: number) {
    check();
    const count = (dispatches[key] ?? 0) + 1;
    if (count > limit) throw new AuthRetentionBudgetError(`Auth retention admission exhausted: ${key}`);
    dispatches[key] = count;
    reserved = add(reserved, cost);
  }
  const phaseLimits: Record<AuthRetentionPhase, number> = {
    preparation: maxPages,
    initialization: maxPages,
    examination: maxPages,
    consumer: slots,
    'closure-recorder': slots * maxAttempts,
    'deletion-custody': slots,
    custody: 2 * slots,
    receipt: slots,
    'fence-read': 2 * slots,
    'state-read': slots,
    absence: slots,
    'absent-write': slots,
  };
  return Object.freeze({
    deadline,
    maxAttempts,
    ...(options.signal ? { signal: options.signal } : {}),
    check,
    page() {
      check();
      if (pages === maxPages) throw new AuthRetentionBudgetError('Auth retention page admission exhausted');
      pages++;
    },
    examined(rawKeys: number) {
      examined += rawKeys;
    },
    copy(isTechnical: boolean) {
      check();
      if (copies === slots) throw new AuthRetentionBudgetError('Auth retention copy admission exhausted');
      copies++;
      if (isTechnical) technical++;
    },
    async charge(phase: AuthRetentionPhase) {
      charge(`native:${phase}`, AUTH_RETENTION_PHASE_COST[phase], phaseLimits[phase]);
    },
    async reserve(dispatch: AuthSdkRetirementDispatch) {
      charge(`close:${dispatch}`, AUTH_SDK_RETIREMENT_DISPATCH[dispatch], slots * maxAttempts);
    },
    async reserveDelete(dispatch: string) {
      // This string enters from a third-party SDK callback, not an internal caller.
      if (!Object.hasOwn(AUTH_SDK_DELETE_DISPATCH, dispatch))
        throw new TypeError(`Unpriced SDK deletion dispatch: ${dispatch}`);
      charge(`delete:${dispatch}`, AUTH_SDK_DELETE_DISPATCH[dispatch as keyof typeof AUTH_SDK_DELETE_DISPATCH], slots);
    },
    record(work: AuthRetentionClosureWork) {
      // Record even after expiry/cancellation: paid work must survive its failure.
      closures.push(
        Object.freeze({
          ...work,
          failedWork: Object.freeze(work.failedWork.map((entry) => Object.freeze({ ...entry }))),
        }),
      );
    },
    snapshot() {
      return Object.freeze({
        pages,
        examined,
        copies,
        technical,
        reserved: Object.freeze({ ...reserved }),
        dispatches: Object.freeze({ ...dispatches }),
        closures: Object.freeze([...closures]),
      });
    },
  });
}
