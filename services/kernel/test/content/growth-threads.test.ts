import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import type { Pool } from 'pg';
import { createAccess as createPermissionAccess } from '../../src/access/permission.ts';
import { createPost, createThread, revisePost, threadTarget } from '../../src/content/commands.ts';
import { isErasedPlaceholder } from '../../src/content/model.ts';
import { readBoard, readPost, readThread, listPostRevisions, listThreadPosts } from '../../src/content/reads.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const scales = [1, 4, 16] as const;
const ordinalsPerScale = 500;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const routeKey = new Uint8Array(32).fill(19);
const body = fromPlainText('A fixed growth-check body');
const bodyBytes = Buffer.from(serializeDocument(body));
const bodyHash = createHash('sha256').update(bodyBytes).digest();
const baseTime = '2026-10-25T00:00:00.000Z';
const laterTime = '2099-01-01T00:00:00.000Z';
const pageTokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const publicAccess = createPermissionAccess({
  actions: new Map(['board:read', 'thread:read', 'post:read'].map((action) => [action, { anonymous: true }])),
  accountEvidence: () => null,
});
const anonymous = { kind: 'anonymous' } as const;

type Fixture = Awaited<ReturnType<typeof standingFixture>>;
type Anchor = { threadId: string; postId: string; revisionId: string; route: number };
type GrowthMode = 'threads' | 'posts' | 'revisions';

const seededRelations = [
  'content.board',
  'content.thread',
  'content.post',
  'content.revision',
  'access.resource_grant',
  'access.resource_denial',
  'access.resource_initialization',
  'access.resource_role_grant',
  'core.receipt',
  'core.outbox',
  'editorial.write_basis',
] as const;
const checkObservations: { name: string; requestedCheckpoints: number; vacuums: Record<string, number> }[] = [];

let db: GrowthDatabase;
let fixture: Fixture;
let actor: AccountActor;
let board: { route: number; id: string };
let homePartition: number;

beforeAll(async () => {
  db = await openGrowthDatabase();
  fixture = await standingFixture();
  db.pool.options.max = 1;
  await fixture.reset();
  actor = await observedActor(db.pool);
  homePartition = partitionOf(routeOf(actor.accountId)!);
  const accountPopulation: Population = {
    name: `growth-content-actor-neighbourhood-${randomUUID()}`,
    hotPartition: homePartition,
    hotShare: 1,
    rows: ({ route }) => {
      const accountId = newId(route);
      const groupId = newId(route);
      const transactionId = randomUUID();
      return {
        'access.account': [
          {
            route,
            account_id: accountId,
            kind: 'actor',
            state: 'active',
            transaction_id: transactionId,
          },
          {
            route,
            account_id: groupId,
            kind: 'organization',
            state: 'active',
            transaction_id: transactionId,
          },
        ],
        'access.membership_inverse': [
          {
            route,
            account_id: accountId,
            kind: 'organization',
            group_id: groupId,
            reservation_id: randomUUID(),
            transaction_id: transactionId,
          },
        ],
        'access.organization_member': [
          {
            route,
            organization_id: groupId,
            member_account_id: accountId,
            role: 'owner',
            valid: '[2000-01-01,)',
            transaction_id: transactionId,
          },
        ],
      };
    },
  };
  // Matches production account, inverse-membership and organization-member writes for unrelated actors.
  await seed({ pool: db.pool, admin: db.admin }, accountPopulation, { from: 0, to: ordinalsPerScale });
});

afterAll(async () => {
  await fixture?.close();
  await db?.close();
});

function requestContext(idempotencyKey: string) {
  return { idempotencyKey, deadline: Date.now() + 90_000, requestId: Bun.randomUUIDv7() };
}

function readContext() {
  return { actor: anonymous, deadline: Date.now() + 90_000 };
}

function commandDependencies(pool: Pool = db.pool) {
  return { pool, access: fixture.access, routeKey };
}

function readDependencies(pool: Pool = db.pool) {
  return { pool, access: publicAccess, tokens: pageTokens };
}

async function observedActor(pool: Pool): Promise<AccountActor> {
  const authenticate = fixture.access.authenticate;
  fixture.access.authenticate = (token, boundary) =>
    authenticate(token, { ...boundary, pool, deadline: Date.now() + 90_000 });
  try {
    return (await fixture.context()).actor;
  } finally {
    fixture.access.authenticate = authenticate;
  }
}

