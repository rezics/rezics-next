import type { ResourceEligibilityVerifyContext } from '../access/eligibility.ts';
import {
  ACCESS_WORK_AXES,
  EMPTY_ACCESS_WORK,
  AccessWorkUnavailableError,
  type AccessWork,
  type AccessWorkAccounting,
  type AccessWorkProducer,
} from '../access/work.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import type { AccessCheck, AccessClient, AccessContext } from '../request/access.ts';

/** Content-local unavailable boundary for the declared additive request/access
 * ABI. Replace these aliases with the original exports when Accounts delivers
 * them. A callable or a run method alone is never a metered prepared check.
 */
type PreparedAccessCheckInvocation = Readonly<{
  client: AccessClient;
  time: AuthoritativeTime;
  work: AccessWorkAccounting;
}>;
type PreparedAccessCheckWork = AccessWorkProducer<PreparedAccessCheckInvocation, boolean> &
  Readonly<{ run(input: PreparedAccessCheckInvocation): Promise<boolean> }>;
type PreparedCheck = AccessCheck & Readonly<{ work?: PreparedAccessCheckWork }>;
export type CoverVerifyContext = ResourceEligibilityVerifyContext<unknown> &
  Readonly<{ time?: AuthoritativeTime; work?: AccessWorkAccounting }>;

const dependency = 'Content cover prepared subject and anonymous Access work at admitted native time';
const unavailable = (): never => {
  throw new (AccessWorkUnavailableError())(dependency);
};
function sum(left: AccessWork, right: AccessWork): AccessWork {
  const value = Object.fromEntries(ACCESS_WORK_AXES.map((axis) => [axis, left[axis] + right[axis]])) as AccessWork;
  if (ACCESS_WORK_AXES.some((axis) => !Number.isSafeInteger(value[axis]) || value[axis] < 0)) unavailable();
  return Object.freeze(value);
}
function within(actual: AccessWork, bound: AccessWork): boolean {
  return ACCESS_WORK_AXES.every(
    (axis) => Number.isSafeInteger(actual[axis]) && actual[axis] >= 0 && actual[axis] <= bound[axis],
  );
}

export type CoverPreparedAccessWork = Readonly<{
  bound(context: CoverVerifyContext): AccessWork | undefined;
  run(context: CoverVerifyContext, check: AccessCheck): Promise<boolean>;
  actual(context: CoverVerifyContext): AccessWork | undefined;
}>;

/** Compose the ORIGINAL prepared checks, not Semantic's resource verifier alone.
 * The owner frame reserves their declarations in the same parent envelope. This
 * consumer never reserves them again or derives receipts from global usage.
 * Preparation must already have received this genuine time/accounting on the
 * released pool; each original producer additionally proves its own admission.
 */
export function coverPreparedAccessWork(
  subject: AccessCheck,
  publicSubject: AccessCheck | null,
  preparation: Pick<AccessContext, 'time' | 'work' | 'deadline'>,
): CoverPreparedAccessWork {
  const checks: PreparedCheck[] = [...new Set([subject, ...(publicSubject ? [publicSubject] : [])])];
  type Entry = {
    producer: PreparedAccessCheckWork;
    input: PreparedAccessCheckInvocation;
    bound: AccessWork;
    result?: boolean;
    receipt?: AccessWork;
    started: boolean;
  };
  const invocations = new WeakMap<CoverVerifyContext, Map<AccessCheck, Entry>>();
  function live(context: CoverVerifyContext): boolean {
    if (
      !context.time ||
      !context.work ||
      context.time !== preparation.time ||
      context.work !== preparation.work ||
      context.deadline !== preparation.deadline ||
      Date.now() >= context.deadline
    )
      return false;
    try {
      return authoritativeTimeValue(context.time) === context.at;
    } catch {
      return false;
    }
  }
  return {
    bound(context) {
      invocations.delete(context);
      if (!live(context)) return undefined;
      const entries = new Map<AccessCheck, Entry>();
      let total = EMPTY_ACCESS_WORK;
      for (const check of checks) {
        const producer = check.work;
        if (
          !producer ||
          typeof producer.bound !== 'function' ||
          typeof producer.actual !== 'function' ||
          typeof producer.run !== 'function'
        )
          return undefined;
        // live() narrowed the optional native fields; no time is reconstructed.
        if (!context.time || !context.work) return undefined;
        const input = Object.freeze({ client: context.client, time: context.time, work: context.work });
        const bound = producer.bound(input);
        if (!bound || !within(bound, bound)) return undefined;
        total = sum(total, bound);
        entries.set(check, { producer, input, bound, started: false });
      }
      invocations.set(context, entries);
      return total;
    },
    async run(context, check) {
      const entry = invocations.get(context)?.get(check);
      if (!entry || entry.input.client !== context.client || !live(context)) return unavailable();
      if (entry.receipt) return entry.result!;
      if (entry.started) return unavailable();
      entry.started = true;
      const result = await entry.producer.run(entry.input);
      const receipt = entry.producer.actual(entry.input, result);
      if (!live(context) || !receipt || !within(receipt, entry.bound)) return unavailable();
      entry.result = result;
      entry.receipt = Object.freeze({ ...receipt });
      return result;
    },
    actual(context) {
      const entries = invocations.get(context);
      invocations.delete(context);
      if (!entries || !live(context)) return undefined;
      let total = EMPTY_ACCESS_WORK;
      for (const entry of entries.values()) {
        if (entry.started && !entry.receipt) return undefined;
        if (entry.receipt) total = sum(total, entry.receipt);
      }
      return total;
    },
  };
}
