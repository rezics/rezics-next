import { createReviewLifecycleFixture } from './review-native-lifecycle-fixture.ts';
import { expect, test } from 'bun:test';
import { composeFeedViewerPersonalActions, feedViewerReferences } from '../../src/content/feed-viewer.ts';
import { FeedViewerPersonalActionsSchema } from '../../src/content/feed-viewer-schema.ts';
import { Value } from 'typebox/value';
import type { FeedItem } from '../../src/content/feed-contract.ts';
import type {
  ViewerPersonalActionsReader,
  ViewerPersonalActionsPage,
} from '../../src/library/viewer-personal-actions.ts';
import { routeOf } from '../../src/route/route.ts';

const work = (id: string, rowKey: string): FeedItem => ({
  id: rowKey,
  source: 'discovery',
  occurredAt: null,
  key: { owner: 'semantic', kind: 'schema:Book', route: routeOf(id)!, id },
  destination: { kind: 'subject', id, title: null },
  summary: { id, type: 'schema:Book', types: ['schema:Book'], label: null, creativeWork: true, cover: null },
});

test('Home keeps native private states, duplicate occurrence keys and independent delayed page cohorts', async () => {
  const { readViewerPersonalActionsPage } = await import('../../src/library/viewer-personal-actions.ts');
  const { STANDARD_QUESTION_ID } = await import('../../src/rating/votes.ts');
  const f = await createReviewLifecycleFixture();
  try {
    const actor = f.system.actors.author.actor;
    const first = work(f.subjectId, 'first');
    const second = work(f.subjectId, 'second');
    const calls: string[][] = [];
    const release: Array<() => void> = [];
    const reader: ViewerPersonalActionsReader = async (_actor, rows, questionId) => {
      expect(questionId).toBe(STANDARD_QUESTION_ID);
      calls.push(rows.map((row) => row.rowKey));
      await new Promise<void>((resolve) => {
        release.push(resolve);
      });
      return {
        state: 'current',
        question: null,
        rows: rows.map((row, index) => ({
          rowKey: row.rowKey,
          subjectId: row.subjectId,
          entry: index === 0 ? { state: 'absent' } : { state: 'unavailable', reason: 'scope' },
          vote:
            index === 0
              ? { state: 'present', questionId, questionRevision: 1, units: 0, revision: 1 }
              : { state: 'absent', questionId, questionRevision: 1 },
          actions: { state: 'current', allowed: [] },
        })),
      };
    };
    const deps = {
      pool: f.system.database.pool,
      routeKey: f.system.routeKey,
      access: f.system.access,
      viewerPersonalActions: reader,
    };
    // Start each cohort after the previous one has reached its own helper. No shared result.
    const start = async (admitted: readonly FeedItem[]) => {
      let reached!: () => void;
      const ready = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const result = composeFeedViewerPersonalActions(
        {
          ...deps,
          viewerPersonalActions: async (...args) => {
            const result = reader(...args);
            reached();
            return result;
          },
        },
        actor,
        [first, second],
        Date.now() + 120_000,
        [],
        async () => admitted,
      );
      await ready;
      return { result };
    };
    const one = await start([first, second]);
    const two = await start([]); // Helper completes after this page's source withdrawal.
    const three = await start([work(f.subjectId, 'replacement')]);
    release[2]!();
    release[0]!();
    release[1]!();
    const pages = await Promise.all([one.result, two.result, three.result]);
    expect(calls).toEqual([
      ['first', 'second'],
      ['first', 'second'],
      ['first', 'second'],
    ]);
    expect(pages.map((page) => (page.state === 'current' ? page.rows.length : -1))).toEqual([2, 0, 0]);
    expect(pages[0]).toMatchObject({
      rows: [
        {
          rowKey: 'first',
          entry: { state: 'absent' },
          vote: { state: 'present', units: 0 },
          actions: { state: 'current', allowed: [] },
        },
        { rowKey: 'second', entry: { state: 'unavailable' }, vote: { state: 'absent' } },
      ],
    });
    for (const page of pages) expect(Value.Check(FeedViewerPersonalActionsSchema, page)).toBe(true);
    const native = await composeFeedViewerPersonalActions(
      {
        ...deps,
        viewerPersonalActions: (...args) =>
          readViewerPersonalActionsPage(
            {
              pool: deps.pool,
              viewerActionRuntime: () => {
                throw new Error('mounted authority absent');
              },
            },
            ...args,
          ),
      },
      actor,
      [first],
      Date.now() + 120_000,
      [],
      async () => [first],
    );
    expect(native).toEqual({ state: 'unavailable', reason: 'currentness', retryable: true });
    expect(Value.Check(FeedViewerPersonalActionsSchema, native)).toBe(true);
    const refused: ViewerPersonalActionsPage = { state: 'unavailable', reason: 'response_limit', retryable: false };
    expect(
      await composeFeedViewerPersonalActions(
        { ...deps, viewerPersonalActions: async () => refused },
        actor,
        [first],
        Date.now() + 120_000,
        [],
        async () => [first],
      ),
    ).toEqual(refused);
    for (const width of [1, 4, 16]) {
      const occurrences = Array.from({ length: width }, (_, index) => work(f.subjectId, `growth-${index}`));
      let raw = 0;
      await composeFeedViewerPersonalActions(
        {
          ...deps,
          viewerPersonalActions: async (_actor, rows) => {
            raw = rows.length;
            return refused;
          },
        },
        actor,
        occurrences,
        Date.now() + 120_000,
        [],
        async () => occurrences,
      );
      expect(raw).toBe(width);
    }
    const nativeDeps = {
      pool: deps.pool,
      viewerActionRuntime: () => {
        throw new Error('missing runtime');
      },
    };
    const input = { rowKey: 'raw', subjectId: f.subjectId, resourceType: 'schema:Book' };
    await expect(
      readViewerPersonalActionsPage(
        nativeDeps,
        actor,
        Array(101).fill(input),
        STANDARD_QUESTION_ID,
        Date.now() + 120_000,
      ),
    ).rejects.toThrow('at most 100 rows');
    await expect(
      readViewerPersonalActionsPage(
        nativeDeps,
        actor,
        [{ ...input, rowKey: '界'.repeat(6000) }],
        STANDARD_QUESTION_ID,
        Date.now() + 120_000,
      ),
    ).rejects.toThrow('16384 encoded bytes');
    expect(first).not.toHaveProperty('viewerPersonalActions');
  } finally {
    await f.close();
  }
}, 180_000);