async function resetCase(): Promise<void> {
  await db.admin.query(
    `TRUNCATE content.board, content.thread, content.post, content.revision,
      core.receipt, core.outbox, editorial.write_basis, access.resource_initialization,
      access.resource_grant, access.resource_role_grant, access.resource_denial CASCADE`,
  );
  await fixture.reset();
  actor = await observedActor(db.pool);
  board = { route: homePartition * 16 + 3, id: newId(homePartition * 16 + 3) };
  await db.admin.query(
    `INSERT INTO content.board
      (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id, created_at)
     VALUES ($1, $2, $3, 'Growth board', 'published', 1, $4, $5)`,
    [board.route, board.id, newId(board.route), randomUUID(), baseTime],
  );
  await fixture.grant(actor.accountId, 'thread:create', board);
}

async function keyForHome(label: string): Promise<string> {
  for (let attempt = 0; attempt < 100_000; attempt++) {
    const key = `${label}-${attempt}-${randomUUID()}`;
    const target = threadTarget(routeKey, actor.accountId, key);
    if (partitionOf(target.route) === homePartition) return key;
  }
  throw new Error('Could not find a content command key in the anchor partition');
}

async function createAnchor(label: string): Promise<Anchor> {
  const result = await createThread(
    commandDependencies(),
    actor,
    {
      title: 'Fixed growth thread',
      body,
      licence: 'MIT',
      subjectIds: [],
      boardId: board.id,
      visibility: 'published',
    },
    requestContext(await keyForHome(label)),
  );
  return {
    threadId: result.value.threadId,
    postId: result.value.itemId,
    revisionId: result.value.revisionId,
    route: routeOf(result.value.threadId)!,
  };
}

