import type {
  ResourceEligibilityOptions,
  ResourceEligibilityVerifyContext,
} from '../access/eligibility.ts';
import {
  ACCESS_WORK_AXES,
  EMPTY_ACCESS_WORK,
  AccessWorkUnavailableError,
  type AccessWork,
} from '../access/work.ts';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? 'null');
const uuid = 'x'.repeat(36);
const parentProjection = {
  kind: 'thread',
  id: uuid,
  parent_id: uuid,
  thread_id: uuid,
  board_id: uuid,
  realm_id: uuid,
  purpose: 'discussion',
  visibility: 'taken_down',
  security_revision: '9223372036854775807',
  availability: 'available',
};
const sum = (left: AccessWork, right: AccessWork): AccessWork =>
  Object.fromEntries(ACCESS_WORK_AXES.map((axis) => [axis, left[axis] + right[axis]])) as AccessWork;

export const MEDIA_DOWNLOAD_WORK_DEPENDENCY =
  'Content read-download-media bounded thumbhash/average_color and post-image credit/provenance projection';
export const REALM_MEDIA_WORK_DEPENDENCY =
  'Content realm-media-read bounded thumbhash/average_color projection';
export const COVER_MEDIA_WORK_DEPENDENCY =
  'Semantic subject:read current subject/Context AccessCheck work producer inside Content cover eligibility.verify';

type ParentPlan = Readonly<{
  kind: 'board' | 'thread' | 'post';
  route: number;
  id: string;
  author: boolean;
}>;
type NativeRead = <T>(dispatch: () => Promise<T>) => Promise<T>;
type ParentReads = Readonly<{ parent: NativeRead; author: NativeRead }>;

/** Only these explicit native statements are declared here. read-media-parent
 * selects by complete primary keys; kind='thread' eliminates the post branch,
 * and kind='post' eliminates the thread branch. The latter also probes exactly
 * one head revision by its complete key. Include the input, base tuples, join
 * outputs and UNION output: thread 1+1+1+1; post 1+2+2+1. The board and author
 * statements have no CTE/join and probe one complete primary key each.
 *
 * schema.sql closes every projected parent field: UUIDs, enum-like CHECKs,
 * nonnegative int8 revision, and nullable board purpose (discussion/reviews).
 * No body, title, timestamp, account callback or Context read is included.
 */
function parentWork(plan: ParentPlan): AccessWork {
  const input =
    plan.kind === 'board'
      ? { route: plan.route, id: plan.id }
      : { route: plan.route, id: plan.id, kind: plan.kind };
  return {
    keys: plan.kind === 'post' ? 2 : 1,
    points: plan.kind === 'post' ? 2 : 1,
    witnesses: 0,
    rows: plan.kind === 'post' ? 6 : plan.kind === 'thread' ? 4 : 1,
    bytes: bytes(input) + bytes([parentProjection]),
    emptySeeks: 1,
  };
}
function authorWork(plan: ParentPlan): AccessWork {
  return {
    keys: 1,
    points: 1,
    witnesses: 0,
    rows: 1,
    bytes: bytes({ route: plan.route, id: plan.id }) + bytes({ author_account_id: uuid }),
    emptySeeks: 1,
  };
}

/** Callback-local receipts only. The existing Access owner envelope reserves
 * the complete declaration before entering verify. Each explicit dispatch adds
 * its plan rows before IO; completion only replaces projection bytes/empty seek.
 * A thrown/unknown/timed-out callback never publishes an actual receipt, so
 * Access retains the full envelope. This neither admits work nor checks access.
 */
export function mediaEligibilityCallbacks<E>(options: Readonly<{
  evidence: E;
  parent?: ParentPlan;
  dependency?: string;
  verify(context: ResourceEligibilityVerifyContext<E>, reads: ParentReads): Promise<boolean>;
}>): Pick<ResourceEligibilityOptions<E>, 'prepare' | 'verify' | 'work'> {
  const prepared = new WeakMap<object, E>();
  const verified = new WeakMap<object, { result: boolean; work: AccessWork }>();
  const plan = options.parent && Object.freeze({ ...options.parent });
  const parent = plan && parentWork(plan);
  const author = plan?.author ? authorWork(plan) : undefined;
  const bound = parent && sum(parent, author ?? EMPTY_ACCESS_WORK);
  return {
    work: {
      prepare: {
        // The parent Source owns the earlier reads. Returning its captured row
        // here performs no fresh SQL, copy, or permission check.
        bound: () => EMPTY_ACCESS_WORK,
        actual(context, result) {
          const known = prepared.has(context) && prepared.get(context) === result;
          prepared.delete(context);
          return known ? EMPTY_ACCESS_WORK : undefined;
        },
      },
      verify: {
        bound() {
          if (!bound)
            throw new AccessWorkUnavailableError(options.dependency ?? MEDIA_DOWNLOAD_WORK_DEPENDENCY);
          return bound;
        },
        actual(context, result) {
          const receipt = verified.get(context);
          verified.delete(context);
          return receipt?.result === result ? receipt.work : undefined;
        },
      },
    },
    async prepare(context) {
      prepared.set(context, options.evidence);
      return options.evidence;
    },
    async verify(context) {
      verified.delete(context);
      let spent = EMPTY_ACCESS_WORK;
      const dispatched = new Set<string>();
      const read = async <T>(name: 'parent' | 'author', declaration: AccessWork | undefined, dispatch: () => Promise<T>) => {
        // Unmetered calls retain their original behavior, including unsupported
        // variants. Access invokes this callback only after its work admission.
        if (plan && !declaration) throw new TypeError('Undeclared media eligibility native dispatch');
        if (declaration) {
          if (dispatched.has(name)) throw new TypeError('Repeated media eligibility native dispatch');
          dispatched.add(name);
          spent = sum(spent, declaration);
        }
        const result = await dispatch();
        if (declaration) {
          const input = name === 'author' || plan!.kind === 'board'
            ? { route: plan!.route, id: plan!.id }
            : { route: plan!.route, id: plan!.id, kind: plan!.kind };
          const actualBytes = bytes(input) + bytes(result);
          if (actualBytes > declaration.bytes) throw new TypeError('Media eligibility native projection exceeds declaration');
          spent = {
            ...spent,
            bytes: spent.bytes - declaration.bytes + actualBytes,
            emptySeeks: spent.emptySeeks - (result === null || result === undefined || (Array.isArray(result) && result.length === 0) ? 0 : 1),
          };
        }
        return result;
      };
      const result = await options.verify(context, {
        parent: (dispatch) => read('parent', parent, dispatch),
        author: (dispatch) => read('author', author, dispatch),
      });
      if (plan && !dispatched.has('parent')) throw new TypeError('Missing media eligibility native dispatch');
      verified.set(context, { result, work: spent });
      return result;
    },
  };
}
