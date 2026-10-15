import { t } from 'elysia';
import type { TSchema, TUnion } from 'typebox';
import type { ExposureDeclaration } from './modules/access/exposure.ts';

/** Transport variants stay literal even beside an owner's wider domain schema. */
export function transportProblem<const Status extends number, const Code extends string>(status: Status, code: Code) {
  return t.Object({ type: t.String(), title: t.String(), status: t.Literal(status),
    code: t.Literal(code) }, { additionalProperties: false });
}

const invalid = transportProblem(400, 'invalid_request');
const internal = transportProblem(500, 'internal_error');
const typesUnavailable = transportProblem(503, 'types_unavailable');
const invalidAssertion = transportProblem(401, 'invalid_account_assertion');
const authentication = t.Union([transportProblem(401, 'unauthorized'), invalidAssertion]);
const closed = transportProblem(403, 'platform_closed');
const hidden = transportProblem(404, 'appeal_unavailable');
const platformUnavailable = transportProblem(503, 'platform_access_unavailable');
const budgetUnavailable = transportProblem(503, 'rate_limit_unavailable');
const limited = t.Object({ ...transportProblem(429, 'rate_limited').properties,
  family: t.Union(['write', 'upload', 'report', 'correspondence', 'search', 'provider', 'address']
    .map(value => t.Literal(value))) }, { additionalProperties: false });
const keyInvalid = transportProblem(400, 'invalid_idempotency_key');
const keyConflict = transportProblem(409, 'idempotency_conflict');

type Common = { 400: typeof invalid; 500: typeof internal };
type Budget<M> = M extends { rateLimitFamily: infer F }
  ? F extends 'read' ? {} : { 429: typeof limited; 503: typeof budgetUnavailable }
    & (F extends 'report' | 'correspondence' | 'provider' ? {} : { 401: typeof invalidAssertion })
  : {};
type Authentication<M, Hidden> = M extends { bearer: true | 'optional' }
  ? { 401: Hidden extends true ? typeof invalidAssertion : typeof authentication } : {};
type Exposure<M, Hidden> = M extends { exposure: 'public' } ? {}
  : { 503: typeof platformUnavailable }
    & (Hidden extends true ? { 401: typeof invalidAssertion; 404: typeof hidden }
      : { 401: typeof authentication; 403: typeof closed });
type Idempotency<M> = M extends { idempotencyKey: true }
  ? { 400: typeof keyInvalid; 409: typeof keyConflict } : {};

// Intersections of response maps would intersect incompatible literal codes.
// Combine schema alternatives at the shared status instead.
type Merge<A, B> = { [S in keyof A | keyof B as S extends `${infer N extends number}` ? N : S]: S extends keyof A
  ? S extends keyof B ? A[S] extends TSchema ? B[S] extends TSchema
    ? TUnion<[A[S], B[S]]> : A[S] : never : A[S]
  : S extends keyof B ? B[S] : never };
type Policies<M, Method, Hidden> = Merge<Merge<Merge<Merge<Common, Budget<M>>,
  Authentication<M, Hidden>>, Exposure<M, Hidden>>, Merge<Idempotency<M>,
  Method extends 'GET' | 'HEAD' ? {} : { 503: typeof typesUnavailable }>>;

/** Route-owned metadata feeds runtime validation, OpenAPI and Eden together.
 * This declares existing hooks; it grants no authority and changes no hook. */
export function transportResponses<const M extends ExposureDeclaration,
  const R extends Record<number, TSchema>, const Method extends string,
  const Hidden extends boolean = false>(metadata: M, responses: R, method: Method,
  hideExistence: Hidden = false as Hidden): Merge<R, Policies<M, Method, Hidden>> {
  const result: Record<number, TSchema> = { ...responses };
  const add = (status: number, schema: TSchema) => {
    result[status] = result[status] ? t.Union([result[status], schema]) : schema;
  };
  add(400, invalid);
  add(500, internal);
  if (method !== 'GET' && method !== 'HEAD') add(503, typesUnavailable);
  const family = metadata.rateLimitFamily;
  if (family && family !== 'read') {
    add(429, limited);
    add(503, budgetUnavailable);
    if (!['report', 'correspondence', 'provider'].includes(family)) add(401, invalidAssertion);
  }
  if (metadata.bearer === true || metadata.bearer === 'optional') add(401, hideExistence ? invalidAssertion : authentication);
  if (metadata.exposure !== 'public') {
    add(503, platformUnavailable);
    // Invalid bearers retain today's 401 even on an existence-hidden read.
    add(401, hideExistence ? invalidAssertion : authentication);
    add(hideExistence ? 404 : 403, hideExistence ? hidden : closed);
  }
  if (metadata.idempotencyKey) {
    add(400, keyInvalid);
    add(409, keyConflict);
  }
  return result as Merge<R, Policies<M, Method, Hidden>>;
}