function growthPopulation(name: string, mode: GrowthMode, anchor: Anchor | null, positionBase: number): Population {
  const revisionHeads = new Map<number, string>();
  // Mirrors routed content command writes, creator grants and command records; finish restores partition.position.
  return {
    name,
    hotPartition: homePartition,
    hotShare: 1,
    rows: ({ ordinal, route }) => {
      const threadId = newId(route);
      const postId = newId(route);
      const revisionId = newId(route);
      const transactionId = randomUUID();
      const aclResourceId = newId(route);
      const at = baseTime;
      const created = {
        route,
        thread_id: threadId,
        post_id: postId,
        revision_id: revisionId,
        body: bodyBytes,
        body_sha256: bodyHash,
        search_text: 'A fixed growth-check body',
        licence: 'MIT',
        subject_ids: [],
        board_id: board.id,
        availability: 'available',
        recorded_transaction_id: transactionId,
        recorded_at: at,
        media_ids: [],
      };
      const standardValue = { threadId, itemId: postId, revisionId };
      const standardPosition = positionBase + ordinal * 100;
      const resultRows: Record<string, readonly Record<string, unknown>[]> = {
        'content.board': [
          {
            route,
            board_id: newId(route),
            subject_id: newId(route),
            title: 'Growth neighbour board',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: at,
          },
        ],
        'content.thread': [
          {
            route,
            thread_id: threadId,
            author_account_id: actor.accountId,
            board_id: board.id,
            title: 'Growth neighbour thread',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            first_post_id: postId,
            created_at: at,
            availability: 'available',
          },
        ],
        'content.post': [
          {
            route,
            thread_id: threadId,
            post_id: postId,
            reply_to_post_id: null,
            author_account_id: actor.accountId,
            head_revision_id: revisionId,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: at,
            availability: 'available',
          },
        ],
        'content.revision': [created],
        'access.resource_grant': [
          {
            route,
            resource_id: aclResourceId,
            subject_id: actor.accountId,
            subject_role: '',
            action: 'post:read',
            valid: '[2000-01-01,)',
            transaction_id: randomUUID(),
            subject_kind: 'identity',
          },
        ],
        'access.resource_denial': [
          {
            route,
            resource_id: aclResourceId,
            subject_id: actor.accountId,
            subject_role: '',
            action: 'post:read',
            reason: 'resource',
            valid: '[2000-01-01,)',
            transaction_id: randomUUID(),
          },
        ],
        'access.resource_initialization': [
          {
            route,
            resource_id: threadId,
            resource_type: 'content.thread',
            creator_id: actor.accountId,
            initialized_at: at,
          },
          {
            route,
            resource_id: postId,
            resource_type: 'content.post',
            creator_id: actor.accountId,
            initialized_at: at,
          },
        ],
        'access.resource_role_grant': [
          {
            route,
            resource_id: threadId,
            subject_kind: 'identity',
            subject_id: actor.accountId,
            subject_role: '',
            grant_role: 'content.thread.owner',
            valid: `[${at},)`,
            transaction_id: randomUUID(),
          },
          {
            route,
            resource_id: threadId,
            subject_kind: 'active_accounts',
            subject_id: '00000000-0000-0000-0000-000000000000',
            subject_role: '',
            grant_role: 'content.thread.standing',
            valid: `[${at},)`,
            transaction_id: randomUUID(),
          },
          {
            route,
            resource_id: postId,
            subject_kind: 'identity',
            subject_id: actor.accountId,
            subject_role: '',
            grant_role: 'content.post.owner',
            valid: `[${at},)`,
            transaction_id: randomUUID(),
          },
          {
            route,
            resource_id: postId,
            subject_kind: 'active_accounts',
            subject_id: '00000000-0000-0000-0000-000000000000',
            subject_role: '',
            grant_role: 'content.post.standing',
            valid: `[${at},)`,
            transaction_id: randomUUID(),
          },
        ],
        'core.receipt': [
          {
            partition_no: homePartition,
            principal_kind: 'account',
            principal_id: actor.accountId,
            command_kind: 'content.thread.create',
            idempotency_key: `growth-seed-thread-${name}-${ordinal}`,
            request_digest: Buffer.alloc(32),
            epoch: 1,
            position: standardPosition,
            transaction_id: transactionId,
            response: standardValue,
          },
        ],
        'core.outbox': [
          {
            partition_no: homePartition,
            position: standardPosition,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: randomUUID(),
            type: 'com.rezics.content.thread.created.v1',
            subject: postId,
            data: { ...standardValue, actorId: actor.accountId },
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: homePartition,
            transaction_id: transactionId,
            epoch: 1,
            position: standardPosition,
            principal_kind: 'account',
            principal_id: actor.accountId,
            client_id: 'web',
            requested_by: null,
          },
        ],
      };

      if (mode === 'posts' && anchor) {
        const extraPostId = newId(anchor.route);
        const extraRevisionId = newId(anchor.route);
        const extraTransaction = randomUUID();
        const extraPosition = standardPosition + 1;
        const value = { threadId: anchor.threadId, itemId: extraPostId, revisionId: extraRevisionId };
        resultRows['content.post'] = [
          ...resultRows['content.post']!,
          {
            route: anchor.route,
            thread_id: anchor.threadId,
            post_id: extraPostId,
            reply_to_post_id: anchor.postId,
            author_account_id: actor.accountId,
            head_revision_id: extraRevisionId,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: extraTransaction,
            created_at: laterTime,
            availability: 'available',
          },
        ];
        resultRows['content.revision'] = [
          ...resultRows['content.revision']!,
          {
            ...created,
            route: anchor.route,
            thread_id: anchor.threadId,
            post_id: extraPostId,
            revision_id: extraRevisionId,
            recorded_transaction_id: extraTransaction,
            recorded_at: laterTime,
          },
        ];
        resultRows['access.resource_initialization'] = [
          ...resultRows['access.resource_initialization']!,
          {
            route: anchor.route,
            resource_id: extraPostId,
            resource_type: 'content.post',
            creator_id: actor.accountId,
            initialized_at: laterTime,
          },
        ];
        resultRows['access.resource_role_grant'] = [
          ...resultRows['access.resource_role_grant']!,
          {
            route: anchor.route,
            resource_id: extraPostId,
            subject_kind: 'identity',
            subject_id: actor.accountId,
            subject_role: '',
            grant_role: 'content.post.owner',
            valid: `[${laterTime},)`,
            transaction_id: randomUUID(),
          },
          {
            route: anchor.route,
            resource_id: extraPostId,
            subject_kind: 'active_accounts',
            subject_id: '00000000-0000-0000-0000-000000000000',
            subject_role: '',
            grant_role: 'content.post.standing',
            valid: `[${laterTime},)`,
            transaction_id: randomUUID(),
          },
        ];
        resultRows['core.receipt'] = [
          ...resultRows['core.receipt']!,
          {
            partition_no: homePartition,
            principal_kind: 'account',
            principal_id: actor.accountId,
            command_kind: 'content.post.create',
            idempotency_key: `growth-seed-post-${name}-${ordinal}`,
            request_digest: Buffer.alloc(32),
            epoch: 1,
            position: extraPosition,
            transaction_id: extraTransaction,
            response: value,
          },
        ];
        resultRows['core.outbox'] = [
          ...resultRows['core.outbox']!,
          {
            partition_no: homePartition,
            position: extraPosition,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: randomUUID(),
            type: 'com.rezics.content.post.created.v1',
            subject: extraPostId,
            data: { ...value, actorId: actor.accountId },
          },
        ];
        resultRows['editorial.write_basis'] = [
          ...resultRows['editorial.write_basis']!,
          {
            partition_no: homePartition,
            transaction_id: extraTransaction,
            epoch: 1,
            position: extraPosition,
            principal_kind: 'account',
            principal_id: actor.accountId,
            client_id: 'web',
            requested_by: null,
          },
        ];
      }

      if (mode === 'revisions' && anchor) {
        const extraRevisionId = newId(anchor.route);
        const extraTransaction = randomUUID();
        const extraPosition = standardPosition + 1;
        revisionHeads.set(ordinal, extraRevisionId);
        const value = { threadId: anchor.threadId, itemId: anchor.postId, revisionId: extraRevisionId };
        resultRows['content.revision'] = [
          ...resultRows['content.revision']!,
          {
            ...created,
            route: anchor.route,
            thread_id: anchor.threadId,
            post_id: anchor.postId,
            revision_id: extraRevisionId,
            recorded_transaction_id: extraTransaction,
            recorded_at: laterTime,
          },
        ];
        resultRows['core.receipt'] = [
          ...resultRows['core.receipt']!,
          {
            partition_no: homePartition,
            principal_kind: 'account',
            principal_id: actor.accountId,
            command_kind: 'content.post.revise',
            idempotency_key: `growth-seed-revision-${name}-${ordinal}`,
            request_digest: Buffer.alloc(32),
            epoch: 1,
            position: extraPosition,
            transaction_id: extraTransaction,
            response: value,
          },
        ];
        resultRows['core.outbox'] = [
          ...resultRows['core.outbox']!,
          {
            partition_no: homePartition,
            position: extraPosition,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: randomUUID(),
            type: 'com.rezics.content.revision.created.v1',
            subject: extraRevisionId,
            data: { ...value, actorId: actor.accountId },
          },
        ];
        resultRows['editorial.write_basis'] = [
          ...resultRows['editorial.write_basis']!,
          {
            partition_no: homePartition,
            transaction_id: extraTransaction,
            epoch: 1,
            position: extraPosition,
            principal_kind: 'account',
            principal_id: actor.accountId,
            client_id: 'web',
            requested_by: null,
          },
        ];
      }

      return resultRows;
    },
    finish: async (admin, range) => {
      const maxPosition = positionBase + (range.to - 1) * 100 + (mode === 'threads' ? 0 : 1);
      await admin.query('UPDATE core.partition SET position = GREATEST(position, $2) WHERE partition_no = $1', [
        homePartition,
        maxPosition,
      ]);
      if (mode === 'revisions' && anchor && range.to > 0) {
        const head = revisionHeads.get(range.to - 1);
        if (!head) throw new Error('Missing seeded revision head');
        await admin.query('UPDATE content.post SET head_revision_id = $3 WHERE route = $1 AND post_id = $2', [
          anchor.route,
          anchor.postId,
          head,
        ]);
      }
    },
  };
}

