import type { CoverPreparedAccessWork } from './cover-prepared-access-work.ts';
import type { ResourceEligibilityOptions, ResourceEligibilityVerifyContext } from '../access/eligibility.ts';
import { ACCESS_WORK_AXES, EMPTY_ACCESS_WORK, AccessWorkUnavailableError, type AccessWork } from '../work/access-work.ts';

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
export const REALM_MEDIA_WORK_DEPENDENCY = 'Content realm-media-read bounded thumbhash/average_color projection';
export const COVER_MEDIA_WORK_DEPENDENCY =
  'Semantic subject:read current subject/Context AccessCheck work producer inside Content cover eligibility.verify';

type ParentPlan = Readonly<{
  kind: 'board' | 'thread' | 'post' | 'container';
  route: number;
  id: string;
  author: boolean;
}>;
type NativeRead = <T>(dispatch: () => Promise<T>) => Promise<T>;
type MediaPlan = Readonly<{
  kind: 'download' | 'realm';
  route: number;
  id: string;
  format?: string;
  width?: number;
  credit?: boolean;
  provenance?: boolean;
  ancestors?: readonly Readonly<{ id: string; kind: 'post' | 'thread' }>[];
}>;
type ParentInput = Readonly<{ route: number; id: string; kind: string }>;
type ParentReads = Readonly<{
  parent: NativeRead;
  author: NativeRead;
  media<T>(dispatch: (bounded: boolean) => Promise<T>): Promise<T>;
  ancestor<T>(input: ParentInput, dispatch: () => Promise<T>): Promise<T>;
  subject<T>(dispatch: (bounded: boolean) => Promise<T>): Promise<T>;
  prepared(check: import('../request/access.ts').AccessCheck): Promise<boolean>;
}>;

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
  const input = plan.kind === 'board' ? [plan.route, plan.id] : [plan.route, plan.id, plan.kind];
  return {
    keys: plan.kind === 'container' ? 3 : plan.kind === 'post' ? 2 : 1,
    points: plan.kind === 'container' ? 3 : plan.kind === 'post' ? 2 : 1,
    witnesses: 0,
    rows: plan.kind === 'container' ? 10 : plan.kind === 'post' ? 6 : plan.kind === 'thread' ? 4 : 1,
    bytes: bytes(input) + bytes(plan.kind === 'container' ? [parentProjection, parentProjection] : [parentProjection]),
    emptySeeks: 1,
  };
}
function authorWork(plan: ParentPlan): AccessWork {
  return {
    keys: 1,
    points: 1,
    witnesses: 0,
    rows: 1,
    bytes: bytes([plan.route, plan.id]) + bytes([{ author_account_id: uuid }]),
    emptySeeks: 1,
  };
}

// All fixed text in these projections is ASCII by schema or work-only SQL.
// Int4/int8 use at most 11/19 characters; finite float4 values become JS numbers
// whose JSON representation fits 32 bytes. PostgreSQL timestamps fit 64 bytes.
// JSONB envelope text is bounded by SQL's uncompressed UTF-8 serialization;
// A decoded JSON number's spelling may grow through IEEE rounding. Each input
// byte can contribute at most 32 output bytes (a JS number's entire spelling;
// string escaping needs <=6). This bounds parsed JSON without assuming that
// JSON.stringify reproduces PostgreSQL's numeric representation.
const mediaProjection = {
  media_id: uuid,
  container_id: uuid,
  uploader_id: uuid,
  purpose: 'realm-banner',
  state: 'available',
  claimed_at: 'x'.repeat(64),
  erased: false,
  collection_pending: false,
  taken_down: false,
  security_revision: '9'.repeat(19),
  sha256: 'f'.repeat(64),
  thumbhash: 'x'.repeat(44),
  average_color: '#ffffff',
  focal_x: 'x'.repeat(32),
  focal_y: 'x'.repeat(32),
};
const variantProjection = {
  format: 'webp',
  width: 2560,
  height: 2147483647,
  key: `m/${uuid}/webp-2560`,
  sha256: 'f'.repeat(64),
  mediaType: 'image/webp',
  byteCount: '9'.repeat(19),
};
function mediaParameters(plan: MediaPlan): readonly unknown[] {
  return plan.kind === 'realm'
    ? [plan.route, plan.id]
    : [
        plan.route,
        plan.id,
        plan.format,
        plan.width,
        plan.credit === false ? 0 : 8192,
        plan.provenance === false ? 0 : 65536,
      ];
}
/** Explicit work-only SQL plans, including finite intermediate tuples:
 * download: input + media/slot unique tuples + two joins + output = 6.
 * Realm: input + media + join + <=12 variant tuples + <=12 aggregate ordered
 * inputs + aggregate + output = 29. The UNIQUE media_variant_slot_idx maps
 * two formats to six slots each, independent of how many historical widths
 * exist. No derivative enumeration occurs in the download plan.
 * Container seek: both inlined input branches (2), thread/post/head (3),
 * their three join outputs and at most two UNION outputs = 10. Subsequent known-kind seeks prune a branch.
 * Bytes cover parameters and the entire closed wire projection, not rowCount,
 * compressed storage size, returned array cardinality or an initial row's size.
 */
