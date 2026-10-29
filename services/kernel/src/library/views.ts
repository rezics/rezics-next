import { t } from 'elysia';
import type { Pool } from 'pg';
import type { TObject, TProperties } from 'typebox';
import { readAccount, readPublicAccount } from '../access/account-data.ts';
import type { KernelClock } from '../clock.ts';
import { readSpace } from '../community/space.ts';
import { createResourcePublicEligibility } from '../access/public-eligibility.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { SubjectSummarySchema } from '../semantic/http/summaries.ts';
import type { SubjectSummary } from '../semantic/summaries.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { readSubject } from '../semantic/subject.ts';
import { relatedReadEligibility, subjectReadEligibility } from '../semantic/eligibility.ts';
import { SubjectRedirectError } from '../semantic/merges.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createCollectionReads } from './collection-reads.ts';
import collectionRead from './collection-reads-collection.sql';
import memberPage from './collection-reads-members.sql';
import { isOrdinalKey } from './ordinal.ts';
import { WORK_STEP_DEADLINE_MS } from './command-support.ts';

export const viewQuery = { view: t.Optional(t.Union([t.Literal('BASIC'), t.Literal('FULL')])) };
const nullableText = t.Union([t.String(), t.Null()]);
const summarySchema = t.Union([
  SubjectSummarySchema,
  t.Object({ id: t.String(), type: t.String(), label: t.String() }, { additionalProperties: false }),
  t.Null(),
]);
const accountSchema = t.Union([
  t.Object({ id: t.String(), handle: nullableText, displayName: nullableText }, { additionalProperties: false }),
  t.Null(),
]);
export const subjectFields = { subject: t.Optional(summarySchema) };
export const sessionFields = { ...subjectFields, versionSubject: t.Optional(summarySchema) };
export const curatorFields = { curator: t.Optional(accountSchema) };
export const logFields = { ...subjectFields, account: t.Optional(accountSchema) };
export const targetFields = { target: t.Optional(summarySchema) };
export function embedded<S extends TProperties, F extends TProperties>(schema: TObject<S>, fields: F) {
  return t.Object({ ...schema.properties, ...fields }, { additionalProperties: false });
}
export function basicQuery<Q extends { view?: string }>({ view: _view, ...query }: Q) {
  return query;
}

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock };
type Summary = SubjectSummary | { id: string; label: string; type: string };
type AccountSummary = { id: string; handle: string | null; displayName: string | null };
type Embedding<T> = T extends readonly (infer R)[]
  ? Embedding<R>[]
  : T extends object
    ? { [K in keyof T]: Embedding<T[K]> } & (T extends { subjectId: string } ? { subject?: Summary | null } : object) &
        (T extends { versionSubjectId: string | null } ? { versionSubject?: Summary | null } : object) &
        (T extends { curatorAccountId: string } ? { curator?: AccountSummary | null } : object) &
        (T extends { accountId: string } ? { account?: AccountSummary | null } : object) &
        (T extends { targetId: string } ? { target?: Summary | null } : object)
    : T;

/** A request owns its caches and four workers; failures settle before releasing the request. */
async function bounded<T>(values: readonly T[], work: (value: T) => Promise<void>) {
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, values.length) }, async () => {
      while (next < values.length) await work(values[next++]!);
    }),
  );
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

class ViewReader {
  readonly subjects = new Map<string, Summary | null>();
  readonly accounts = new Map<string, AccountSummary | null>();
  readonly targets = new Map<string, Summary | null>();
  constructor(
    readonly deps: Dependencies,
    readonly actor: Actor,
  ) {}

  async subject(id: string): Promise<Summary | null> {
    const { pool, access } = this.deps;
    const actor = this.actor;
    async function readAnchor(anchorId: string) {
      const route = routeOf(anchorId);
      if (route === null) return null;
      const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
      const resource = {
        route,
        id: anchorId,
        eligibility: subjectReadEligibility({ route, id: anchorId }),
      };
      const check = await accessCheck(access, actor, 'subject:read', resource, { pool, deadline });
      return readSubject(pool, anchorId, (client) => check(client), GLOBAL_CONTEXT, undefined, {
        prepareAuthorization: () => accessCheck(access, actor, 'subject:read', resource, { pool, deadline }),
        async authorize(client, id, batch) {
          const route = routeOf(id);
          if (route === null) return false;
          const check = await accessCheck(
            access,
            actor,
            'subject:read',
            { route, id, eligibility: relatedReadEligibility({ route, id }, batch) },
            { pool, deadline: deadlineFor(WORK_STEP_DEADLINE_MS) },
          );
          return check(client);
        },
      });
    }

    let result: Awaited<ReturnType<typeof readSubject>>;
    try {
      result = await readAnchor(id);
    } catch (error) {
      if (!(error instanceof SubjectRedirectError)) throw error;
      if (error.from !== id) return null;
      try {
        result = await readAnchor(error.to);
      } catch (survivorError) {
        if (survivorError instanceof SubjectRedirectError) return null;
        throw survivorError;
      }
    }
    if (!result) return null;
    return result.summary;
  }

