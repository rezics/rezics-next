import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { resourceAuthorization } from '../access/index.ts';
import { accessCommandAttempt } from '../access/command-admission.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { deriveAccess } from '../access/derived-access.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  mintReadTime,
  runCommand,
  type AuthoritativeTime,
} from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type AccessCheck, type AccessClient, type Actor, type Resource } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { SpaceDependencies } from './space.ts';
import { realmReadEligibility } from './realm.ts';
import { readContainerBinding, revalidateContainerBinding } from './container-lifecycle.ts';
import { realmGovernanceAuthorization } from './realm-continuity.ts';
import realmActive from './publication-realm.sql';
import insertRecord from './publication-insert.sql';
import insertHead from './publication-head-insert.sql';
import moveHead from './publication-head-move.sql';
import pageHeads from './publication-page.sql';
import readHead from './publication-read.sql';

export type PublicationDependencies = SpaceDependencies;
export type PublicationContext = Readonly<{ idempotencyKey: string; deadline: number }>;
export type PublicationReadContext = Readonly<{ actor: Actor; deadline: number }>;
export type PublicationInput = Readonly<{ realmId: string; subjectId: string; expectedHead?: string }>;
export type PublicationVerdict = 'adopt' | 'reject' | 'withdraw';
export type PublicationResult = Readonly<{
  publicationId: string;
  realmId: string;
  subjectId: string;
  verdict: PublicationVerdict;
  predecessor: string | null;
  /** Semantic subject point reads expose no revision id, so this stays null. */
  subjectRevisionId: null;
  publishedAt: string;
}>;
export type PublicationHead = Readonly<{
  realmId: string;
  subjectId: string;
  publicationId: string;
  verdict: 'adopt';
  subjectRevisionId: null;
  publishedAt: string;
}>;
export type PublicationPage = Readonly<{ items: readonly PublicationHead[]; next: string | null }>;
export type PublicationQuery = Readonly<{ cursor?: string; limit?: number }>;
/** Trusted composition handle. The raw window and its cursor are selected once;
 * current() checks those exact heads without selecting another window.
 */
export type PublicationSelection = Readonly<{
  page: PublicationPage;
  current: () => Promise<boolean>;
}>;

const PAGE = { default: 20, max: 100 } as const;
const LIST = 'community.publication.list';
const FIRST_AT = 'infinity';
const FIRST_SUBJECT = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const PUBLISHED_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

type Statement = { sql: string; params: readonly string[]; '~reylo': { input: object; element: object } };
type PageRow = { subjectId: string; publicationId: string; publishedAt: string };
type HeadRow = { publicationId: string; publishedAt: string };

export class PublicationConflictError extends Error {
  constructor() {
    super('Publication head has changed');
    this.name = 'PublicationConflictError';
  }
}
export class PublicationOccupiedSlotError extends PublicationConflictError {
  constructor() {
    super();
    this.message = 'Publication slot is already occupied';
    this.name = 'PublicationOccupiedSlotError';
  }
}
export class PublicationInputError extends Error {
  constructor() {
    super('Invalid publication identity');
    this.name = 'PublicationInputError';
  }
}
export class PublicationCursorError extends Error {
  readonly reason: 'expired' | 'invalid' | 'stale';
  constructor(reason: 'expired' | 'invalid' | 'stale') {
    super(`Publication cursor is ${reason}`);
    this.name = 'PublicationCursorError';
    this.reason = reason;
  }
}

function account(actor: Actor) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  return actor;
}
function postgresCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
function ring(routeKey: Uint8Array): KeyRing {
  if (routeKey.byteLength < 32) throw new PublicationInputError();
  return { current: 1, keys: new Map([[1, routeKey]]) };
}
function open(deadline: number): boolean {
  return Number.isFinite(deadline) && Date.now() < deadline;
}
async function rows<S extends Statement>(client: AccessClient, statement: S, input: S['~reylo']['input']) {
  const values = statement.params.map((name) => input[name as keyof typeof input]);
  const result = await client.query<S['~reylo']['element']>(statement.sql, values);
  return result.rows;
}
async function snapshot<T>(
  pool: PublicationDependencies['pool'],
  deadline: number,
  work: (client: AccessClient) => Promise<T>,
) {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("SET LOCAL statement_timeout = '3000ms'");
      const value = await work(deadlineClient(client, deadline));
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}