function mediaWork(plan: MediaPlan): AccessWork {
  let projection: object;
  if (plan.kind === 'realm') {
    // jsonb_agg's text includes spaces after separators; all variant fields are
    // schema-closed ASCII. The outer JSON encoding also escapes its quotes.
    const variant = JSON.stringify(variantProjection).replace(/([,:])/g, '$1 ');
    projection = {
      ...mediaProjection,
      claimed_realm_id: uuid,
      variants_json: `[${Array(12).fill(variant).join(', ')}]`,
    };
  } else {
    projection = {
      ...mediaProjection,
      claimed_item_id: uuid,
      key: `m/${uuid}/original`,
      media_type: 'image/jpeg',
      actual_byte_count: '9'.repeat(19),
      width: '-2147483648',
      height: '-2147483648',
      credit: null,
      provenance: null,
      variant_key: variantProjection.key,
      variant_sha256: variantProjection.sha256,
      variant_media_type: variantProjection.mediaType,
      variant_byte_count: variantProjection.byteCount,
      variant_format: 'webp',
      variant_width: 2560,
      variant_height: 2147483647,
    };
  }
  return {
    keys: plan.kind === 'realm' ? 13 : 2,
    points: 2,
    witnesses: 0,
    rows: plan.kind === 'realm' ? 29 : 6,
    // Replace null only for an admitted nonnull envelope. A zero SQL limit
    // requires null; it never clips a changed rights/provenance object.
    bytes:
      bytes(mediaParameters(plan)) +
      bytes([projection]) +
      (plan.kind === 'download'
        ? (plan.credit === false ? 0 : 32 * 8192 - bytes(null)) +
          (plan.provenance === false ? 0 : 32 * 65536 - bytes(null))
        : 0),
    emptySeeks: 2,
  };
}

/** Callback-local receipts only. The existing Access owner envelope reserves
 * the complete declaration before entering verify. Each explicit dispatch adds
 * its plan rows before IO; completion only replaces projection bytes/empty seek.
 * A thrown/unknown/timed-out callback never publishes an actual receipt, so
 * Access retains the full envelope. This neither admits work nor checks access.
 */
