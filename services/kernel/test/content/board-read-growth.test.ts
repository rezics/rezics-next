import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { installResourceRoleCatalogue, resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { runCommand } from '../../src/command/command.ts';
import { productionActions } from '../support/production-actions.ts';
import {
  applyBoardCandidate,
  createBoardEffect,
  pageBoardCandidates,
  readBoardCandidates,
  type BoardCandidate,
} from '../../src/content/board-projection.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  capture,
  checkGrowth,
  GrowthBoundError,
  openGrowthDatabase,
  seed,
  type GrowthCheck,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

const db = await openGrowthDatabase();
const fixture = await standingFixture(['board:create', 'realm:read', 'realm:participate']);

const checkScales = [1, 4, 16] as const;
const checkPopulationSize = 500;
const checkRouteKey = new Uint8Array(32).fill(37);
const checkTokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(38)]]) };
const subjectRoute = 0x2468;
const homeRoute = 0x1357;
const bodyBytes = Buffer.from(serializeDocument(fromPlainText('A fixed growth board opening post.')));
const bodyHash = createHash('sha256').update(bodyBytes).digest();
const growthTime = '2026-10-20T00:00:00.000Z';

type AccountActor = Extract<Awaited<ReturnType<typeof fixture.context>>['actor'], { kind: 'account' }>;
type BoardHost = { route: number; id: string };
type KernelCallOptions = { bearer?: string; key?: string; body?: unknown };
type KernelResult = { response: Response; value: Record<string, any> };

let actor: AccountActor;
let bearer = '';
let boardHost: BoardHost;
let readBoards: string[] = [];
let candidateBoards: string[] = [];
let measuredConcepts: string[] = [];
let diagnosticConcept = '';

const kernel = createKernel({
  requestDeadlineMs: 30_000,
  pool: db.pool,
  routeKey: checkRouteKey,
  tokens: checkTokens,
  access: fixture.access,
  writeRate: createWriteRateLimiter({
    secret: 'growth-boards-private-write-rate-secret-32bytes',
    overrides: JSON.stringify({
      anonymous: { write: { maximum: 100000, seconds: 86400 } },
      'new-account': { write: { maximum: 100000, seconds: 86400 } },
    }),
  }),
  content: { cursorNow: () => Date.UTC(2026, 9, 28) },
});

beforeAll(async () => {
  installResourceRoleCatalogue(fixture.access, resolveResourceRoles(productionActions()));
  await fixture.reset();
  await bootstrapRelease(db.pool, bundledRelease);

  const issued: string[] = [];
  const authenticate = fixture.access.authenticate;
  fixture.access.authenticate = (token, context) => {
    issued.push(token);
    return authenticate(token, { ...context, pool: db.pool });
  };
  try {
    actor = (await fixture.context()).actor as AccountActor;
    bearer = issued[0]!;
  } finally {
    fixture.access.authenticate = authenticate;
  }

  const release = await activeRelease(db.pool);
  if (!release) throw new Error('The bundled semantic release was not activated');
  const schemeId = await createConcept(release, { type: 'skos:ConceptScheme', labels: { en: 'Growth scheme' } });
  boardHost = await createBoardHost(schemeId);
  const concepts: string[] = [];
  for (let index = 0; index < 19; index++)
    concepts.push(
      await createConcept(release, {
        type: 'skos:Concept',
        labels: { en: `Growth concept ${index}` },
        statements: {
          'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } }],
        },
      }),
    );
  measuredConcepts = concepts.slice(0, 6);
  diagnosticConcept = concepts[6]!;

  await fixture.grant(fixture.actor, 'board:create', { route: boardHost.route, id: boardHost.id });
  await fixture.grant(fixture.actor, 'realm:participate', { route: boardHost.route, id: boardHost.id });
  await fixture.grant(fixture.actor, 'realm:read', { route: boardHost.route, id: boardHost.id });
  for (const conceptId of concepts)
    await fixture.grant(fixture.actor, 'subject:read', { route: routeOf(conceptId)!, id: conceptId });

  readBoards = await seedBoardFixtures(`growth-read-board-fixtures-${randomUUID()}`, concepts.slice(7, 13));
  candidateBoards = await seedBoardFixtures(`growth-candidate-board-fixtures-${randomUUID()}`, concepts.slice(13, 19));
}, 90_000);