  async account(id: string): Promise<AccountSummary | null> {
    const route = routeOf(id);
    if (route === null) return null;
    const value = await withConnection(this.deps.pool, (client) => readPublicAccount(client, route, id));
    return value && value.state !== 'deleted' && 'handle' in value
      ? { id: value.accountId, handle: value.handle, displayName: value.displayName }
      : null;
  }

  async target(id: string, type: string): Promise<Summary | null> {
    if (type === 'subject') return this.subjects.get(id) ?? null;
    const { pool, access } = this.deps;
    if (type === 'collection') {
      try {
        const value = await createCollectionReads(this.deps).readCollection(this.actor, id);
        return { id, type, label: value.title };
      } catch (error) {
        if (error instanceof ProblemError && error.code === 'not_found') return null;
        throw error;
      }
    }
    const route = routeOf(id);
    if (route === null) return null;
    const identity = { route, id };
    const sink: { value: Awaited<ReturnType<typeof readSpace>> } = { value: null };
    const eligibility = createResourcePublicEligibility({
      resource: identity,
      action: 'space:read',
      async prepare() {
        return { ready: true };
      },
      async verify({ client, at }) {
        sink.value = await readSpace(client, id, at);
        return sink.value !== null;
      },
    });
    const check = await accessCheck(
      access,
      this.actor,
      'space:read',
      {
        ...identity,
        eligibility,
      },
      { pool, deadline: deadlineFor(WORK_STEP_DEADLINE_MS) },
    );
    return withConnection(pool, async (client) => {
      if (!(await check(client))) return null;
      const value = sink.value;
      return value ? { id, type, label: value.title } : null;
    });
  }
}

/** FULL adds only public summaries. BASIC returns the original object without an extra read. */
export async function fullView<T>(
  deps: Dependencies,
  actor: Actor,
  view: string | undefined,
  body: T,
): Promise<Embedding<T>> {
  if (view !== 'FULL') return body as Embedding<T>;
  const reader = new ViewReader(deps, actor);
  const rows = Object.values(body as Record<string, unknown>).flatMap((value) =>
    Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [],
  ) as Record<string, unknown>[];
  const subjectIds = new Set<string>(),
    accountIds = new Set<string>();
  const targets = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.subjectId === 'string') subjectIds.add(row.subjectId);
    if (typeof row.versionSubjectId === 'string') subjectIds.add(row.versionSubjectId);
    for (const key of ['curatorAccountId', 'accountId']) if (typeof row[key] === 'string') accountIds.add(row[key]);
    if (typeof row.targetId === 'string' && typeof row.targetType === 'string') {
      if (row.targetType === 'subject') subjectIds.add(row.targetId);
      else targets.set(row.targetId, row.targetType);
    }
  }
  await bounded([...subjectIds], async (id) => {
    reader.subjects.set(id, await reader.subject(id));
  });
  await bounded([...accountIds], async (id) => {
    reader.accounts.set(id, await reader.account(id));
  });
  await bounded([...targets], async ([id, type]) => {
    reader.targets.set(id, await reader.target(id, type));
  });
  const enrich = (row: Record<string, unknown>) => ({
    ...row,
    ...(typeof row.subjectId === 'string' ? { subject: reader.subjects.get(row.subjectId) ?? null } : {}),
    ...(typeof row.versionSubjectId === 'string'
      ? { versionSubject: reader.subjects.get(row.versionSubjectId) ?? null }
      : {}),
    ...(typeof row.curatorAccountId === 'string' ? { curator: reader.accounts.get(row.curatorAccountId) ?? null } : {}),
    ...(typeof row.accountId === 'string' ? { account: reader.accounts.get(row.accountId) ?? null } : {}),
    ...(typeof row.targetId === 'string'
      ? { target: (row.targetType === 'subject' ? reader.subjects : reader.targets).get(row.targetId) ?? null }
      : {}),
  });
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((row) => (row && typeof row === 'object' ? enrich(row) : row))
        : value && typeof value === 'object'
          ? enrich(value as Record<string, unknown>)
          : value,
    ]),
  ) as Embedding<T>;
}