/** Subject evidence is prepared before the snapshot. A held pool connection cannot
 * prepare another check: withConnection refuses a nested checkout.
 */
function subjectResource(subjectId: string): Resource {
  const route = routeOf(subjectId);
  if (route === null) throw new PublicationInputError();
  const identity = { route, id: subjectId };
  return { ...identity, eligibility: subjectReadEligibility(identity) };
}
async function prepareSubject(deps: PublicationDependencies, actor: Actor, subjectId: string, deadline: number) {
  return accessCheck(deps.access, actor, 'subject:read', subjectResource(subjectId), {
    pool: deps.pool,
    deadline,
  });
}
async function prepareRealm(deps: PublicationDependencies, actor: Actor, realmId: string, deadline: number) {
  const route = routeOf(realmId);
  if (route === null) return null;
  const identity = { route, id: realmId };
  return accessCheck(
    deps.access,
    actor,
    'realm:read',
    { ...identity, eligibility: realmReadEligibility(identity) },
    { pool: deps.pool, deadline },
  );
}

function view(realmId: string, subjectId: string, publicationId: string, publishedAt: string): PublicationHead {
  return { realmId, subjectId, publicationId, verdict: 'adopt', subjectRevisionId: null, publishedAt };
}

async function page(
  client: AccessClient,
  route: number,
  realmId: string,
  afterAt: string,
  afterSubject: string,
  limit: number,
) {
  return rows(client, pageHeads, {
    route,
    realm: realmId,
    after_at: afterAt,
    after_subject: afterSubject,
    limit,
  });
}

export async function publish(
  deps: PublicationDependencies,
  actor: Actor,
  input: PublicationInput,
  context: PublicationContext,
) {
  return decide(deps, actor, input, context, 'adopt');
}
export async function withdraw(
  deps: PublicationDependencies,
  actor: Actor,
  input: PublicationInput,
  context: PublicationContext,
) {
  return decide(deps, actor, input, context, 'withdraw');
}
export async function reject(
  deps: PublicationDependencies,
  actor: Actor,
  input: PublicationInput,
  context: PublicationContext,
) {
  return decide(deps, actor, input, context, 'reject');
}