afterAll(async () => {
  await fixture.close();
  await db.close();
});

async function request(method: string, path: string, options: KernelCallOptions = {}): Promise<KernelResult> {
  const headers = new Headers();
  if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(options.key));
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const text = await response.text();
  return { response, value: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

async function createConcept(
  release: NonNullable<Awaited<ReturnType<typeof activeRelease>>>,
  item: unknown,
): Promise<string> {
  const id = newId(subjectRoute);
  await createSubject(db.pool, {
    actor,
    target: { route: subjectRoute, id },
    idempotencyKey: randomUUID(),
    digest: createHash('sha256').update(randomUUID()).digest(),
    item,
    release,
    authorize: async () => true,
  });
  return id;
}

async function createBoardHost(schemeId: string): Promise<BoardHost> {
  const route = homeRoute;
  const spaceId = newId(route);
  const spaceRevisionId = newId(route);
  const realmId = newId(route);
  const realmRevisionId = newId(route);
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO community.space(route, space_id, state, head_revision_id, created_at, creator)
       VALUES ($1, $2, 'active', $3, $4, $5)`,
      [route, spaceId, spaceRevisionId, growthTime, actor.accountId],
    );
    await client.query(
      `INSERT INTO community.space_revision(route, space_id, revision_id, predecessor, address, title, summary,
                                             created_at, author)
       VALUES ($1, $2, $3, NULL, NULL, 'Growth host', '', $4, $5)`,
      [route, spaceId, spaceRevisionId, growthTime, actor.accountId],
    );
    await client.query(
      `INSERT INTO community.realm(route, realm_id, space_id, state, visibility, context_id, head_revision_id,
                                   created_at, creator)
       VALUES ($1, $2, $3, 'active', 'public', $4, $5, $6, $7)`,
      [route, realmId, spaceId, GLOBAL_CONTEXT, realmRevisionId, growthTime, actor.accountId],
    );
    await client.query(
      `INSERT INTO community.realm_revision(route, realm_id, revision_id, predecessor, title, summary, visibility,
                                            context_id, created_at, author)
       VALUES ($1, $2, $3, NULL, 'Growth Realm', '', 'public', $4, $5, $6)`,
      [route, realmId, realmRevisionId, GLOBAL_CONTEXT, growthTime, actor.accountId],
    );
    await client.query('UPDATE community.realm SET board_scheme_id = $3 WHERE route = $1 AND realm_id = $2', [
      route,
      realmId,
      schemeId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { route, id: realmId };
}

async function seedBoardFixtures(name: string, conceptIds: readonly string[]): Promise<string[]> {
  const boardIds = conceptIds.map(() => newId(boardHost.route));
  const boards: Population = {
    name,
    hotPartition: partitionOf(boardHost.route),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const boardId = boardIds[ordinal]!;
      const transactionId = randomUUID();
      return {
        'content.board': [
          {
            route: boardHost.route,
            board_id: boardId,
            realm_id: boardHost.id,
            subject_id: conceptIds[ordinal]!,
            title: 'Growth board',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: growthTime,
            purpose: 'discussion',
          },
        ],
        'access.resource_initialization': [
          {
            route: boardHost.route,
            resource_id: boardId,
            resource_type: 'content.board',
            creator_id: actor.accountId,
            initialized_at: growthTime,
          },
        ],
        'access.resource_grant': [
          {
            route: boardHost.route,
            resource_id: boardId,
            subject_id: actor.accountId,
            subject_role: '',
            action: 'board:read',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
      };
    },
  };
  await seed(db, boards, { from: 0, to: boardIds.length });
  return boardIds;
}

function boardHistory(
  name: string,
  target: BoardHost,
  grantAction: string,
  grantRole: string,
  additionalActions: readonly string[] = [],
): Population {
  return {
    name,
    hotPartition: partitionOf(target.route),
    hotShare: 0.5,
    rows: ({ ordinal, route: placedRoute, hot }) => {
      const route = hot ? target.route : placedRoute;
      const spaceId = newId(route);
      const spaceRevisionId = newId(route);
      const realmId = newId(route);
      const realmRevisionId = newId(route);
      const boardId = newId(route);
      const subjectId = newId(route);
      const transactionId = randomUUID();
      const accountId = newId(route);
      const at = new Date(Date.UTC(2020, 0, 1) + ordinal * 1000);
      return {
        'community.space': [
          {
            route,
            space_id: spaceId,
            state: 'active',
            head_revision_id: spaceRevisionId,
            created_at: at,
            creator: actor.accountId,
          },
        ],
        'community.space_revision': [
          {
            route,
            space_id: spaceId,
            revision_id: spaceRevisionId,
            predecessor: null,
            address: null,
            title: 'Unrelated growth host',
            summary: '',
            created_at: at,
            author: actor.accountId,
          },
        ],
        'community.realm': [
          {
            route,
            realm_id: realmId,
            space_id: spaceId,
            state: 'active',
            visibility: 'public',
            context_id: GLOBAL_CONTEXT,
            head_revision_id: realmRevisionId,
            created_at: at,
            creator: actor.accountId,
            board_scheme_id: null,
            votes: { upvote: 1, downvote: -1 },
          },
        ],
        'community.realm_revision': [
          {
            route,
            realm_id: realmId,
            revision_id: realmRevisionId,
            predecessor: null,
            title: 'Unrelated growth Realm',
            summary: '',
            visibility: 'public',
            context_id: GLOBAL_CONTEXT,
            created_at: at,
            author: actor.accountId,
            board_scheme_id: null,
            votes: { upvote: 1, downvote: -1 },
          },
        ],
        'content.board': [
          {
            route,
            board_id: boardId,
            realm_id: hot ? target.id : realmId,
            subject_id: subjectId,
            title: 'Unrelated growth board',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: at,
            purpose: 'discussion',
          },
        ],
        'access.account': [
          {
            route,
            account_id: accountId,
            kind: 'actor',
            state: 'active',
            transaction_id: transactionId,
          },
        ],
        'access.resource_initialization': [
          {
            route,
            resource_id: boardId,
            resource_type: 'content.board',
            creator_id: actor.accountId,
            initialized_at: at,
          },
        ],
        'access.resource_grant': [grantAction, ...additionalActions].map((action) => ({
          route,
          resource_id: boardId,
          subject_id: accountId,
          subject_role: '',
          action,
          valid: '(,)',
          transaction_id: transactionId,
          subject_kind: 'identity',
        })),
        'access.resource_role_grant': [
          {
            route,
            resource_id: boardId,
            subject_kind: 'identity',
            subject_id: accountId,
            subject_role: '',
            grant_role: grantRole,
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
      };
    },
  };
}

async function checkWithDiagnostics(
  check: GrowthCheck,
  diagnostic: () => Promise<unknown>,
): Promise<Awaited<ReturnType<typeof checkGrowth>>> {
  try {
    return await checkGrowth(db, check);
  } catch (error) {
    if (error instanceof GrowthBoundError) {
      const measured = await capture(db, diagnostic);
      console.info(
        JSON.stringify({
          check: check.name,
          violations: error.violations,
          samples: error.samples,
          sql: measured.capture.statements,
          backgroundSql: measured.capture.backgroundStatements,
          plans: measured.capture.plans,
          backgroundPlans: measured.capture.backgroundPlans,
        }),
      );
    }
    throw error;
  }
}

const sourceRoute = 0x1234;
const boardRoute = 0x5678;
const authorId = newId(0x9abc);
const createdAt = '2026-10-25T00:00:00.000Z';
const populationSize = 500;
const scales = [1, 8, 64] as const;

async function createBoard(boardId: string): Promise<void> {
  await db.admin.query(
    `INSERT INTO content.board
     (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
     VALUES ($1, $2, $3, 'Growth board', 'published', 1, $4) ON CONFLICT DO NOTHING`,
    [boardRoute, boardId, newId(0xdef0), randomUUID()],
  );
}

async function createSource(boardId: string): Promise<{ threadId: string; event: CloudEvent }> {
  await createBoard(boardId);
  const threadId = newId(sourceRoute);
  const itemId = newId(sourceRoute);
  const revisionId = newId(sourceRoute);
  const fixture = await runCommand(db.pool, { partition: partitionOf(sourceRoute) }, async (tx, context) => {
    await tx.query(
      `INSERT INTO content.thread
       (route, thread_id, author_account_id, board_id, title, visibility, security_revision, recorded_transaction_id, created_at)
       VALUES ($1, $2, $3, $4, 'Anchor', 'published', 1, $5, $6)`,
      [sourceRoute, threadId, authorId, boardId, context.transactionId, createdAt],
    );
    return {
      value: null,
      events: [
        {
          type: 'com.rezics.content.thread.created.v1',
          subject: threadId,
          data: { threadId, itemId, revisionId, actorId: authorId, ...SUBJECT_THREAD_EVENT_FIELDS },
        },
      ],
    };
  });
  return {
    threadId,
    event: {
      id: randomUUID(),
      type: 'com.rezics.content.thread.created.v1',
      source: `urn:rezics:log:${fixture.partition}.${fixture.epoch}`,
      sequence: fixture.position.toString().padStart(19, '0'),
      subject: threadId,
      time: createdAt,
      data: { threadId, itemId, revisionId, actorId: authorId, ...SUBJECT_THREAD_EVENT_FIELDS },
    },
  } as { threadId: string; event: CloudEvent };
}

test('Board projection stays within its bound as T grows', async () => {
  const boardId = newId(boardRoute);
  const { event } = await createSource(boardId);

  // This population matches production content.thread rows and grows the source anchor partition.
  const threads: Population = {
    name: `growth-board-projection-threads-${randomUUID()}`,
    hotPartition: partitionOf(sourceRoute),
    hotShare: 1,
    rows: ({ route }) => ({
      'content.thread': [
        {
          route,
          thread_id: newId(route),
          author_account_id: authorId,
          board_id: boardId,
          title: 'Growth neighbour',
          visibility: 'published',
          security_revision: 1,
          recorded_transaction_id: randomUUID(),
          created_at: createdAt,
        },
      ],
    }),
  };
  // This population matches projected content.board_thread rows and grows the destination anchor partition.
  const candidates: Population = {
    name: `growth-board-projection-candidates-${randomUUID()}`,
    hotPartition: partitionOf(boardRoute),
    hotShare: 1,
    rows: ({ route }) => {
      const threadId = newId(route);
      return {
        'content.thread': [
          {
            route,
            thread_id: threadId,
            author_account_id: authorId,
            board_id: boardId,
            title: 'Projected neighbour',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: randomUUID(),
            created_at: createdAt,
          },
        ],
        'content.board_thread': [
          {
            route: boardRoute,
            board_id: boardId,
            thread_id: threadId,
            created_at: createdAt,
            source_epoch: 1,
            source_position: 1,
            source_revision_id: null,
          },
        ],
      };
    },
  };

  const report = await checkGrowth(db, {
    name: 'Board projection',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, threads, {
        from: previous * populationSize,
        to: scale * populationSize,
      });
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, candidates, {
        from: previous * populationSize,
        to: scale * populationSize,
      });
    },
    operation: async (growthDb) => createBoardEffect(growthDb.pool).run(event),
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 90_000);

test('Board candidate page stays within its bound as d grows', async () => {
  const boardId = newId(boardRoute);
  await createBoard(boardId);
  const cursorAt = '2026-10-25T00:00:00.000Z';
  const older = Array.from({ length: 8 }, (_, index): BoardCandidate => ({
    id: newId(sourceRoute),
    boardId,
    createdAt: `2026-10-24T23:59:${String(59 - index).padStart(2, '0')}.000Z`,
    epoch: 1,
    position: BigInt(index + 1),
  }));
  const cursor: BoardCandidate = {
    id: newId(sourceRoute),
    boardId,
    createdAt: cursorAt,
    epoch: 1,
    position: 20n,
  };
  for (const candidate of [...older, cursor]) await applyBoardCandidate(db.pool, candidate);
  const expected = await readBoardCandidates(db.pool, boardId, { createdAt: cursorAt, id: cursor.id }, 8);

  // This population matches projected rows, growing the measured board and its keyset depth.
  const onBoard: Population = {
    name: `growth-board-page-anchor-${randomUUID()}`,
    hotPartition: partitionOf(boardRoute),
    hotShare: 1,
    rows: ({ route, ordinal }) => {
      const threadId = newId(route);
      const time = `2026-10-25T00:01:${String(ordinal % 60).padStart(2, '0')}.000Z`;
      return {
        'content.thread': [
          {
            route,
            thread_id: threadId,
            author_account_id: authorId,
            board_id: boardId,
            title: 'Measured board thread',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: randomUUID(),
            created_at: time,
          },
        ],
        'content.board_thread': [
          {
            route: boardRoute,
            board_id: boardId,
            thread_id: threadId,
            created_at: time,
            source_epoch: 1,
            source_position: ordinal + 1,
            source_revision_id: null,
          },
        ],
      };
    },
  };
  // This population matches projected rows on other boards in the same route partition, growing total T.
  const otherBoards: Population = {
    name: `growth-board-page-other-${randomUUID()}`,
    hotPartition: partitionOf(boardRoute),
    hotShare: 1,
    rows: ({ route, ordinal }) => {
      const otherBoard = newId(boardRoute);
      const threadId = newId(route);
      const time = `2026-10-25T00:01:${String(ordinal % 60).padStart(2, '0')}.000Z`;
      return {
        'content.thread': [
          {
            route,
            thread_id: threadId,
            author_account_id: authorId,
            board_id: otherBoard,
            title: 'Other board thread',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: randomUUID(),
            created_at: time,
          },
        ],
        'content.board_thread': [
          {
            route: boardRoute,
            board_id: otherBoard,
            thread_id: threadId,
            created_at: time,
            source_epoch: 1,
            source_position: ordinal + 1,
            source_revision_id: null,
          },
        ],
      };
    },
  };

  const report = await checkGrowth(db, {
    name: 'Board candidate page',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, onBoard, {
        from: previous * populationSize,
        to: scale * populationSize,
      });
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, otherBoards, {
        from: previous * populationSize,
        to: scale * populationSize,
      });
    },
    operation: async (growthDb) => {
      const page = await readBoardCandidates(growthDb.pool, boardId, { createdAt: cursorAt, id: cursor.id }, 8);
      expect(page.candidates.map(({ id }) => id)).toEqual(expected.candidates.map(({ id }) => id));
      return page;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 90_000);

test.serial(
  'Concept board creation stays within its bound as boards grow',
  async () => {
    const history = boardHistory(
      `growth-concept-board-create-${randomUUID()}`,
      boardHost,
      'board:create',
      'community.realm.moderator',
      ['realm:participate'],
    );
    let diagnosticAvailable = true;
    const creationStatuses: number[] = [];
    const operation = async (_growthDb: GrowthDatabase, _scale: number, repetition: number) => {
      const conceptId = measuredConcepts[repetition];
      if (!conceptId) throw new Error(`No fresh concept was prepared for board creation ${repetition}`);
      const result = await request('POST', `/v1/realms/${boardHost.id}/boards`, {
        bearer,
        key: randomUUID(),
        body: { conceptId, title: 'Growth board', visibility: 'published' },
      });
      creationStatuses.push(result.response.status);
      if (result.response.status === 201) {
        expect(result.value.board).toMatchObject({ realmId: boardHost.id, title: 'Growth board' });
        expect(result.value.board).toHaveProperty('id', expect.any(String));
      }
      return result;
    };
    const report = await checkWithDiagnostics(
      {
        name: 'Concept board creation',
        scales: checkScales,
        repetitions: 1,
        warmups: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        grow: async (growthDb, scale, previous) => {
          await seed(growthDb, history, {
            from: checkPopulationSize * previous,
            to: checkPopulationSize * scale,
          });
        },
        operation,
      },
      async () => {
        if (!diagnosticAvailable) throw new Error('No fresh diagnostic concept remains');
        diagnosticAvailable = false;
        const result = await request('POST', `/v1/realms/${boardHost.id}/boards`, {
          bearer,
          key: randomUUID(),
          body: { conceptId: diagnosticConcept, title: 'Growth board', visibility: 'published' },
        });
        return result;
      },
    );
    expect(report.samples.map(({ scale }) => scale)).toEqual([...checkScales]);
    expect(creationStatuses).toEqual(Array.from({ length: 6 }, () => 201));
  },
  240_000,
);

test.serial(
  'Realm board read by concept stays within its bound as boards grow',
  async () => {
    const history = boardHistory(
      `growth-realm-board-read-${randomUUID()}`,
      boardHost,
      'realm:read',
      'community.realm.moderator',
    );
    const operation = async (_growthDb: GrowthDatabase, _scale: number, repetition: number) => {
      const boardId = readBoards[repetition];
      if (!boardId) throw new Error(`No fresh Realm board was prepared for read ${repetition}`);
      const result = await request('GET', `/v1/boards/${boardId}`, { bearer });
      expect(result.response.status).toBe(200);
      expect(result.value.board).toMatchObject({ id: boardId, realmId: boardHost.id });
      return result;
    };
    const diagnostic = async () => {
      const boardId = readBoards.at(-1);
      if (!boardId) throw new Error('No Realm board remains for diagnostics');
      const result = await request('GET', `/v1/boards/${boardId}`, { bearer });
      expect(result.response.status).toBe(200);
      return result;
    };
    const report = await checkWithDiagnostics(
      {
        name: 'Realm board read by concept',
        scales: checkScales,
        repetitions: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        grow: async (growthDb, scale, previous) => {
          await seed(growthDb, history, {
            from: checkPopulationSize * previous,
            to: checkPopulationSize * scale,
          });
        },
        operation,
      },
      diagnostic,
    );
    expect(report.samples.map(({ scale }) => scale)).toEqual([...checkScales]);
  },
  240_000,
);

test.serial(
  'Ascending board candidates and the oldest listing stay within their bound as candidates grow',
  async () => {
    const history = boardHistory(
      `growth-board-oldest-${randomUUID()}`,
      boardHost,
      'realm:read',
      'community.realm.moderator',
    );
    const boardRoute = boardHost.route;
    const onBoards = await Promise.all(
      candidateBoards.map((boardId) =>
        boardCandidatePopulation(`growth-board-oldest-anchor-${randomUUID()}`, boardId, boardRoute),
      ),
    );
    const otherBoards = otherBoardCandidatePopulation(
      `growth-board-oldest-neighbours-${randomUUID()}`,
      boardRoute,
      boardHost.id,
    );

    const report = await checkWithDiagnostics(
      {
        name: 'Ascending board candidates and the oldest listing',
        scales: checkScales,
        repetitions: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        grow: async (growthDb, scale, previous) => {
          const range = {
            from: checkPopulationSize * previous,
            to: checkPopulationSize * scale,
          };
          await seed(growthDb, history, range);
          for (const onBoard of onBoards) await seed(growthDb, onBoard.growth, range);
          await seed(growthDb, otherBoards, range);
        },
        async operation(growthDb, _scale, repetition) {
          const boardId = candidateBoards[repetition];
          const onBoard = onBoards[repetition];
          const after = onBoard?.cursor;
          if (!boardId || !onBoard || !after)
            throw new Error(`No fresh ascending board page was prepared for run ${repetition}`);
          const ascending = await pageBoardCandidates(growthDb.pool, boardId, after, 20, 'asc');
          expect(ascending.candidates.map(({ id }) => id)).toEqual(onBoard.ascendingPage);
          expect(ascending.next).not.toBeNull();

          const oldest = await request('GET', `/v1/boards/${boardId}/threads?limit=20&sort=oldest`, { bearer });
          if (oldest.response.status !== 200)
            throw new Error(`Oldest listing failed with ${oldest.response.status}: ${JSON.stringify(oldest.value)}`);
          if (oldest.value.threads.length !== 20)
            throw new Error(
              `Oldest listing returned ${oldest.value.threads.length} threads: ${JSON.stringify(oldest.value)}`,
            );
          expect(oldest.value.next).toEqual(expect.any(String));
          return { ascending, oldest };
        },
      },
      async () => {
        const boardId = candidateBoards.at(-1);
        const onBoard = onBoards.at(-1);
        if (!boardId || !onBoard?.cursor) throw new Error('No spare ascending board page was prepared for diagnostics');
        const ascending = await pageBoardCandidates(db.pool, boardId, onBoard.cursor, 20, 'asc');
        const oldest = await request('GET', `/v1/boards/${boardId}/threads?limit=20&sort=oldest`, { bearer });
        return { ascending, oldest };
      },
    );
    expect(report.samples.map(({ scale }) => scale)).toEqual([...checkScales]);
  },
  240_000,
);

async function boardCandidatePopulation(name: string, boardId: string, boardRoute: number) {
  let cursor: { createdAt: string; id: string } | null = null;
  const ascendingPage: string[] = [];
  const staticCandidates: Population = {
    name: `${name}-fixed-neighbourhood`,
    hotPartition: partitionOf(sourceRoute),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const threadId = newId(sourceRoute);
      const postId = newId(sourceRoute);
      const revisionId = newId(sourceRoute);
      let createdAt: string;
      if (ordinal < 20) {
        createdAt = new Date(Date.UTC(2010, 0, 1) + ordinal * 1000).toISOString();
      } else if (ordinal === 20) {
        createdAt = '2025-01-01T00:00:00.000Z';
        cursor = { createdAt, id: threadId };
      } else {
        createdAt = new Date(Date.UTC(2025, 0, 1) + (ordinal - 20) * 1000).toISOString();
        ascendingPage.push(threadId);
      }
      return candidateRows(boardId, boardRoute, threadId, postId, revisionId, createdAt, ordinal + 1);
    },
  };
  // Seed a fixed oldest page, cursor, and ascending page; the growth series adds older cursor history and newer candidates.
  await seed(db, staticCandidates, { from: 0, to: 41 });
  const growth: Population = {
    name,
    hotPartition: partitionOf(sourceRoute),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const threadId = newId(sourceRoute);
      const postId = newId(sourceRoute);
      const revisionId = newId(sourceRoute);
      const createdAt = new Date(Date.UTC(2011, 0, 1) + ordinal * 1000).toISOString();
      return candidateRows(boardId, boardRoute, threadId, postId, revisionId, createdAt, ordinal + 1000);
    },
  };
  return {
    cursor,
    ascendingPage,
    growth,
  };
}

function candidateRows(
  boardId: string,
  boardRoute: number,
  threadId: string,
  postId: string,
  revisionId: string,
  createdAt: string,
  position: number,
) {
  const route = routeOf(threadId)!;
  const transactionId = randomUUID();
  const at = new Date(createdAt);
  return {
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
    'access.resource_grant': [
      {
        route,
        resource_id: threadId,
        subject_id: actor.accountId,
        subject_role: '',
        action: 'thread:read',
        valid: '(,)',
        transaction_id: transactionId,
      },
      {
        route,
        resource_id: postId,
        subject_id: actor.accountId,
        subject_role: '',
        action: 'post:read',
        valid: '(,)',
        transaction_id: transactionId,
      },
    ],
    'content.thread': [
      {
        route,
        thread_id: threadId,
        author_account_id: actor.accountId,
        board_id: boardId,
        first_post_id: postId,
        title: 'Growth listing thread',
        visibility: 'published',
        security_revision: 1,
        recorded_transaction_id: transactionId,
        created_at: at,
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
    'content.revision': [
      {
        route,
        thread_id: threadId,
        post_id: postId,
        revision_id: revisionId,
        body: bodyBytes,
        body_sha256: bodyHash,
        search_text: 'A fixed growth board opening post.',
        licence: 'MIT',
        subject_ids: [],
        board_id: boardId,
        availability: 'available',
        recorded_transaction_id: transactionId,
        recorded_at: at,
        media_ids: [],
      },
    ],
    'content.board_thread': [
      {
        route: boardRoute,
        board_id: boardId,
        thread_id: threadId,
        created_at: at,
        source_epoch: 1,
        source_position: position,
        source_revision_id: revisionId,
      },
    ],
  };
}

function otherBoardCandidatePopulation(name: string, boardRoute: number, realmId: string): Population {
  return {
    name,
    hotPartition: partitionOf(sourceRoute),
    hotShare: 0.5,
    rows: ({ ordinal, route: placedRoute }) => {
      const route = placedRoute;
      const otherBoardId = newId(boardRoute);
      const threadId = newId(route);
      const transactionId = randomUUID();
      const createdAt = new Date(Date.UTC(2011, 0, 1) + ordinal * 1000).toISOString();
      return {
        'content.board': [
          {
            route: boardRoute,
            board_id: otherBoardId,
            realm_id: realmId,
            subject_id: newId(boardRoute),
            title: 'Unrelated candidate board',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
          },
        ],
        'content.thread': [
          {
            route,
            thread_id: threadId,
            author_account_id: actor.accountId,
            board_id: otherBoardId,
            title: 'Unrelated board thread',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: createdAt,
          },
        ],
        'content.board_thread': [
          {
            route: boardRoute,
            board_id: otherBoardId,
            thread_id: threadId,
            created_at: createdAt,
            source_epoch: 1,
            source_position: ordinal + 1,
            source_revision_id: null,
          },
        ],
      };
    },
  };
}