async function assertAnchorRelations(growthDb: GrowthDatabase): Promise<void> {
  const relations = [
    ['content.board', 'route'],
    ['content.thread', 'route'],
    ['content.post', 'route'],
    ['content.revision', 'route'],
    ['access.account', 'route'],
    ['access.membership_inverse', 'route'],
    ['access.organization_member', 'route'],
    ['access.resource_grant', 'route'],
    ['access.resource_role_grant', 'route'],
    ['access.resource_denial', 'route'],
  ] as const;
  for (const [relation, routeColumn] of relations) {
    const result = await growthDb.admin.query(
      `SELECT count(*)::integer AS total,
              count(*) FILTER (WHERE ${routeColumn} >> 4 = $1)::integer AS hot
       FROM ${relation}`,
      [homePartition],
    );
    const [total, hot] = Object.values(result.rows[0]!) as [number, number];
    expect(total).toBeGreaterThanOrEqual(ordinalsPerScale);
    expect(hot).toBeGreaterThanOrEqual(ordinalsPerScale);
  }
  for (const relation of ['core.receipt', 'core.outbox', 'editorial.write_basis']) {
    const result = await growthDb.admin.query(
      `SELECT count(*)::integer AS total,
              count(*) FILTER (WHERE partition_no = $1)::integer AS hot
       FROM ${relation}`,
      [homePartition],
    );
    const [total, hot] = Object.values(result.rows[0]!) as [number, number];
    expect(total).toBeGreaterThanOrEqual(ordinalsPerScale);
    expect(hot).toBeGreaterThanOrEqual(ordinalsPerScale);
  }
}