function decide(
  deps: PublicationDependencies,
  actor: Actor,
  input: PublicationInput,
  context: PublicationContext,
  verdict: PublicationVerdict,
) {
  const author = account(actor);
  if (!open(context.deadline)) throw new GrantDeniedError();
  const realmRoute = routeOf(input.realmId);
  const subjectRoute = routeOf(input.subjectId);
  if (realmRoute === null || subjectRoute === null) throw new PublicationInputError();
  const expected = input.expectedHead === undefined ? null : input.expectedHead;
  if (expected !== null && routeOf(expected) !== realmRoute) throw new PublicationInputError();
  const body = {
    realmId: input.realmId,
    subjectId: input.subjectId,
    expectedHead: expected,
    verdict,
  };
  const publicationId = newId(realmRoute);
  const subject = subjectResource(input.subjectId);
  const checks = new WeakMap<AuthoritativeTime, AccessCheck>();
  const wrapped = deriveAccess(deps.access, {
    async prepare(preparedActor, action, resource, preparedContext) {
      const attempt = accessCommandAttempt(preparedContext);
      if (!attempt) throw new GrantDeniedError();
      const primary = await deps.access.prepare?.(preparedActor, action, resource, preparedContext);
      // The same live attempt caches one admission for the Realm and the subject.
      checks.set(attempt.time, await accessCheck(deps.access, preparedActor, 'subject:read', subject, preparedContext));
      return primary;
    },
  });
  const authorization = resourceAuthorization({
    access: wrapped,
    actor,
    action: 'realm:publish',
    anchor: {
      resource: { route: realmRoute, id: input.realmId },
      async validate(client, time) {
        const row = await realmActive.run(client, {
          route: realmRoute,
          id: input.realmId,
          at: authoritativeTimeValue(time),
        });
        const subjectCheck = checks.get(time);
        return !!row && !!subjectCheck && subjectCheck(client, time);
      },
    },
    context: { pool: deps.pool, deadline: context.deadline, partition: partitionOf(realmRoute) },
  });
  const identity = principalCommandIdentity(author);
  return runCommand(
    deps.pool,
    {
      ...identity,
      partition: partitionOf(realmRoute),
      deadline: context.deadline,
      clock: deps.clock,
      receipt: {
        kind: `community.publication.${verdict === 'adopt' ? 'publish' : verdict}`,
        key: context.idempotencyKey,
        digest: createHash('sha256')
          .update(canonicalize([identity, verdict, body])!)
          .digest(),
      },
      authorization: realmGovernanceAuthorization(authorization, { route: realmRoute, id: input.realmId }),
    },
    async (tx, command) => {
      const at = authoritativeTimeValue(command.time);
      const value: PublicationResult = {
        publicationId,
        realmId: input.realmId,
        subjectId: input.subjectId,
        verdict,
        predecessor: expected,
        subjectRevisionId: null,
        publishedAt: at,
      };
      try {
        await insertRecord.run(tx, {
          route: realmRoute,
          publication: publicationId,
          realm: input.realmId,
          subject: input.subjectId,
          verdict,
          predecessor: expected,
          actor: author.accountId,
          at,
        });
      } catch (error) {
        if (postgresCode(error) === '23503') throw new PublicationConflictError();
        throw error;
      }
      const moved = expected
        ? await moveHead.run(tx, {
            route: realmRoute,
            realm: input.realmId,
            subject: input.subjectId,
            publication: publicationId,
            verdict,
            expected,
            at,
          })
        : await insertHead.run(tx, {
            route: realmRoute,
            realm: input.realmId,
            subject: input.subjectId,
            publication: publicationId,
            verdict,
            at,
          });
      if (!moved) {
        if (expected === null) throw new PublicationOccupiedSlotError();
        throw new PublicationConflictError();
      }
      const event =
        verdict === 'adopt'
          ? 'com.rezics.community.publication.adopted.v1'
          : verdict === 'withdraw'
            ? 'com.rezics.community.publication.withdrawn.v1'
            : 'com.rezics.community.publication.rejected.v1';
      return { value, events: [{ type: event, subject: input.realmId, data: value }] };
    },
  );
}

export async function readPublication(
  deps: PublicationDependencies,
  realmId: string,
  subjectId: string,
  context: PublicationReadContext,
): Promise<PublicationHead | null> {
  const route = routeOf(realmId);
  if (route === null || routeOf(subjectId) === null || !open(context.deadline)) return null;
  const realmCheck = await prepareRealm(deps, context.actor, realmId, context.deadline);
  if (!realmCheck) return null;
  const before = await withConnection(deps.pool, async (client) => {
    const bounded = deadlineClient(client, context.deadline);
    const at = await mintReadTime(bounded, deps.clock);
    return readContainerBinding(bounded, { realmId, subjectId, at });
  });
  if (!before || before.publicationId === null) return null;
  const subjectCheck = await prepareSubject(deps, context.actor, subjectId, context.deadline);
  const result = await snapshot(deps.pool, context.deadline, async (client) => {
    if (!(await realmCheck(client))) return null;
    const head = await readHead.run(client, { route, realm: realmId, subject: subjectId });
    if (!head?.publishedAt || !(await subjectCheck(client))) return null;
    return view(realmId, subjectId, head.publicationId, head.publishedAt);
  });
  if (!result || result.publicationId !== before.publicationId) return null;
  // The earlier repeatable-read snapshot is released before the current disclosure fence.
  return withConnection(deps.pool, async (client) => {
    const bounded = deadlineClient(client, context.deadline);
    const at = await mintReadTime(bounded, deps.clock);
    if (!(await realmCheck(bounded, at)) || !(await revalidateContainerBinding(bounded, before, at))) return null;
    return result;
  });
}

export async function listPublications(
  deps: PublicationDependencies,
  realmId: string,
  context: PublicationReadContext,
  query: PublicationQuery = {},
): Promise<PublicationPage | null> {
  const selection = await preparePublicationPage(deps, realmId, context, query);
  return selection && (await selection.current()) ? selection.page : null;
}

/** Release the origin connection before a consumer hydrates selected Subjects.
 * The consumer must call current() after hydration and withhold the entire
 * observation when it fails. A replacement head cannot reuse the old summary.
 */
