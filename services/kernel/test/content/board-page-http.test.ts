import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { realmBoardWorld } from './realm-board-create-support.ts';
import {
  projectCommunityActivitySelection,
  projectCommunityComments,
  type CommunityActivityWitness,
} from '../../src/content/community-projection/index.ts';
import {
  BoardOpeningChangedError,
  createBoardPageReader,
  projectBoardOpeningReactionCounts,
} from '../../src/content/board-page.ts';
import { createRealmParticipationCheck } from '../../src/community/participation.ts';
import { testTokens } from '../support/test-kernel.ts';
import type { ConversationActivitySelection } from '../../src/content/conversation-activity.ts';
import type { AnchoredPosition } from '../../src/content/model.ts';
import type { Actor } from '../../src/request/access.ts';

let world: Awaited<ReturnType<typeof realmBoardWorld>>;

beforeAll(async () => {
  world = await realmBoardWorld();
}, 120_000);

afterAll(async () => {
  await world?.close();
});

test('Board comments require a current matching cohort witness and reaction zero differs from unavailable', () => {
  const threadId = 'thread-one';
  const publicZero: CommunityActivityWitness = {
    state: 'current',
    threadId,
    cohort: { kind: 'public' },
    count: { kind: 'exact', value: 0 },
    lastActivityAt: null,
    source: { epoch: 2, position: '10' },
  };
  const privateActivity: CommunityActivityWitness = {
    ...publicZero,
    cohort: { kind: 'viewer', accountId: 'account-one' },
    count: { kind: 'lower-bound', value: 2 },
    lastActivityAt: '2026-11-04T00:00:00.000Z',
  };
  const anonymous = { kind: 'anonymous' } as Actor;
  const account = { kind: 'account', accountId: 'account-one' } as Actor;

  expect(projectCommunityComments(threadId, publicZero, anonymous)).toMatchObject({
    state: 'current',
    cohort: 'public',
    count: { kind: 'exact', value: 0 },
    lastActivityAt: null,
  });
  expect(projectCommunityComments(threadId, privateActivity, anonymous)).toEqual({ state: 'unavailable' });
  expect(projectCommunityComments(threadId, privateActivity, account)).toMatchObject({
    state: 'current',
    cohort: 'viewer',
    count: { kind: 'lower-bound', value: 2 },
  });
  expect(projectCommunityComments('other-thread', publicZero, anonymous)).toEqual({ state: 'unavailable' });

  const selected = projectCommunityComments(threadId, publicZero, anonymous);
  // A producer may refresh a retained summary object while the page hydrates.
  Object.assign(publicZero.count, { value: 1 });
  Object.assign(publicZero.source, { position: '11' });
  const refreshed = projectCommunityComments(threadId, publicZero, anonymous);
  expect(selected).toMatchObject({ count: { value: 0 }, source: { position: '10' } });
  expect(refreshed).toMatchObject({ count: { value: 1 }, source: { position: '11' } });
  expect(selected).not.toEqual(refreshed);

  expect(projectBoardOpeningReactionCounts(true, {}, { epoch: 2, position: '10' })).toEqual({
    state: 'as-of',
    values: {},
    source: { epoch: 2, position: '10' },
  });
  expect(projectBoardOpeningReactionCounts(true, undefined, undefined)).toEqual({ state: 'unavailable' });

  const selectedValues = { like: 2 };
  const selectedSource = { epoch: 2, position: '12' };
  const selectedCounts = projectBoardOpeningReactionCounts(true, selectedValues, selectedSource);
  Object.assign(selectedValues, { like: 3 });
  Object.assign(selectedSource, { position: '13' });
  expect(selectedCounts).toEqual({ state: 'as-of', values: { like: 2 }, source: { epoch: 2, position: '12' } });
  expect(projectBoardOpeningReactionCounts(true, selectedValues, selectedSource)).toEqual({
    state: 'as-of',
    values: { like: 3 },
    source: { epoch: 2, position: '13' },
  });
});

test('Board projects only the producer count and source head while retaining its partition anchor', () => {
  const threadId = 'thread-one';
  const anchor = { partition: {} as AnchoredPosition['partition'], epoch: 2, position: 12n };
  const selected: ConversationActivitySelection = {
    threadId,
    status: 'current',
    cohort: 'public',
    replyCount: { kind: 'lower-bound', value: 10_000 },
    lastContributionAt: '2026-11-04T00:00:00.000Z',
    witness: {
      threadId,
      boardId: 'board-one',
      threadSecurityRevision: '1',
      boardSecurityRevision: '1',
      realmId: null,
      boardGeneration: '1',
      generation: '1',
      sourceHead: { epoch: 3, position: 17n, eventSeq: 1_000 },
      source: anchor,
    },
  };
  expect(projectCommunityActivitySelection([selected])).toEqual({
    items: [
      {
        state: 'current',
        threadId,
        cohort: { kind: 'public' },
        count: { kind: 'lower-bound', value: 10_000 },
        lastActivityAt: '2026-11-04T00:00:00.000Z',
        source: { epoch: 3, position: '17' },
      },
    ],
    anchors: [anchor],
  });
});

