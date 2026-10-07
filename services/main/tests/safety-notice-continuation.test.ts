import { expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import { SafetyNoticeContinuation } from '../src/modules/governance/notices-mail.ts';
import {
  NotificationProducer,
  NotificationProducerWorker,
  PRODUCER_COST,
} from '../src/modules/notification-producers/producer.ts';
import type { NotificationEvent } from '../src/modules/notification/store.ts';

const id = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const native = (last: number) => `https://rezics.com/id/${id(last)}`;
const decisionA = id(2);
const decisionB = id(3);
const chapterId = id(4);
const follower = id(9);
const work = native(6);
const author = native(5);

function harness(intake: (decisionId: string) => Promise<void>) {
  const safetyCursor = { epoch: '1', xid: '1', id: '1' };
  const accessCursor = { epoch: '2', xid: '1', id: '1' };
  const safetyWrites: unknown[][] = [];
  const notices: NotificationEvent[] = [];
  const order: string[] = [];
  let held = false;
  const safetyEvents = [
    { epoch: '1', xid: '1', id: '2', kind: 'moderation_outcome', event_id: decisionA },
    { epoch: '1', xid: '1', id: '3', kind: 'moderation_outcome', event_id: decisionB },
  ];
  const accessEvents = [
    { epoch: '2', xid: '1', id: '2', kind: 'chapter_published', event_id: chapterId },
  ];
  const query = async (sql: string, args?: unknown[]) => {
    if (sql.includes('notification_producer_event')) {
      expect(args?.[3]).toBe(PRODUCER_COST.accessEventsPerTick);
      const epoch = String(args?.[0]);
      const after = BigInt(String(args?.[2]));
      const source = epoch === '1' ? safetyEvents : epoch === '2' ? accessEvents : null;
      if (!source) throw new Error(`unexpected producer cursor epoch ${epoch}`);
      return { rows: source.filter((event) => BigInt(event.id) > after) };
    }
    if (sql.includes('recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('sequence_editorial_events')) return { rows: [] };
    if (sql.includes('chapter_notification_event'))
      return {
        rows: [
          {
            activity: native(7),
            work,
            author,
            content_revision: `urn:rezics:content:revision:${id(8)}`,
          },
        ],
      };
    if (sql.includes('FROM access.representation')) return { rows: [{ id: follower }] };
    if (sql.includes('EXCLUDED.epoch')) {
      safetyCursor.epoch = String(args?.[1]);
      safetyCursor.xid = String(args?.[2]);
      safetyCursor.id = String(args?.[3]);
      safetyWrites.push([...(args ?? [])]);
      return { rows: [] };
    }
    if (sql.includes('SET epoch = $2')) {
      accessCursor.epoch = String(args?.[1]);
      accessCursor.xid = String(args?.[2]);
      accessCursor.id = String(args?.[3]);
      return { rows: [] };
    }
    if (sql.includes('notification_producer_cursor') && sql.includes('SELECT')) {
      if (sql.includes('editorial-notification-v1')) return { rows: [] };
      if (args?.[0] === 'safety-correspondence-v1') return { rows: [{ ...safetyCursor }] };
      if (args?.[0] === 'notification-producer-v1') return { rows: [{ ...accessCursor }] };
    }
    if (
      sql === 'BEGIN' ||
      sql === 'COMMIT' ||
      sql === 'ROLLBACK' ||
      sql.startsWith('SET LOCAL') ||
      sql.includes('ON CONFLICT DO NOTHING')
    )
      return { rows: [] };
    throw new Error(`unexpected Access SQL: ${sql}`);
  };
  const access = {
    connect: async () => {
      if (held) throw new Error('Access connection leaked across safety intake');
      held = true;
      return {
        query,
        release: () => {
          held = false;
        },
      };
    },
    query,
  } as unknown as Pool;
  class Probe extends NotificationProducer {
    safetyResults: number[] = [];
    override async observeLag(): Promise<void> {}
    override async runRelationshipRecoveryOnce(): Promise<number> {
      return 0;
    }
    override async runSafetyCorrespondenceOnce(): Promise<number> {
      const count = await super.runSafetyCorrespondenceOnce();
      this.safetyResults.push(count);
      return count;
    }
    override async runRelayOnce(): Promise<number> {
      order.push('relay');
      return super.runRelayOnce();
    }
  }
  const producer = new Probe(
    access,
    null,
    { query: async () => ({ rows: [{ language_tag: 'en' }] }) } as unknown as Pool,
    { query: async () => { throw new Error('safety paging must not read the graph'); } },
    {
      enqueue: async (event: NotificationEvent) => {
        notices.push(event);
        order.push('follow');
        return [];
      },
    },
    null,
  );
  producer.setSafetyCorrespondence({
    enqueueDecision: async (decisionId) => {
      order.push(`safety:${decisionId}`);
      await intake(decisionId);
    },
  });
  return {
    producer,
    order,
    notices,
    safetyWrites,
    tick: async () => {
      const worker = new NotificationProducerWorker(producer);
      worker.start();
      await worker.stop();
    },
  };
}

test('a three-page safety notice keeps its event while a followed chapter is enqueued on the first tick', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  const pages = new Map<string, number>();
  const scene = harness(async (decisionId) => {
    const page = (pages.get(decisionId) ?? 0) + 1;
    pages.set(decisionId, page);
    if (decisionId === decisionA && page < 3) throw new SafetyNoticeContinuation();
    if (decisionId !== decisionA && decisionId !== decisionB)
      throw new Error(`unexpected decision ${decisionId}`);
  });
  try {
    await scene.tick();
    expect(scene.order).toEqual([`safety:${decisionA}`, 'follow', 'relay']);
    expect(scene.safetyWrites).toEqual([]);
    expect(scene.producer.safetyResults).toEqual([1]);
    expect(scene.notices).toMatchObject([
      {
        topic: 'followed-chapter',
        purpose: 'subscription',
        sourceEvent: `chapter:${chapterId}`,
        recipients: [],
        relationshipPlan: { targets: [work, author], except: [follower], languages: ['en'] },
        display: { kind: 'chapter', actorAgent: author, groupKey: work },
      },
    ]);

    await scene.tick();
    expect(scene.order).toEqual([`safety:${decisionA}`, 'follow', 'relay', `safety:${decisionA}`, 'relay']);
    expect(scene.safetyWrites).toEqual([]);
    expect(scene.producer.safetyResults).toEqual([1, 1]);
    expect(scene.notices).toHaveLength(1);

    await scene.tick();
    expect(scene.producer.safetyResults).toEqual([1, 1, 2]);
    expect(scene.safetyWrites).toEqual([
      ['safety-correspondence-v1', '1', '1', '2'],
      ['safety-correspondence-v1', '1', '1', '3'],
    ]);
    expect(scene.order.filter((step) => step.startsWith('safety:'))).toEqual([
      `safety:${decisionA}`,
      `safety:${decisionA}`,
      `safety:${decisionA}`,
      `safety:${decisionB}`,
    ]);
    expect(pages.get(decisionA)).toBe(3);
    expect(pages.get(decisionB)).toBe(1);
    expect(scene.notices).toHaveLength(1);
    expect(logged).not.toHaveBeenCalled();
    expect(scene.order.filter((step) => step === 'relay')).toHaveLength(3);
  } finally {
    logged.mockRestore();
  }
});

test('an intake failure still fails safety correspondence without stopping an ordinary notification', async () => {
  const scene = harness(async () => {
    throw new Error('intake lost');
  });
  await expect(scene.producer.runSafetyCorrespondenceOnce()).rejects.toThrow('intake lost');
  expect(scene.safetyWrites).toEqual([]);
  expect(scene.notices).toEqual([]);
  expect(scene.producer.safetyResults).toEqual([]);

  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await scene.tick();
    expect(scene.notices).toMatchObject([{ topic: 'followed-chapter', sourceEvent: `chapter:${chapterId}` }]);
    expect(scene.order).toContain('follow');
    expect(scene.order).toContain('relay');
    expect(scene.order.indexOf('follow')).toBeLessThan(scene.order.indexOf('relay'));
    expect(scene.safetyWrites).toEqual([]);
    expect(scene.producer.safetyResults).toEqual([]);
    expect(logged.mock.calls).toEqual([['Safety correspondence intake unavailable']]);
  } finally {
    logged.mockRestore();
  }
});