async function observeMaintenance(): Promise<{ requestedCheckpoints: number; vacuums: Record<string, number> }> {
  const checkpoints = await db.admin.query<{ requested: number }>(
    'SELECT num_requested::integer AS requested FROM pg_stat_checkpointer',
  );
  const vacuums = await db.admin.query<{ relation: string; vacuums: number }>(
    `SELECT schemaname || '.' || relname AS relation, vacuum_count::integer AS vacuums
     FROM pg_stat_user_tables WHERE schemaname || '.' || relname = ANY ($1)`,
    [[...seededRelations]],
  );
  return {
    requestedCheckpoints: checkpoints.rows[0]!.requested,
    vacuums: Object.fromEntries(vacuums.rows.map(({ relation, vacuums }) => [relation, vacuums])),
  };
}

async function runCheck(
  name: string,
  mode: GrowthMode,
  anchor: Anchor | null,
  operation: (growthDb: GrowthDatabase) => Promise<unknown>,
): Promise<void> {
  const nextPosition = await db.admin.query<{ position: string }>(
    'SELECT position::text FROM core.partition WHERE partition_no = $1',
    [homePartition],
  );
  const positionBase = Number(BigInt(nextPosition.rows[0]!.position) + 1_000_000n);
  const population = growthPopulation(`growth-content-${name}-${randomUUID()}`, mode, anchor, positionBase);
  const before = await observeMaintenance();
  const report = await checkGrowth(db, {
    name,
    bounds,
    scales,
    repetitions: 3,
    warmups: 1,
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, {
        from: previous * ordinalsPerScale,
        to: scale * ordinalsPerScale,
      });
      if (previous === 0) await assertAnchorRelations(growthDb);
      await growthDb.admin.query('CHECKPOINT');
    },
    operation,
  });
  const after = await observeMaintenance();
  checkObservations.push({
    name,
    requestedCheckpoints: after.requestedCheckpoints - before.requestedCheckpoints,
    vacuums: Object.fromEntries(
      seededRelations.map((relation) => [relation, (after.vacuums[relation] ?? 0) - (before.vacuums[relation] ?? 0)]),
    ),
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  for (const sample of report.samples) {
    for (const [relation, cost] of Object.entries(sample.cost.relations ?? {})) {
      if (relation.startsWith('content.')) expect(cost.sequentialScans ?? 0).toBe(0);
    }
  }
}

test('Thread creation with first post stays within its bound as T grows', async () => {
  await resetCase();
  const anchor = await createAnchor('thread-create-anchor');
  const keys = await Promise.all(Array.from({ length: 12 }, (_, index) => keyForHome(`thread-create-${index}`)));
  let index = 0;
  await runCheck('Thread creation with first post', 'threads', anchor, async (growthDb) => {
    const result = await createThread(
      commandDependencies(growthDb.pool),
      actor,
      {
        title: 'Fixed growth thread',
        body,
        licence: 'MIT',
        subjectIds: [],
        boardId: board.id,
        visibility: 'published',
      },
      requestContext(keys[index++]!),
    );
    return result;
  });
}, 90_000);

test('Reply stays within its bound as p grows', async () => {
  await resetCase();
  const anchor = await createAnchor('reply-anchor');
  await runCheck('Reply', 'posts', anchor, async (growthDb) =>
    createPost(
      commandDependencies(growthDb.pool),
      actor,
      {
        threadId: anchor.threadId,
        parentId: anchor.postId,
        body,
        licence: 'MIT',
        subjectIds: [],
      },
      requestContext(`reply-${Bun.randomUUIDv7()}`),
    ),
  );
}, 90_000);

test('Post edit (new revision) stays within its bound as r grows', async () => {
  await resetCase();
  const anchor = await createAnchor('post-edit-anchor');
  await runCheck('Post edit (new revision)', 'revisions', anchor, async (growthDb) =>
    revisePost(
      commandDependencies(growthDb.pool),
      actor,
      {
        threadId: anchor.threadId,
        itemId: anchor.postId,
        body,
        licence: 'MIT',
        subjectIds: [],
      },
      requestContext(`edit-${Bun.randomUUIDv7()}`),
    ),
  );
}, 90_000);

test('Thread read stays within its bound as T grows', async () => {
  await resetCase();
  const anchor = await createAnchor('thread-read-anchor');
  await runCheck('Thread read', 'threads', anchor, async (growthDb) => {
    const result = await readThread(readDependencies(growthDb.pool), anchor.threadId, readContext());
    expect(result.value?.id).toBe(anchor.threadId);
    return result;
  });
}, 90_000);

test('Post read stays within its bound as T grows', async () => {
  await resetCase();
  const anchor = await createAnchor('post-read-anchor');
  await runCheck('Post read', 'threads', anchor, async (growthDb) => {
    const result = await readPost(readDependencies(growthDb.pool), anchor.threadId, anchor.postId, readContext());
    expect(result.value?.id).toBe(anchor.postId);
    return result;
  });
}, 90_000);

test('Revision read stays within its bound as T grows', async () => {
  await resetCase();
  const anchor = await createAnchor('revision-read-anchor');
  await runCheck('Revision read', 'threads', anchor, async (growthDb) => {
    const result = await readPost(
      readDependencies(growthDb.pool),
      anchor.threadId,
      anchor.postId,
      readContext(),
      anchor.revisionId,
    );
    expect(result.value && !isErasedPlaceholder(result.value) ? result.value.revisionId : null).toBe(anchor.revisionId);
    return result;
  });
}, 90_000);

test('Post keyset page stays within its bound as p grows', async () => {
  await resetCase();
  const anchor = await createAnchor('post-page-anchor');
  await runCheck('Post keyset page', 'posts', anchor, async (growthDb) => {
    const page = await listThreadPosts(readDependencies(growthDb.pool), anchor.threadId, readContext(), undefined, 1);
    expect(page.entries[0]?.id).toBe(anchor.postId);
    return page;
  });
}, 90_000);

test('Revision keyset page stays within its bound as r grows', async () => {
  await resetCase();
  const anchor = await createAnchor('revision-page-anchor');
  const nextRevision = await revisePost(
    commandDependencies(),
    actor,
    {
      threadId: anchor.threadId,
      itemId: anchor.postId,
      body,
      licence: 'MIT',
      subjectIds: [],
    },
    requestContext('revision-page-fixed-second-revision'),
  );
  const firstPage = await listPostRevisions(
    readDependencies(),
    anchor.threadId,
    anchor.postId,
    readContext(),
    undefined,
    1,
  );
  expect(firstPage.entries[0]?.id).toBe(anchor.revisionId);
  expect(firstPage.nextCursor).not.toBeNull();
  const cursor = firstPage.nextCursor!;
  await runCheck('Revision keyset page', 'revisions', anchor, async (growthDb) => {
    const page = await listPostRevisions(
      readDependencies(growthDb.pool),
      anchor.threadId,
      anchor.postId,
      readContext(),
      cursor,
      1,
    );
    expect(page.entries[0]?.id).toBe(nextRevision.value.revisionId);
    return page;
  });
}, 90_000);

test('Public board read stays within its bound as T grows', async () => {
  await resetCase();
  const anchor = await createAnchor('board-read-anchor');
  await runCheck('Public board read', 'threads', anchor, async (growthDb) => {
    const result = await readBoard(readDependencies(growthDb.pool), board.id, {
      actor: anonymous,
      deadline: Date.now() + 90_000,
    });
    expect(result.value?.id).toBe(board.id);
    return result;
  });
}, 90_000);

test('growth-threads grows request no checkpoint and leave one vacuum per scale to the harness', () => {
  expect(checkObservations).toHaveLength(9);
  for (const { name, requestedCheckpoints, vacuums } of checkObservations) {
    expect(requestedCheckpoints, `${name} requested checkpoints`).toBe(0);
    for (const relation of seededRelations)
      expect(vacuums[relation], `${name} vacuums of ${relation}`).toBe(scales.length);
  }
});