test.serial('the mounted opening page combines current Realm context and a disclosed discussion card', async () => {
  const createdBoard = await world.board();
  expect(createdBoard.response.status).toBe(201);
  const boardId = createdBoard.value.board.id as string;
  const createdThread = await world.checked('POST', '/v1/threads', {
    boardId,
    title: 'Opening page discussion',
    body: fromPlainText('A useful opening post.'),
    licence: 'MIT',
    subjectIds: [],
    visibility: 'published',
  });

  const result = await world.call('GET', `/v1/boards/${boardId}/page`);
  expect(result.response.status).toBe(200);
  expect(Object.keys(result.value).sort()).toEqual(
    [
      'board',
      'pinRevision',
      'pinnedThreads',
      'threads',
      'next',
      'rankRefreshedAt',
      'reactionsAsOf',
      'viewer',
      'actions',
    ].sort(),
  );
  expect(result.value.board).toMatchObject({
    id: boardId,
    realmId: world.realm.realmId,
    community: { realmId: world.realm.realmId, rules: { state: expect.any(String) } },
  });
  expect(result.value.pinnedThreads).toEqual([]);
  expect(result.value.pinRevision).toBe('0');
  expect(result.value.threads).toHaveLength(1);
  expect(result.value.threads[0]).toMatchObject({
    thread: {
      id: createdThread.thread.id,
      title: 'Opening page discussion',
      firstPost: { availability: 'available' },
    },
    target: { kind: 'thread', id: createdThread.thread.id, boardId },
    authors: {
      thread: { state: 'available', id: world.owner.accountId },
      openingPost: { state: 'available', id: world.owner.accountId },
    },
    interaction: {
      target: { kind: 'thread', id: createdThread.thread.id },
      counts: { state: 'unavailable' },
      viewer: { state: 'current', reaction: null },
    },
    comments: { state: 'unavailable' },
    actions: { share: 'available' },
  });
  expect(result.value.next).toBeNull();
  const invalid = await world.call('GET', `/v1/boards/${boardId}/page?sort=oldest`);
  expect(invalid.response.status).toBe(400);
  expect(invalid.value.code).toBe('invalid_request');
});

test.serial(
  'opening and continuation carry the observed generation and reject pin ABA during hydration',
  async () => {
    const conceptId = await world.subject('skos:Concept', world.schemeId);
    const created = await world.board(conceptId);
    expect(created.response.status).toBe(201);
    const boardId = created.value.board.id as string;
    const threads: string[] = [];
    for (let index = 0; index < 22; index++) {
      const createdThread = await world.checked('POST', '/v1/threads', {
        boardId,
        title: `Generation discussion ${index}`,
        body: fromPlainText('An observed opening.'),
        licence: 'MIT',
        subjectIds: [],
        visibility: 'published',
      });
      threads.push(createdThread.thread.id);
    }
    const pinPath = `/v1/boards/${boardId}/threads/${threads[0]}/pin`;
    await world.checked('POST', pinPath, { pinned: true }, 200);
    const path = `/v1/boards/${boardId}/page?sort=new`;
    const initial = await world.call('GET', path);
    expect(initial.response.status).toBe(200);
    expect(initial.value.pinRevision).toBe('1');
    expect(initial.value.pinnedThreads.map((card: any) => card.thread.id)).toEqual([threads[0]]);
    expect(initial.value.threads).toHaveLength(20);
    expect(initial.value.next).toBeString();
    const continued = await world.call('GET', `${path}&cursor=${encodeURIComponent(initial.value.next)}`);
    expect(continued.response.status).toBe(200);
    expect(continued.value.pinRevision).toBe(initial.value.pinRevision);
    expect(continued.value.pinnedThreads).toEqual([]);
    expect(continued.value.threads).toHaveLength(1);

    const access = world.kernel.testAccess;
    const deadline = Date.now() + 60_000;
    const actor = await access.authenticate(world.owner.bearer, { pool: world.db.pool, deadline });
    let changed = false;
    const read = createBoardPageReader({
      pool: world.db.pool,
      access,
      tokens: testTokens(),
      routeKey: world.routeKey,
      realmParticipation: createRealmParticipationCheck({ pool: world.db.pool, access }),
      async readConversationActivityBatch() {
        if (!changed) {
          changed = true;
          await world.checked('POST', pinPath, { pinned: false }, 200);
          await world.checked('POST', pinPath, { pinned: true }, 200);
        }
        return { items: [], anchors: [] };
      },
    });
    // The only pin returns to the same position, leaving the visible page identical.
    await expect(read(boardId, { actor, deadline }, { sort: 'new' })).rejects.toBeInstanceOf(BoardOpeningChangedError);
    const obsolete = await world.call('GET', `${path}&cursor=${encodeURIComponent(initial.value.next)}`);
    expect(obsolete.response.status).toBe(400);
    expect(obsolete.value.code).toBe('invalid_cursor');
    const restarted = await world.call('GET', path);
    expect(restarted.response.status).toBe(200);
    expect(restarted.value.pinRevision).toBe('3');
    changed = false;
    await expect(read(boardId, { actor, deadline }, { sort: 'new', cursor: restarted.value.next })).rejects.toThrow(
      'Invalid content cursor',
    );
  },
  120_000,
);