export async function preparePublicationPage(
  deps: PublicationDependencies,
  realmId: string,
  context: PublicationReadContext,
  query: PublicationQuery = {},
): Promise<PublicationSelection | null> {
  const route = routeOf(realmId);
  if (route === null || !open(context.deadline)) return null;
  const limit = query.limit === undefined ? PAGE.default : query.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE.max) throw new RangeError('Page limit must be 1 to 100');
  const binding: CursorBinding = {
    operation: LIST,
    parameters: {
      realmId,
      limit,
      viewer: context.actor.kind === 'account' ? context.actor.accountId : 'anonymous',
    },
  };
  let afterAt = FIRST_AT;
  let afterSubject = FIRST_SUBJECT;
  let cursorEpoch: number | null = null;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(ring(deps.routeKey), binding, query.cursor);
    if (!decoded.ok) throw new PublicationCursorError(decoded.reason);
    const [at, subject] = decoded.after;
    if (
      decoded.after.length !== 2 ||
      typeof at !== 'string' ||
      typeof subject !== 'string' ||
      !PUBLISHED_AT.test(at) ||
      routeOf(subject) === null
    )
      throw new PublicationCursorError('invalid');
    afterAt = at;
    afterSubject = subject;
    cursorEpoch = decoded.epoch;
  }
  const realmCheck = await prepareRealm(deps, context.actor, realmId, context.deadline);
  if (!realmCheck) return null;
  const before = await withConnection(deps.pool, async (client) => {
    const bounded = deadlineClient(client, context.deadline);
    const at = await mintReadTime(bounded, deps.clock);
    return readContainerBinding(bounded, { realmId, at });
  });
  if (!before) return null;
  // One keyset seek chooses the window. Disclosure then revalidates each head at T.
  const fetched = await withConnection(deps.pool, (client) =>
    within(context.deadline, () =>
      page(deadlineClient(client, context.deadline), route, realmId, afterAt, afterSubject, limit + 1),
    ),
  );
  const window = (fetched as PageRow[]).slice(0, limit);
  const more = fetched.length > limit;
  const subjects = new Map<string, AccessCheck>();
  for (const row of window)
    subjects.set(row.subjectId, await prepareSubject(deps, context.actor, row.subjectId, context.deadline));
  const result = await snapshot(deps.pool, context.deadline, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    if (!partition || !(await realmCheck(client))) return null;
    if (cursorEpoch !== null && cursorEpoch !== partition.epoch) throw new PublicationCursorError('stale');
    const items: PublicationHead[] = [];
    for (const row of window) {
      const head = (await readHead.run(client, { route, realm: realmId, subject: row.subjectId })) as HeadRow | null;
      const subjectCheck = subjects.get(row.subjectId);
      if (!head || head.publicationId !== row.publicationId || !subjectCheck || !(await subjectCheck(client))) continue;
      items.push(view(realmId, row.subjectId, head.publicationId, head.publishedAt));
    }
    const last = window.at(-1);
    const next =
      more && last
        ? encodeCursor(ring(deps.routeKey), binding, {
            epoch: partition.epoch,
            after: [last.publishedAt, last.subjectId],
          })
        : null;
    return { items, next };
  });
  if (!result) return null;
  return {
    page: result,
    async current() {
      // Preparation can address other homes. Never perform it while holding
      // the publication connection, including with a one-connection pool.
      const finalRealm = await prepareRealm(deps, context.actor, realmId, context.deadline);
      if (!finalRealm) return false;
      const finalSubjects = new Map<string, AccessCheck>();
      for (const item of result.items)
        finalSubjects.set(item.subjectId, await prepareSubject(deps, context.actor, item.subjectId, context.deadline));
      return withConnection(deps.pool, async (client) => {
        const bounded = deadlineClient(client, context.deadline);
        const at = await mintReadTime(bounded, deps.clock);
        // Exact selected keys, never a second page or a publication-history scan.
        for (const item of result.items) {
          const head = await readHead.run(bounded, { route, realm: realmId, subject: item.subjectId });
          if (head?.publicationId !== item.publicationId || !(await finalSubjects.get(item.subjectId)!(bounded, at)))
            return false;
        }
        return (await finalRealm(bounded, at)) && (await revalidateContainerBinding(bounded, before, at));
      });
    },
  };
}
