import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText, serializeDocument } from '@rezics/document';
import type { Pool } from 'pg';
import { createPost } from '../../../src/content/commands.ts';
import { readExactPublishedRules } from '../../../src/content/reads.ts';
import { readCommunityPresentations } from '../../../src/content/community-presentation.ts';
import { rulesKey } from '../../../src/content/community-presentation-rules.ts';
import type { Access } from '../../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { openGrowthDatabase, seed, type Population, type Row } from '../../support/growth.ts';
import { startReactionEffects } from '../reaction-relay-convergence-fixture.ts';
import { createNativeContentSystem } from './native-system.ts';

export const scales = [256, 1024, 4096] as const;
export const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
export const readContext = () => ({ actor: { kind: 'anonymous' } as const, deadline: Date.now() + 90_000 });
export const emptyPresentation = { avatarMediaId: null, bannerMediaId: null, rules: null };
export type Pin = { realmId: string; postId: string; revisionId: string };
export type Target = Pin & { spaceId: string; boardId: string; threadId: string; rootId: string };

/** Size is canonical UTF-8 bytes, including the native Text document envelope. */
export function textAtBytes(bytes: number) {
  const overhead = Buffer.byteLength(serializeDocument(fromPlainText('x'))) - 1;
  const body = fromPlainText('x'.repeat(bytes - overhead));
  if (Buffer.byteLength(serializeDocument(body)) !== bytes) throw new Error('Incorrect canonical fixture size');
  return body;
}

