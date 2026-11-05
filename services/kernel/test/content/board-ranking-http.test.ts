import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createBoardEffect } from '../../src/content/board-projection.ts';
import { refreshBoardRankBatch } from '../../src/content/board-rank.ts';
import { createReactionCountEffect } from '../../src/content/reaction-projection.ts';
import { readBatch, type CloudEvent } from '../../src/events/log.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createNativeContentSystemWithWriteRateOverrides, type NativeContentSystem } from './support/native-system.ts';
import type { ContentCredential } from './support/system.ts';

const hour = 3_600_000;
const at = Date.parse('2030-01-08T12:00:00.000Z');
const setupAt = at - 11 * 24 * hour;
const sorts = ['hot', 'active', 'newest'] as const;
type Sort = (typeof sorts)[number];
type Persona = ContentCredential | null;
type Thread = { id: string; route: number; firstPost: { id: string } };
type RankedThread = Thread & { createdAt: number; activityAt: number; score: number };
type Board = { id: string; route: number };
type Page = { threads: Thread[]; next: string | null };
let system: NativeContentSystem;
let kernel: NativeContentSystem['kernel'];
let instant = setupAt;
let bearer = async (actor: ContentCredential) => actor.bearer;
let banned: ContentCredential;
const writeRateOverrides = JSON.stringify({
  'new-account': { write: { maximum: 10_000, seconds: 86_400 } },
  member: { write: { maximum: 10_000, seconds: 86_400 } },
});
const sources = new Set<number>();
const consumer = `ranking_http_${crypto.randomUUID().replaceAll('-', '')}`;