export function mediaEligibilityCallbacks<E>(
  options: Readonly<{
    evidence: E;
    parent?: ParentPlan;
    media?: MediaPlan;
    dependency?: string;
    cover?: Readonly<{ route: number; id: string; access: CoverPreparedAccessWork }>;
    verify(context: ResourceEligibilityVerifyContext<E>, reads: ParentReads): Promise<boolean>;
  }>,
): Pick<ResourceEligibilityOptions<E>, 'prepare' | 'verify' | 'work'> {
  const prepared = new WeakMap<object, E>();
  const verified = new WeakMap<object, { result: boolean; work: AccessWork }>();
  const plan = options.parent && Object.freeze({ ...options.parent });
  const parent = plan && parentWork(plan);
  const author = plan?.author ? authorWork(plan) : undefined;
  const mediaPlan =
    options.media &&
    Object.freeze({
      ...options.media,
      ...(options.media.ancestors === undefined
        ? {}
        : {
            ancestors: options.media.ancestors.map((node) => Object.freeze({ ...node })),
          }),
    });
  const media = mediaPlan && mediaWork(mediaPlan);
  const cover = options.cover;
  // semantic/subject-exists.sql selects the constant found=1 by the complete
  // subject PK. Even a miss dispatches one native point, with no payload read.
  const subject = cover && {
    keys: 1,
    points: 1,
    witnesses: 0,
    rows: 1,
    bytes: bytes({ route: cover.route, subject_id: cover.id }) + bytes({ found: 1 }),
    emptySeeks: 1,
  };
  const ancestors =
    mediaPlan?.ancestors?.map((node, index) => {
      const input = { route: mediaPlan.route, id: node.id, kind: index === 0 ? ('container' as const) : node.kind };
      return { input, work: parentWork({ ...input, author: false }) };
    }) ?? [];
  if (ancestors.length > 34 || (plan && mediaPlan) || (cover && (!mediaPlan || mediaPlan.kind !== 'download')))
    throw new TypeError('Invalid media eligibility plan');
  let bound = parent ? sum(parent, author ?? EMPTY_ACCESS_WORK) : media;
  if (bound) for (const node of ancestors) bound = sum(bound, node.work);
  if (bound && subject) bound = sum(bound, subject);
  const metered = new WeakSet<object>();
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
        bound(context) {
          verified.delete(context);
          metered.delete(context);
          if (context.evidence !== options.evidence) return undefined;
          if (!bound) throw new AccessWorkUnavailableError(options.dependency ?? MEDIA_DOWNLOAD_WORK_DEPENDENCY);
          const nested = cover?.access.bound(context);
          if (cover && !nested) throw new AccessWorkUnavailableError(COVER_MEDIA_WORK_DEPENDENCY);
          metered.add(context);
          return nested ? sum(bound, nested) : bound;
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
      const bounded = metered.delete(context);
      // Direct calls cannot turn an explicitly metered cover into ordinary IO.
      if (cover && 'work' in context && context.work && !bounded)
        throw new AccessWorkUnavailableError(COVER_MEDIA_WORK_DEPENDENCY);
      let spent = EMPTY_ACCESS_WORK;
      let ancestorIndex = 0;
      const dispatched = new Set<string>();
      const read = async <T>(
        name: string,
        declaration: AccessWork | undefined,
        input: unknown,
        dispatch: () => Promise<T>,
        wire: (result: T) => unknown = (result) => result,
        empty: (result: T) => number = (result) =>
          result === null || result === undefined || (Array.isArray(result) && result.length === 0) ? 1 : 0,
      ) => {
        if (!bounded) return dispatch();
        if (!declaration || dispatched.has(name)) throw new TypeError('Undeclared media eligibility native dispatch');
        dispatched.add(name);
        spent = sum(spent, declaration);
        const result = await dispatch();
        const actualBytes = bytes(input) + bytes(wire(result));
        if (actualBytes > declaration.bytes)
          throw new TypeError('Media eligibility native projection exceeds declaration');
        spent = {
          ...spent,
          bytes: spent.bytes - declaration.bytes + actualBytes,
          emptySeeks: spent.emptySeeks - declaration.emptySeeks + empty(result),
        };
        return result;
      };
      const parentInput = plan && (plan.kind === 'board' ? [plan.route, plan.id] : [plan.route, plan.id, plan.kind]);
      const wireRows = (value: unknown) =>
        value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
      const result = await options.verify(context, {
        subject: (dispatch) =>
          read('subject', subject, cover && { route: cover.route, subject_id: cover.id }, () => dispatch(bounded)),
        prepared: (check) => {
          if (!cover) throw new TypeError('Undeclared prepared media eligibility check');
          return bounded ? cover.access.run(context, check) : check(context.client);
        },
        parent: (dispatch) => read('parent', parent, parentInput, dispatch, wireRows),
        author: (dispatch) => read('author', author, plan && [plan.route, plan.id], dispatch, wireRows),
        media: (dispatch) =>
          read(
            'media',
            media,
            mediaPlan && mediaParameters(mediaPlan),
            () => dispatch(bounded),
            (value) => (value === null ? [] : [value]),
            (value) => {
              if (value === null) return 1;
              if (mediaPlan?.kind === 'realm')
                return (value as { variants_json: string }).variants_json === '[]' ? 1 : 0;
              return (value as { variant_key: string | null }).variant_key === null ? 1 : 0;
            },
          ),
        ancestor: (input, dispatch) => {
          const node = ancestors[ancestorIndex];
          // Changed ancestry cannot expand this invocation into unadmitted IO.
          // The unchanged native walker still validates kind, routes and cycles.
          if (
            bounded &&
            (!node || input.route !== node.input.route || input.id !== node.input.id || input.kind !== node.input.kind)
          )
            throw new TypeError('Media eligibility ancestry changed before dispatch');
          return read(
            `ancestor:${ancestorIndex++}`,
            node?.work,
            [input.route, input.id, input.kind],
            dispatch,
            wireRows,
          );
        },
      });
      if (bounded && cover) {
        if (!dispatched.has('subject')) throw new TypeError('Missing cover subject existence dispatch');
        const receipt = cover.access.actual(context);
        if (!receipt) throw new AccessWorkUnavailableError(COVER_MEDIA_WORK_DEPENDENCY);
        spent = sum(spent, receipt);
      }
      if (bounded && ((plan && !dispatched.has('parent')) || (mediaPlan && !dispatched.has('media'))))
        throw new TypeError('Missing media eligibility native dispatch');
      if (bounded) verified.set(context, { result, work: spent });
      return result;
    },
  };
}