test('generic Subjects, replies and Collections never imply work identity', () => {
  const id = '00000000-0000-7000-8000-000000000002';
  const subject = work(id, 'generic');
  if ('creativeWork' in subject.summary) subject.summary.creativeWork = false;
  const collection: FeedItem = {
    id: 'collection',
    source: 'following',
    occurredAt: null,
    key: { owner: 'library', kind: 'collection', route: 0, id },
    summary: {
      id,
      title: 'Shelf',
      description: null,
      curator: { state: 'unavailable', reason: 'native_projection' },
      presentationKind: null,
      presentationKindSource: 'empty',
      cover: null,
      coverSource: 'none',
    },
    destination: { kind: 'collection', id, title: 'Shelf' },
  };
  const reply: FeedItem = {
    id: 'reply',
    source: 'following',
    occurredAt: null,
    key: { owner: 'content', kind: 'post', route: 0, id },
    summary: {
      id,
      threadId: id,
      createdAt: '2026-11-01',
      title: null,
      reviewContext: {
        target: { state: 'available', subject: { id, kind: 'schema:Book', label: null } },
        citation: { state: 'absent' },
      },
    },
    destination: { kind: 'post', id, title: null, threadId: id, postId: id },
  };
  expect(feedViewerReferences([subject, collection, reply])).toEqual([]);
});