/** FULL members use the same cursor and anchored checks, retaining the readability result's label. */
export async function fullMembers(
  deps: Dependencies,
  actor: Actor,
  collectionId: string,
  options: { cursor?: string; limit?: number },
) {
  const route = routeOf(collectionId);
  if (route === null) throw new ProblemError('not_found');
  const sink: { seen: boolean; row: Awaited<ReturnType<typeof collectionRead.run>> } = { seen: false, row: null };
  const identity = { route, id: collectionId };
  const check = await accessCheck(
    deps.access,
    actor,
    'collection:read',
    {
      ...identity,
      eligibility: createResourcePublicEligibility({
        resource: identity,
        action: 'collection:read',
        async prepare() {
          return { ready: true };
        },
        async verify({ client }) {
          sink.row = await collectionRead.run(client, identity);
          sink.seen = true;
          return sink.row !== null && sink.row.state === 'active' && sink.row.visibility !== 'private';
        },
      }),
    },
    { pool: deps.pool, deadline: deadlineFor(WORK_STEP_DEADLINE_MS) },
  );
  const binding = { operation: 'library.collection.members', parameters: { collectionId } };
  const limit = options.limit ?? 20;
  const page = await withConnection(deps.pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const viewer =
        actor.kind === 'account' && routeOf(actor.accountId) !== null
          ? await readAccount(client, routeOf(actor.accountId)!, actor.accountId)
          : null;
      const allowed = await check(client);
      if (!sink.seen) sink.row = await collectionRead.run(client, identity);
      const collection = sink.row;
      if (!collection || collection.state !== 'active') throw new ProblemError('not_found');
      // Match Collection reads: public/unlisted disclosure is independent of the private grant branch.
      if (
        collection.visibility === 'private' &&
        !(
          allowed &&
          actor.kind === 'account' &&
          viewer &&
          viewer.route === routeOf(actor.accountId) &&
          viewer.accountId === actor.accountId &&
          viewer.kind === 'actor' &&
          viewer.state === 'active' &&
          !viewer.fenced &&
          Number.isSafeInteger(actor.authnEpoch) &&
          actor.authnEpoch > 0 &&
          BigInt(actor.authnEpoch) >= viewer.minimumAuthnEpoch &&
          actor.scopes.includes('collection:read')
        )
      )
        throw new ProblemError('not_found');
      let after: { ordinalKey: string; memberId: string } | null = null;
      if (options.cursor !== undefined) {
        const cursor = decodeCursor(deps.tokens, binding, options.cursor);
        if (
          !cursor.ok ||
          cursor.after.length !== 2 ||
          typeof cursor.after[0] !== 'string' ||
          !isOrdinalKey(cursor.after[0]) ||
          typeof cursor.after[1] !== 'string' ||
          routeOf(cursor.after[1]) !== route
        )
          throw new ProblemError('invalid_cursor');
        if (cursor.epoch !== collection.orderEpoch + 1) throw new ProblemError('stale_cursor');
        after = { ordinalKey: cursor.after[0], memberId: cursor.after[1] };
      }
      const rows = await memberPage.run(client, {
        route,
        collection_id: collectionId,
        after_ordinal_key: after?.ordinalKey ?? null,
        after_member_id: after?.memberId ?? null,
        limit: limit + 1,
      });
      await client.query('COMMIT');
      return { rows, epoch: collection.orderEpoch + 1 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  const considered = page.rows.slice(0, limit);
  const reader = new ViewReader(deps, actor);
  await bounded([...new Set(considered.map((row) => row.subjectId))], async (id) => {
    reader.subjects.set(id, await reader.subject(id));
  });
  const last = considered.at(-1);
  return {
    members: considered.flatMap((row) => {
      const subject = reader.subjects.get(row.subjectId);
      return subject
        ? [
            {
              id: row.id,
              subjectId: row.subjectId,
              note: row.note,
              addedAt: new Date(row.addedAt).toISOString(),
              subject,
            },
          ]
        : [];
    }),
    next:
      page.rows.length > limit && last
        ? encodeCursor(deps.tokens, binding, { epoch: page.epoch, after: [last.ordinalKey, last.id] })
        : null,
  };
}