async function request(actor: Persona, method: string, path: string, body?: unknown, ifMatch?: string) {
  return kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(actor ? { authorization: `Bearer ${await bearer(actor)}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(ifMatch === undefined ? {} : { 'if-match': JSON.stringify(ifMatch) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function json<T>(actor: Persona, method: string, path: string, body?: unknown, ifMatch?: string): Promise<T> {
  const response = await request(actor, method, path, body, ifMatch);
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

beforeAll(async () => {
  system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    writeRateOverrides,
  );
  kernel = system.kernel;
  await bootstrapRelease(system.database.pool, bundledRelease);
  const governance = await system.database.pool.query<{ account_id: string }>(
    'SELECT account_id FROM access.governance_bootstrap',
  );
  const credential = await system.auth.issue({
    accountId: governance.rows[0]!.account_id,
    clientId: system.auth.ordinaryClient.id,
    scopes: system.actors.author.actor.scopes,
  });
  await json(credential, 'POST', `/v1/accounts/${system.actors.suspended.actor.accountId}:reinstate`, {
    reason: 'Active ranking reader',
  });
  banned = await system.auth.issue({
    accountId: system.actors.suspended.actor.accountId,
    clientId: system.auth.ordinaryClient.id,
    scopes: system.actors.author.actor.scopes,
  });
  // Native provisioning uses Auth's wall clock. As in the community HTTP fixture,
  // sign each persona's bearer locally so its lifetime follows the fixed clock.
  // The kernel still verifies signatures, account state, scopes and permissions.
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'ranking', alg: 'ES256', use: 'sig' };
  const issuer = 'https://ranking.auth.test';
  const audience = 'https://content.test';
  bearer = async ({ actor }) => {
    const iat = Math.floor(instant / 1000) - 2;
    return new SignJWT({
      client_id: actor.clientId,
      scope: actor.scopes.join(' '),
      authn_epoch: actor.authnEpoch,
      auth_time: iat,
      amr: ['pwd'],
    })
      .setSubject(actor.accountId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 300)
      .setIssuer(issuer)
      .setAudience(audience)
      .setProtectedHeader({ alg: 'ES256', kid: 'ranking', typ: 'at+jwt' })
      .sign(pair.privateKey);
  };
  kernel = createKernel({
    pool: system.database.pool,
    routeKey: system.routeKey,
    tokens: system.tokenKeys,
    clock: () => new Date(instant),
    content: { cursorNow: () => instant },
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
    writeRate: createWriteRateLimiter({
      secret: crypto.randomUUID() + crypto.randomUUID(),
      overrides: writeRateOverrides,
    }),
    ratePeer: () => '127.0.0.1',
  });
  for (const actor of [system.actors.author, system.actors.other, system.actors.moderator])
    sources.add(partitionOf(routeOf(actor.actor.accountId)!));
}, 120_000);
afterAll(async () => {
  await system?.close();
});

async function board(visibility: 'public' | 'protected'): Promise<{ board: Board; realmId: string }> {
  instant = setupAt;
  const owner = system.actors.author;
  const { space } = await json<{ space: { spaceId: string } }>(owner, 'POST', '/v1/spaces', { title: 'Ranking host' });
  const { realm } = await json<{ realm: { realmId: string; headRevisionId: string } }>(owner, 'POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Ranked Realm',
    visibility,
    contextId: GLOBAL_CONTEXT,
    votes: { upvote: 1, downvote: -1 },
  });
  const { subject: scheme } = await json<{ subject: { id: string } }>(owner, 'POST', '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Ranking scheme' },
  });
  const { subject: concept } = await json<{ subject: { id: string } }>(owner, 'POST', '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Ranking board' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
    },
  });
  await json(owner, 'PUT', `/v1/realms/${realm.realmId}/boardScheme`, { schemeId: scheme.id }, realm.headRevisionId);
  const result = await json<{ board: Board }>(owner, 'POST', `/v1/realms/${realm.realmId}/boards`, {
    conceptId: concept.id,
    title: 'Ranked discussion',
    visibility: 'published',
  });
  return { board: result.board, realmId: realm.realmId };
}

async function publicBoard() {
  const result = await board('public');
  const { author, other, moderator } = system.actors;
  // Fixture membership is read by the native Realm role reader, without broad identity grants.
  await system.database.pool.query(
    `INSERT INTO community.realm_member (route, realm_id, account_id, role, valid, reservation_id, transaction_id)
     VALUES ($1, $2, $3, 'member', tstzrange($4, NULL, '[)'), $5, $6)`,
    [
      routeOf(result.realmId),
      result.realmId,
      other.actor.accountId,
      new Date(setupAt),
      newId(routeOf(other.actor.accountId)!),
      crypto.randomUUID(),
    ],
  );
  expect(await json(other, 'GET', `/v1/realms/${result.realmId}/members/me`)).toMatchObject({ state: 'member' });
  await json(author, 'POST', '/v1/roleGrants', {
    resource: { route: routeOf(result.realmId), id: result.realmId },
    subject: { kind: 'account', id: moderator.actor.accountId },
    role: 'community.realm.moderator',
    valid: '(,)',
  });
  await json(moderator, 'PUT', `/v1/realms/${result.realmId}/bans/${banned.actor.accountId}`, {
    reason: 'Ranking banned reader',
  });
  expect((await request(banned, 'GET', `/v1/realms/${result.realmId}/participation`)).status).toBe(403);
  return result.board;
}

async function reply(thread: RankedThread, time: number) {
  instant = time;
  await json(system.actors.other, 'POST', `/v1/threads/${thread.id}/posts`, {
    parentId: thread.firstPost.id,
    body: fromPlainText('Recent reply'),
    licence: 'MIT',
    subjectIds: [],
  });
  thread.activityAt = time;
}

async function vote(thread: RankedThread, actor: ContentCredential, kind: 'upvote' | 'downvote') {
  await json(actor, 'PUT', `/v1/threads/${thread.id}/reaction`, { kind });
  thread.score += kind === 'upvote' ? 1 : -1;
}

async function thread(board: Board, age: number, score = 0, replyAge?: number): Promise<RankedThread> {
  const createdAt = at - Math.round(age * hour);
  instant = createdAt;
  const result = await json<{ thread: Thread }>(system.actors.author, 'POST', '/v1/threads', {
    boardId: board.id,
    title: `Age ${age}, score ${score}`,
    body: fromPlainText('Ranked opening'),
    licence: 'MIT',
    subjectIds: [],
    visibility: 'published',
  });
  sources.add(partitionOf(result.thread.route));
  const value: RankedThread = { ...result.thread, createdAt, activityAt: createdAt, score: 0 };
  if (replyAge !== undefined) await reply(value, at - replyAge * hour);
  const voters = [system.actors.other, system.actors.moderator, system.actors.author];
  for (let index = 0; index < Math.abs(score); index++)
    await vote(value, voters[index]!, score > 0 ? 'upvote' : 'downvote');
  return value;
}

async function refresh(board: Board, time = at) {
  const boardEffect = createBoardEffect(system.database.pool);
  const reactionEffect = createReactionCountEffect(system.database.pool);
  for (const partition of sources) {
    for (;;) {
      const events: CloudEvent[] = [];
      const batch = await readBatch(system.database.pool, {
        partition,
        consumer,
        apply: async (envelopes) => {
          events.push(...envelopes.flatMap((envelope) => envelope.events));
        },
      });
      expect(batch.status).toBe('read');
      if (batch.status !== 'read' || batch.envelopes === 0) break;
      for (const event of events) {
        if (
          event.type === 'com.rezics.content.thread.created.v1' ||
          event.type === 'com.rezics.content.post.created.v1'
        )
          await boardEffect.run(event);
        if (event.type === 'com.rezics.content.reaction.changed.v1') await reactionEffect.run(event);
      }
    }
  }
  instant = time;
  await refreshBoardRankBatch(system.database.pool, new Date(time), [partitionOf(board.route)]);
}

// LemmyNet/lemmy 0.19.21: crates/db_schema/replaceable_schema/utils.sql (r.hot_rank).
// REZICS retains h = 168 and clamps h <= 0 as documented in board-rank.ts.
// This oracle uses only fixture inputs; neither stored ranks nor the production rank function supply expectations.
function expectedRank(score: number, timestamp: number, time: number) {
  const age = (time - timestamp) / hour;
  return age > 168 ? 0 : Math.log10(Math.max(2, score + 2)) / (Math.max(0, age) + 2) ** 1.8;
}

function order(threads: readonly RankedThread[], sort: Sort, time: number): string[] {
  // Lemmy 0.19.21 crates/db_views/src/post_view.rs: SortType::New orders by published DESC.
  // REZICS spells it "newest" and breaks ties by descending ID; ranked ties use ascending ID.
  return [...threads]
    .sort((a, b) => {
      if (sort === 'newest') return b.createdAt - a.createdAt || b.id.localeCompare(a.id);
      const key = sort === 'hot' ? 'createdAt' : 'activityAt';
      return expectedRank(b.score, b[key], time) - expectedRank(a.score, a[key], time) || a.id.localeCompare(b.id);
    })
    .map(({ id }) => id);
}

async function pages(board: Board, threads: readonly RankedThread[], time = at) {
  for (const actor of [null, system.actors.other, system.actors.moderator, banned]) {
    for (const sort of sorts) {
      const expected = order(threads, sort, time);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let offset = 0; offset < expected.length; offset += 2) {
        const query = new URLSearchParams({ sort, limit: '2' });
        if (cursor) query.set('cursor', cursor);
        const page = await json<Page>(actor, 'GET', `/v1/boards/${board.id}/threads?${query}`);
        const ids = page.threads.map(({ id }) => id);
        expect(ids, `${actor?.actor.accountId ?? 'anonymous'} ${sort} page ${offset / 2}`).toEqual(
          expected.slice(offset, offset + 2),
        );
        seen.push(...ids);
        cursor = page.next;
        if (offset + 2 < expected.length) expect(cursor).toBeString();
        else expect(cursor).toBeNull();
      }
      expect(seen).toEqual(expected);
    }
  }
}

test.serial(
  "hot active and new board pages through HTTP match orders computed independently from Lemmy's formulas",
  async () => {
    const publicListing = await publicBoard();
    const threads = [
      await thread(publicListing, 0),
      await thread(publicListing, -0.25),
      await thread(publicListing, 1),
      await thread(publicListing, 2, 2),
      await thread(publicListing, 4, 3, 0.5),
      await thread(publicListing, 4, 1, 3),
      await thread(publicListing, 4, 1, 3),
      await thread(publicListing, 0.75, -2),
      await thread(publicListing, 168),
      await thread(publicListing, 168 + 1 / hour),
      await thread(publicListing, 240, 1, 1),
    ];
    await refresh(publicListing);
    await pages(publicListing, threads);
    const stored = await system.database.pool.query<{ thread_id: string; hot_rank: number; active_rank: number }>(
      'SELECT thread_id, hot_rank, active_rank FROM content.board_thread WHERE route=$1 AND board_id=$2',
      [publicListing.route, publicListing.id],
    );
    for (const value of threads) {
      const row = stored.rows.find(({ thread_id }) => thread_id === value.id)!;
      expect(row.hot_rank).toBeCloseTo(expectedRank(value.score, value.createdAt, at), 12);
      expect(row.active_rank).toBeCloseTo(expectedRank(value.score, value.activityAt, at), 12);
      if (value.createdAt === at - 168 * hour) expect(row.hot_rank).toBeGreaterThan(0);
      if (value.createdAt === at - 168 * hour - 1) expect(row.hot_rank).toBe(0);
    }
    const protectedListing = await board('protected');
    const hidden = await thread(protectedListing.board, 1);
    await refresh(protectedListing.board);
    for (const actor of [null, system.actors.other, banned]) {
      for (const sort of sorts) {
        const response = await request(
          actor,
          'GET',
          `/v1/boards/${protectedListing.board.id}/threads?sort=${sort}&limit=2`,
        );
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain(hidden.id);
      }
    }
  },
  120_000,
);

test.serial(
  'replies and votes move a thread in active and hot exactly as the formulas say for every readable persona',
  async () => {
    const board = await publicBoard();
    const leader = await thread(board, 0.5);
    const voted = await thread(board, 0.75);
    const replied = await thread(board, 6);
    const threads = [leader, voted, replied];
    await refresh(board);
    await pages(board, threads);
    const beforeHot = order(threads, 'hot', at);
    expect(order(threads, 'active', at)).toEqual([leader.id, voted.id, replied.id]);
    await reply(replied, at);
    await refresh(board);
    expect(order(threads, 'active', at)).toEqual([replied.id, leader.id, voted.id]);
    expect(order(threads, 'hot', at)).toEqual(beforeHot);
    await pages(board, threads);
    const votedAt = at + 10 * 60_000;
    instant = votedAt;
    await vote(voted, system.actors.other, 'upvote');
    await refresh(board, votedAt);
    expect(order(threads, 'hot', votedAt)).toEqual([voted.id, leader.id, replied.id]);
    await pages(board, threads, votedAt);
  },
  120_000,
);