export async function createRulesFixture() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  const system = await createNativeContentSystem({ databaseUrl });
  let db: Awaited<ReturnType<typeof openGrowthDatabase>> | undefined;
  let runtime: Awaited<ReturnType<typeof startReactionEffects>> | undefined;
  try {
    await bootstrapRelease(system.database.pool, bundledRelease);
    db = await openGrowthDatabase(system.database.pool.options.connectionString);
    const database = db;
    const author = system.actors.author;
    const governanceId = (await database.admin.query('SELECT account_id FROM access.governance_bootstrap')).rows[0]
      .account_id as string;
    const governance = await system.auth.issue({
      accountId: governanceId,
      clientId: system.auth.ordinaryClient.id,
      scopes: system.auth.ordinaryScopes,
    });
    async function call(
      method: string,
      path: string,
      body?: unknown,
      options: { key?: string; head?: string; bearer?: string; status?: number } = {},
    ) {
      const headers = new Headers();
      if (method !== 'GET') {
        headers.set('authorization', `Bearer ${options.bearer ?? author.bearer}`);
        headers.set('idempotency-key', JSON.stringify(options.key ?? randomUUID()));
      } else if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
      if (body !== undefined) headers.set('content-type', 'application/json');
      if (options.head) headers.set('if-match', JSON.stringify(options.head));
      const response = await system.kernel.handle(
        new Request(`https://content.test${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      const text = await response.text();
      const status = options.status ?? (method === 'GET' || method === 'PATCH' ? 200 : 201);
      if (response.status !== status) throw new Error(`${method} ${path}: ${response.status} ${text}`);
      return { response, text, value: text ? JSON.parse(text) : null };
    }
    const scheme = (
      await call('POST', '/v1/subjects', {
        type: 'skos:ConceptScheme',
        labels: { en: 'Rules scheme' },
      })
    ).value.subject.id as string;
    const concept = (
      await call('POST', '/v1/subjects', {
        type: 'skos:Concept',
        labels: { en: 'Rules board' },
        statements: {
          'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme } }],
        },
      })
    ).value.subject.id as string;
    async function patchRealm(
      realmId: string,
      body: unknown,
      options: { key?: string; head?: string; status?: number } = {},
    ) {
      const head =
        options.head ??
        (await call('GET', `/v1/realms/${realmId}`, undefined, { bearer: author.bearer })).value.realm.headRevisionId;
      return call('PATCH', `/v1/realms/${realmId}`, body, { ...options, head });
    }
    async function target(title: string): Promise<Target> {
      const spaceId = (await call('POST', '/v1/spaces', { title, summary: '' })).value.space.spaceId as string;
      const realm = (
        await call('POST', '/v1/realms', {
          spaceId,
          title,
          summary: '',
          visibility: 'public',
          contextId: GLOBAL_CONTEXT,
        })
      ).value.realm;
      await call(
        'PUT',
        `/v1/realms/${realm.realmId}/boardScheme`,
        { schemeId: scheme },
        {
          head: realm.headRevisionId,
          status: 200,
        },
      );
      const boardId = (
        await call('POST', `/v1/realms/${realm.realmId}/boards`, {
          conceptId: concept,
          title,
          visibility: 'published',
        })
      ).value.board.id as string;
      const thread = (
        await call('POST', '/v1/threads', {
          boardId,
          title,
          body: fromPlainText('Native rules root'),
          licence: 'MIT',
          subjectIds: [],
          visibility: 'published',
        })
      ).value.thread;
      return {
        spaceId,
        realmId: realm.realmId,
        boardId,
        threadId: thread.id,
        rootId: thread.firstPost.id,
        postId: thread.firstPost.id,
        revisionId: thread.firstPost.revisionId,
      };
    }
    async function reply(target: Target, parentId: string, bytes = 512): Promise<Pin> {
      // Native command admission, creation manifest, receipt and registered event writers;
      // no SQL-created selected claims and no HTTP limiter budget override.
      const result = await createPost(
        { pool: system.database.pool, access: system.access, routeKey: system.routeKey },
        author.actor,
        {
          threadId: target.threadId,
          parentId,
          body: textAtBytes(bytes),
          licence: 'MIT',
          subjectIds: [],
        },
        { idempotencyKey: randomUUID(), deadline: Date.now() + 90_000, requestId: randomUUID() },
      );
      return { realmId: target.realmId, postId: result.value.itemId, revisionId: result.value.revisionId };
    }
    const exact = (refs: readonly Pin[], access = system.access, pool = database.pool) =>
      readExactPublishedRules({ pool, access }, refs, readContext());
    const presentations = (ids: readonly string[], access = system.access) =>
      readCommunityPresentations({ pool: database.pool, access }, ids, readContext());
    async function adopt(pin: Pin) {
      return patchRealm(pin.realmId, {
        presentation: {
          ...emptyPresentation,
          rules: { postId: pin.postId, revisionId: pin.revisionId },
        },
      });
    }
    return {
      system,
      db: database,
      call,
      target,
      reply,
      exact,
      presentations,
      adopt,
      patchRealm,
      governance,
      async conceal(postId: string) {
        await call(
          'POST',
          `/v1/posts/${postId}:takeDown`,
          { reason: 'Current rules disclosure' },
          {
            bearer: governance.bearer,
            status: 200,
          },
        );
      },
      async registerEffects() {
        runtime = await startReactionEffects(system, database.pool, database.url, { relay: false });
      },
      async close() {
        try {
          await runtime?.stop();
        } finally {
          try {
            await database.close();
          } finally {
            await system.close();
          }
        }
      },
    };
  } catch (error) {
    try {
      await db?.close();
    } finally {
      await system.close();
    }
    throw error;
  }
}

export type RulesFixture = Awaited<ReturnType<typeof createRulesFixture>>;
export { rulesKey };

/** Inject a native transition after the first body snapshot commits, before the final round opens.
 * The proxy forwards every SQL statement and result; it supplies no authorization or source facts.
 */
export function betweenRulesRounds(pool: Pool, transition: () => Promise<void>): Pool {
  let pending = true;
  return new Proxy(pool, {
    get(target, property) {
      if (property !== 'connect') return Reflect.get(target, property, target);
      return async () => {
        const client = await target.connect();
        let bodies = false;
        return new Proxy(client, {
          get(connection, key) {
            if (key !== 'query') {
              const value = Reflect.get(connection, key, connection);
              return typeof value === 'function' ? value.bind(connection) : value;
            }
            return async (...args: unknown[]) => {
              const query = args[0];
              const sql =
                typeof query === 'string'
                  ? query
                  : typeof query === 'object' && query !== null && 'text' in query && typeof query.text === 'string'
                    ? query.text
                    : '';
              if (sql.includes('octet_length(r.body)')) bodies = true;
              const result = await Reflect.apply(connection.query, connection, args);
              if (pending && bodies && sql.trim() === 'COMMIT') {
                pending = false;
                await transition();
              }
              return result;
            };
          },
        });
      };
    },
  });
}

/** Only optional rules fail; every successful decision still uses the production factory. */
export function unavailableRules(native: Access): Access {
  return {
    ...native,
    async prepareReadDecisions(input) {
      if (input.actions.has('post:read')) throw new Error('Exact rules dependency unavailable');
      return native.prepareReadDecisions!(input);
    },
  };
}

/** Clone native shapes only for unselected pressure, outside observation. Both axes keep
 * the selected keys, ancestry, document bytes, partitions and fixed page unchanged.
 */
export async function pressure(
  f: RulesFixture,
  anchor: Target,
  axis: 'population' | 'history',
  selected: Target,
): Promise<Population> {
  const read = async (table: string, column: string, id: string): Promise<Row> => {
    const result = await f.db.admin.query(`SELECT * FROM ${table} WHERE route=$1 AND ${column}=$2`, [routeOf(id), id]);
    if (result.rows.length !== 1) throw new Error(`Missing pressure template ${table}`);
    return result.rows[0];
  };
  const [space, spaceRevision, realm, realmRevision, board, thread, post, revision] = await Promise.all([
    read('community.space', 'space_id', anchor.spaceId),
    f.db.admin
      .query('SELECT * FROM community.space_revision WHERE route=$1 AND space_id=$2', [
        routeOf(anchor.spaceId),
        anchor.spaceId,
      ])
      .then((r) => r.rows.at(-1) as Row),
    read('community.realm', 'realm_id', anchor.realmId),
    f.db.admin
      .query('SELECT * FROM community.realm_revision WHERE route=$1 AND realm_id=$2 ORDER BY created_at DESC LIMIT 1', [
        routeOf(anchor.realmId),
        anchor.realmId,
      ])
      .then((r) => r.rows[0] as Row),
    read('content.board', 'board_id', anchor.boardId),
    read('content.thread', 'thread_id', anchor.threadId),
    read('content.post', 'post_id', anchor.rootId),
    read('content.revision', 'revision_id', anchor.revisionId),
  ]);
  const contentRoute = routeOf(selected.postId)!;
  const realmRoute = routeOf(selected.realmId)!;
  const boardRoute = routeOf(selected.boardId)!;
  const owner = f.system.actors.author.actor.accountId;
  const at = '2000-01-01T00:00:00.000Z';
  const graph = () => {
    const spaceId = newId(realmRoute),
      realmId = newId(realmRoute),
      boardId = newId(boardRoute);
    const threadId = newId(contentRoute),
      postId = newId(contentRoute),
      revisionId = newId(contentRoute);
    const spaceRevisionId = newId(realmRoute),
      realmRevisionId = newId(realmRoute);
    return {
      realmId,
      spaceId,
      postId,
      threadId,
      boardId,
      rows: {
        'community.space': [{ ...space, route: realmRoute, space_id: spaceId, head_revision_id: spaceRevisionId }],
        'community.space_revision': [
          { ...spaceRevision, route: realmRoute, space_id: spaceId, revision_id: spaceRevisionId, predecessor: null },
        ],
        'community.realm': [
          { ...realm, route: realmRoute, realm_id: realmId, space_id: spaceId, head_revision_id: realmRevisionId },
        ],
        'community.realm_revision': [
          {
            ...realmRevision,
            route: realmRoute,
            realm_id: realmId,
            revision_id: realmRevisionId,
            predecessor: null,
            presentation: emptyPresentation,
          },
        ],
        'content.board': [{ ...board, route: boardRoute, board_id: boardId, realm_id: realmId }],
        'content.thread': [
          { ...thread, route: contentRoute, thread_id: threadId, board_id: boardId, first_post_id: postId },
        ],
        'content.post': [
          {
            ...post,
            route: contentRoute,
            thread_id: threadId,
            post_id: postId,
            reply_to_post_id: null,
            head_revision_id: revisionId,
          },
        ],
        'content.revision': [
          {
            ...revision,
            route: contentRoute,
            thread_id: threadId,
            post_id: postId,
            revision_id: revisionId,
            board_id: boardId,
          },
        ],
        'access.resource_role_grant': [
          {
            route: realmRoute,
            resource_id: realmId,
            subject_kind: 'identity',
            subject_id: owner,
            grant_role: 'community.realm.owner',
            valid: '(,)',
            transaction_id: randomUUID(),
          },
        ],
      },
    };
  };
  // Only this unrelated graph is SQL-seeded. Place it on the selected full routes,
  // rather than growing an easier disjoint route or adding selected siblings.
  const history = graph();
  if (axis === 'history')
    await seed(
      f.db,
      {
        name: `rules-history-anchor-${randomUUID()}`,
        hotPartition: partitionOf(contentRoute),
        hotShare: 1,
        rows: () => history.rows,
      },
      { from: 0, to: 1 },
    );
  return {
    name: `rules-${axis}-${randomUUID()}`,
    hotPartition: partitionOf(contentRoute),
    hotShare: 1,
    async finish(admin) {
      if (axis === 'history')
        await admin.query(
          `UPDATE core.partition SET position=GREATEST(position,
          (SELECT COALESCE(max(position),0) FROM core.outbox WHERE partition_no=$1)) WHERE partition_no=$1`,
          [partitionOf(contentRoute)],
        );
    },
    rows({ ordinal }) {
      const transaction = randomUUID();
      const revisionId = newId(contentRoute),
        realmRevisionId = newId(realmRoute),
        spaceRevisionId = newId(realmRoute);
      if (axis === 'history')
        return {
          'content.revision': [
            {
              ...revision,
              route: contentRoute,
              thread_id: history.threadId,
              post_id: history.postId,
              board_id: history.boardId,
              revision_id: revisionId,
              recorded_at: at,
              recorded_transaction_id: transaction,
            },
          ],
          'community.realm_revision': [
            {
              ...realmRevision,
              route: realmRoute,
              realm_id: history.realmId,
              revision_id: realmRevisionId,
              predecessor: null,
              created_at: at,
            },
          ],
          'community.space_revision': [
            {
              ...spaceRevision,
              route: realmRoute,
              space_id: history.spaceId,
              revision_id: spaceRevisionId,
              predecessor: null,
              created_at: at,
            },
          ],
          'access.resource_role_grant': [
            {
              route: realmRoute,
              resource_id: history.realmId,
              subject_kind: 'identity',
              subject_id: newId(realmRoute),
              grant_role: 'community.realm.owner',
              valid: '[2000-01-01,2001-01-01)',
              transaction_id: transaction,
            },
          ],
          'core.receipt': [
            {
              partition_no: partitionOf(contentRoute),
              principal_kind: 'account',
              principal_id: owner,
              command_kind: 'content.post.revise',
              idempotency_key: `rules-history-${revisionId}`,
              request_digest: Buffer.alloc(32),
              epoch: 1,
              position: 1_000_000 + ordinal,
              transaction_id: transaction,
              response: { revisionId },
            },
          ],
          'core.outbox': [
            {
              partition_no: partitionOf(contentRoute),
              epoch: 1,
              position: 1_000_000 + ordinal,
              event_seq: 0,
              event_count: 1,
              id: randomUUID(),
              type: 'com.rezics.content.post.revised.v1',
              subject: history.postId,
              data: { revisionId },
            },
          ],
          'editorial.write_basis': [
            {
              partition_no: partitionOf(contentRoute),
              transaction_id: transaction,
              epoch: 1,
              position: 1_000_000 + ordinal,
              principal_kind: 'account',
              principal_id: owner,
              client_id: f.system.actors.author.actor.clientId,
              requested_by: null,
              recorded_at: at,
            },
          ],
        };
      return graph().rows;
    },
  };
}
