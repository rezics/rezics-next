import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { t, type Context } from 'elysia';
import type { Admission, JobContext } from '../http/admission.ts';
import type { Static } from 'typebox';
import type { Pool } from 'pg';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { createApp } from '../http/app.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { customMethod } from '../http/custom-method.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { idempotencyKeyOf } from '../http/request.ts';
import { registerEventTypes } from '../events/catalogue.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import { strictContentSchema } from '../content/schemas.ts';
import { recentSearchDestination } from './recent-search-destination.ts';
import { CoverSummarySchema } from '../semantic/http/summaries.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const revisionMax = 2147483646;
const revision = t.Integer({ minimum: 0, maximum: revisionMax });
const recentScopeSchema = t.Union([
  t.Object({ kind: t.Literal('realm'), id }, closed),
  t.Object({ kind: t.Literal('collection'), id }, closed),
  t.Object({ kind: t.Literal('route'), route: t.Literal('library') }, closed),
]);
export const recentEntrySchema = t.Union([
  t.Object(
    {
      kind: t.Literal('query'),
      text: t.String({ minLength: 1, maxLength: 256 }),
      languages: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 35 }), { maxItems: 8 })),
      scope: t.Optional(recentScopeSchema),
    },
    closed,
  ),
  t.Object(
    {
      kind: t.Literal('scope'),
      scope: recentScopeSchema,
    },
    closed,
  ),
]);
export type RecentEntry = Static<typeof recentEntrySchema>;
export type RecentDependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  routeKey: Uint8Array;
  clock?: () => Date;
};
const stamp = t.Object({ id, lastUsed: t.String(), revision }, closed);
const item = t.Object(
  {
    ...stamp.properties,
    entry: recentEntrySchema,
    display: t.Union([t.Object({ name: t.String(), href: t.String(), avatar: CoverSummarySchema }, closed), t.Null()]),
  },
  closed,
);
export type RecentSearch = Static<typeof item>;
export const RECENT_CHANGED = 'com.rezics.search.recent-changed.v1';
registerEventTypes({ [RECENT_CHANGED]: t.Object({ accountId: id }, closed) });
export const RECENT_DAYS = 90;
const operation = 'GET /v1/recentSearches';
const hash = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
function owner(actor: Actor): AccountActor {
  if (actor.kind !== 'account') throw new ProblemError('authentication_required');
  if (routeOf(actor.accountId) === null) throw new ProblemError('forbidden');
  return actor;
}
function keys(actor: AccountActor) {
  const route = routeOf(actor.accountId)!;
  return [partitionOf(route), route, actor.accountId];
}
function admitted(entry: RecentEntry): RecentEntry {
  if (entry.scope && entry.scope.kind !== 'route' && routeOf(entry.scope.id) === null)
    throw new ProblemError('invalid_request');
  if (entry.kind === 'query') {
    const text = entry.text.trim();
    if (
      !text ||
      text.includes('\0') ||
      entry.languages?.some((tag) => !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag))
    )
      throw new ProblemError('invalid_request');
    return {
      kind: 'query',
      text,
      ...(entry.languages ? { languages: [...new Set(entry.languages)] } : {}),
      ...(entry.scope ? { scope: entry.scope } : {}),
    };
  }
  if (entry.scope.kind !== 'route' && routeOf(entry.scope.id) === null) throw new ProblemError('invalid_request');
  return entry;
}
/** No retained labels or URLs: each bounded page uses the current native owner reads. */
export async function recentDisplay(
  d: RecentDependencies,
  actor: AccountActor,
  entry: RecentEntry,
  deadline: number,
): Promise<RecentSearch['display']> {
  if (entry.kind === 'query') {
    const href = recentSearchDestination(entry);
    if (!entry.scope) return href ? { name: entry.text, href, avatar: null } : null;
    const display = await recentDisplay(d, actor, { kind: 'scope', scope: entry.scope }, deadline);
    return display && href ? { ...display, href } : null;
  }
  if (entry.scope.kind === 'route') return { name: 'Library', href: '/library', avatar: null };
  if (entry.scope.kind === 'realm') {
    const { readRealm } = await import('../community/realm.ts');
    const realm = await readRealm(d, actor, entry.scope.id, { deadline });
    return realm && realm.state === 'active'
      ? { name: realm.title, href: `/realms/${realm.realmId}`, avatar: null }
      : null;
  }
  const { createCollectionReads } = await import('../library/collection-reads.ts');
  try {
    const collection = await createCollectionReads(d).readCollection(actor, entry.scope.id, deadline);
    if (collection.title === null) return null;
    return { name: collection.title, href: `/collections/${collection.id}`, avatar: collection.cover };
  } catch (error) {
    if (error instanceof ProblemError && error.code === 'not_found') return null;
    throw error;
  }
}
async function authorizeRead(d: RecentDependencies, actor: AccountActor, deadline: number) {
  const { accessCheck } = await import('../request/access.ts');
  const { withConnection } = await import('../database/pool.ts');
  const check = await accessCheck(
    d.access,
    actor,
    'recent_search:read',
    { route: routeOf(actor.accountId)!, id: actor.accountId },
    { pool: d.pool, deadline },
  );
  if (!(await withConnection(d.pool, (c) => check(c)))) throw new ProblemError('forbidden');
}
export async function listRecentSearches(
  d: RecentDependencies,
  inputActor: Actor,
  input: { limit?: number; cursor?: string },
  deadline: number,
) {
  const actor = owner(inputActor),
    limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new ProblemError('invalid_request');
  await authorizeRead(d, actor, deadline);
  const now = d.clock?.() ?? new Date(),
    binding = { route: operation, viewer: actor.accountId, query: { limit } };
  let after: [string, string] | null = null;
  let epoch: number | undefined;
  if (input.cursor) {
    const cursor = await decodeListCursor(d.tokens, binding, input.cursor, now);
    if (
      !cursor.ok ||
      cursor.after.length !== 2 ||
      typeof cursor.after[0] !== 'string' ||
      typeof cursor.after[1] !== 'string' ||
      !Number.isFinite(Date.parse(cursor.after[0])) ||
      routeOf(cursor.after[1]) === null
    )
      throw new ProblemError('invalid_cursor');
    after = [cursor.after[0], cursor.after[1]];
    epoch = cursor.epoch;
  }
  const { withConnection } = await import('../database/pool.ts');
  const page = await withConnection(d.pool, async (c) => {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const state = await c.query(
        'SELECT revision FROM search.recent_search_state WHERE partition_no=$1 AND route=$2 AND account_id=$3',
        keys(actor),
      );
      const current = state.rows[0]?.revision ?? 0;
      if (epoch !== undefined && epoch !== current + 1) throw new ProblemError('stale_cursor');
      const rows = await c.query(
        `SELECT id, entry, last_used, revision, to_char(last_used AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM search.recent_search
        WHERE partition_no=$1 AND route=$2 AND account_id=$3 AND expires_at>$4
        AND ($5::timestamptz IS NULL OR (last_used,id)<($5,$6::uuid))
        ORDER BY last_used DESC,id DESC LIMIT $7`,
        [...keys(actor), now, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
      );
      await c.query('COMMIT');
      return { rows: rows.rows, revision: current as number };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
  const selected = page.rows.slice(0, limit);
  const recentSearches: RecentSearch[] = [];
  for (const row of selected)
    recentSearches.push({
      id: row.id,
      entry: row.entry,
      revision: row.revision,
      lastUsed: new Date(row.last_used).toISOString(),
      display: await recentDisplay(d, actor, row.entry, deadline),
    });
  const last = recentSearches.at(-1);
  return {
    recentSearches,
    revision: page.revision,
    next:
      page.rows.length > limit && last
        ? await encodeListCursor(
            d.tokens,
            binding,
            { epoch: page.revision + 1, after: [selected.at(-1)!.cursor_time, last.id] },
            now,
          )
        : null,
  };
}
export type RecentChange = { kind: 'use'; entry: RecentEntry } | { kind: 'remove'; id: string } | { kind: 'clear' };
export async function changeRecentSearches(
  d: RecentDependencies,
  inputActor: Actor,
  change: RecentChange,
  expectedRevision: number,
  requestKey: string,
  deadline: number,
) {
  const actor = owner(inputActor),
    route = routeOf(actor.accountId)!,
    partition = partitionOf(route);
  const entry = change.kind === 'use' ? admitted(change.entry) : undefined;
  const { resourceAuthorization } = await import('../access/resource-authorization.ts');
  const { shareAccount } = await import('../access/account-share.ts');
  const { principalCommandIdentity, runCommand, authoritativeTimeValue } = await import('../command/command.ts');
  const identity = principalCommandIdentity(actor);
  const scopeAvailable =
    !entry?.scope || (await recentDisplay(d, actor, { kind: 'scope', scope: entry.scope }, deadline));
  const result = await runCommand(
    d.pool,
    {
      ...identity,
      partition,
      deadline,
      clock: d.clock,
      receipt: {
        kind: `search.recent.${change.kind}`,
        key: requestKey,
        digest: Buffer.from(hash([identity, change, expectedRevision]), 'hex'),
      },
      authorization: resourceAuthorization({
        access: d.access,
        actor,
        action: 'recent_search:write',
        anchor: { resource: { route, id: actor.accountId }, validate: async () => true },
        context: { pool: d.pool, deadline, partition },
      }),
    },
    async (tx, { time }) => {
      await shareAccount(tx, actor.accountId);
      await tx.query(
        `INSERT INTO search.recent_search_state(partition_no,route,account_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        keys(actor),
      );
      const state = await tx.query(
        `SELECT revision FROM search.recent_search_state WHERE partition_no=$1 AND route=$2 AND account_id=$3 FOR UPDATE`,
        keys(actor),
      );
      if (state.rows[0].revision !== expectedRevision || expectedRevision >= revisionMax)
        throw new ProblemError('conflict');
      const revision = expectedRevision + 1,
        lastUsed = authoritativeTimeValue(time);
      await tx.query(
        `DELETE FROM search.recent_search WHERE partition_no=$1 AND route=$2 AND account_id=$3 AND expires_at<=$4`,
        [...keys(actor), lastUsed],
      );
      let id: string | null = null;
      if (entry) {
        if (!scopeAvailable) throw new ProblemError('not_found');
        const saved = await tx.query(
          `INSERT INTO search.recent_search(partition_no,route,account_id,id,entry,entry_key,last_used,expires_at,revision)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+interval '90 days',$8)
        ON CONFLICT (partition_no,route,account_id,entry_key) DO UPDATE SET last_used=EXCLUDED.last_used,expires_at=EXCLUDED.expires_at,revision=EXCLUDED.revision RETURNING id`,
          [...keys(actor), newId(route), entry, hash(entry), lastUsed, revision],
        );
        id = saved.rows[0].id;
        await tx.query(
          `DELETE FROM search.recent_search WHERE partition_no=$1 AND route=$2 AND account_id=$3 AND id IN
        (SELECT id FROM search.recent_search WHERE partition_no=$1 AND route=$2 AND account_id=$3 ORDER BY last_used DESC,id DESC OFFSET 100 LIMIT 1)`,
          keys(actor),
        );
      } else if (change.kind === 'remove') {
        const removed = await tx.query(
          `DELETE FROM search.recent_search WHERE partition_no=$1 AND route=$2 AND account_id=$3 AND id=$4 RETURNING id`,
          [...keys(actor), change.id],
        );
        if (!removed.rowCount) throw new ProblemError('not_found');
      } else
        await tx.query(
          `DELETE FROM search.recent_search WHERE partition_no=$1 AND route=$2 AND account_id=$3`,
          keys(actor),
        );
      await tx.query(
        `UPDATE search.recent_search_state SET revision=$4 WHERE partition_no=$1 AND route=$2 AND account_id=$3`,
        [...keys(actor), revision],
      );
      return {
        value: { id, revision, lastUsed },
        events: [{ type: RECENT_CHANGED, subject: actor.accountId, data: { accountId: actor.accountId } }],
      };
    },
  );
  return result.value;
}
const failures = {
  400: problemSchema('invalid_request', 'invalid_cursor'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict', 'stale_cursor'),
  422: problemSchema('idempotency_conflict'),
  429: problemSchema('rate_limited'),
  503: problemSchema(
    'overloaded',
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'dependency_unavailable',
  ),
};
function detail(operationId: string, write = false) {
  return {
    operationId,
    'x-exposure': 'public',
    'x-action': write ? 'recent_search:write' : 'recent_search:read',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': ['access.account'],
    security: [{ bearerAuth: [] }],
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}
const headers = t.Object({ 'idempotency-key': t.String({ minLength: 3, maxLength: 1024 }) });
const changed = t.Object({ id: t.Union([id, t.Null()]), revision, lastUsed: t.String() }, closed);
export function recentSearchRoutes(
  app: ReturnType<typeof createApp>,
  config: Omit<RecentDependencies, 'access'> & { access: () => Access },
) {
  const dependencies = () => ({ ...config, access: config.access() });
  type Request = Pick<Context, 'set'> & { actor: Actor; job: JobContext; admission: Admission };
  const run = <T>(ctx: Request, work: (d: RecentDependencies, actor: Actor, deadline: number) => Promise<T>) => {
    ctx.set.headers['cache-control'] = 'private, no-store';
    return ctx.admission.run('normal', ctx.job, () => work(dependencies(), ctx.actor, ctx.job.deadline));
  };
  const mutate = (ctx: Request & { headers: { 'idempotency-key': string } }, change: RecentChange, revision: number) =>
    run(ctx, (d, actor, deadline) =>
      changeRecentSearches(d, actor, change, revision, idempotencyKeyOf(ctx.headers['idempotency-key']), deadline),
    );
  return app
    .get(
      '/v1/recentSearches',
      {
        query: t.Object(
          {
            limit: t.Optional(t.Integer({ minimum: 1, maximum: 20, default: 20 })),
            cursor: t.Optional(t.String({ maxLength: 4096 })),
          },
          closed,
        ),
        response: {
          200: t.Object({ recentSearches: t.Array(item), next: t.Union([t.String(), t.Null()]), revision }, closed),
          ...failures,
        },
        detail: detail('recent_searches.list'),
      },
      (ctx) => run(ctx, (d, actor, deadline) => listRecentSearches(d, actor, ctx.query, deadline)),
    )
    .post(
      '/v1/recentSearches',
      {
        headers,
        body: strictContentSchema(t.Object({ entry: recentEntrySchema, expectedRevision: revision }, closed)),
        response: { 200: changed, ...failures },
        detail: detail('recent_searches.create', true),
      },
      (ctx) => mutate(ctx, { kind: 'use', entry: ctx.body.entry }, ctx.body.expectedRevision),
    )
    .delete(
      '/v1/recentSearches/:id',
      {
        headers,
        params: t.Object({ id }, closed),
        query: t.Object({ expectedRevision: revision }, closed),
        response: { 200: changed, ...failures },
        detail: detail('recent_searches.delete', true),
      },
      (ctx) => mutate(ctx, { kind: 'remove', id: ctx.params.id }, ctx.query.expectedRevision),
    )
    .post(
      customMethod('/v1/recentSearches', 'clear'),
      {
        headers,
        body: strictContentSchema(t.Object({ expectedRevision: revision }, closed)),
        response: { 200: changed, ...failures },
        detail: detail('recent_searches.clear', true),
      },
      (ctx) => mutate(ctx, { kind: 'clear' }, ctx.body.expectedRevision),
    );
}
