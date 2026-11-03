import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { Pool } from 'pg';
import { startWorker } from '../../src/worker.ts';
import type { WorkModule } from '../../src/work/registry.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createBoard } from '../../src/content/board-create.ts';
import { createThread, revisePost, threadTarget } from '../../src/content/commands.ts';
import { createRealmParticipationCheck } from '../../src/community/participation.ts';
import { createRealmSubjectCensus } from '../../src/content/realm-subject-census.ts';
import {
  createRealmSubjectLifecycle,
  REALM_SUBJECT_LIFECYCLE_EFFECT,
} from '../../src/content/realm-subject-lifecycle.ts';
import { contentEffects } from '../../src/content/relays.ts';
import { runCommand, type CommandEvent } from '../../src/command/command.ts';
import { takedown } from '../../src/content/moderation.ts';
import { liftTakedown } from '../../src/content/lift-takedown.ts';
import { realmBoardWorld } from './realm-board-create-support.ts';

const workerTest = 'default Content delivery keeps the Realm population current across cuts and ancestor changes';

type OutboxRow = {
  partition_no: number;
  position: string;
  epoch: number;
  id: string;
  type: string;
  subject: string | null;
  data: Record<string, unknown>;
  recorded_at: Date;
};

test.serial(
  workerTest,
  async () => {
    if (process.env.REALM_SUBJECT_LIFECYCLE_CHILD !== '1') {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path, '--test-name-pattern', `^${workerTest}$`], {
        env: { ...process.env, REALM_SUBJECT_LIFECYCLE_CHILD: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, `${output}\n${errors}`).toBe(0);
      return;
    }

    const world = await realmBoardWorld();
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      const access = world.kernel.testAccess;
      const actor = await access.authenticate(world.owner.bearer, {
        pool: world.db.pool,
        deadline: Date.now() + 60_000,
      });
      const dependencies = {
        pool: world.db.pool,
        access,
        routeKey: world.routeKey,
        realmParticipation: createRealmParticipationCheck({ pool: world.db.pool, access }),
      };
      const request = (idempotencyKey = crypto.randomUUID()) => ({
        deadline: Date.now() + 60_000,
        idempotencyKey,
        requestId: crypto.randomUUID(),
      });
      const discussionBoard = await world.directBoard(world.conceptId);
      const reviewConcept = await world.subject('skos:Concept', world.schemeId);
      const reviewBoard = await createBoard(
        dependencies,
        actor,
        {
          realmId: world.realm.realmId,
          conceptId: reviewConcept,
          title: 'Lifecycle reviews',
          visibility: 'published',
          purpose: 'reviews',
        },
        request(),
      );
      const original = await world.subject('skos:Concept', world.schemeId);
      const replacement = await world.subject('skos:Concept', world.schemeId);
      const discussionKey = crypto.randomUUID();
      const discussionTarget = threadTarget(world.routeKey, world.owner.accountId, discussionKey);
      const reviewRoute = routeOf(world.owner.accountId)!;
      const discussion = (
        await createThread(
          dependencies,
          actor,
          {
            boardId: discussionBoard.value.boardId,
            kind: 'discussion',
            title: 'Lifecycle discussion',
            body: fromPlainText('Opening discussion.'),
            licence: 'MIT',
            visibility: 'published',
            subjectIds: [original],
          },
          request(discussionKey),
        )
      ).value;
      expect(discussion.threadId).toBe(discussionTarget.id);
      const review = (
        await createThread(
          dependencies,
          actor,
          {
            boardId: reviewBoard.value.boardId,
            kind: 'review',
            title: 'Lifecycle review',
            body: fromPlainText('Opening review.'),
            licence: 'MIT',
            visibility: 'published',
            subjectIds: [reviewConcept],
          },
          request(),
        )
      ).value;
      expect(routeOf(review.threadId)).toBe(reviewRoute);
      const census = createRealmSubjectCensus(world.db.pool);
      const cuts = await Promise.all(
        [...new Set([discussionTarget.route, reviewRoute])].map((route) => census.capture(route, Date.now() + 60_000)),
      );

      const revised = (
        await revisePost(
          dependencies,
          actor,
          {
            threadId: discussion.threadId,
            itemId: discussion.itemId,
            expectedRevisionId: discussion.revisionId,
            body: fromPlainText('Revised opening discussion.'),
            licence: 'MIT',
            subjectIds: [replacement],
          },
          request(),
        )
      ).value;
      const revisionEvent = await nativeEvent(world.db.admin, 'com.rezics.content.revision.created.v1', {
        threadId: discussion.threadId,
        itemId: discussion.itemId,
        revisionId: revised.revisionId,
      });
      const openingEvent = await nativeEvent(world.db.admin, 'com.rezics.content.thread.created.v1', {
        threadId: discussion.threadId,
        itemId: discussion.itemId,
      });

      const module: WorkModule = {
        name: 'realm_subject_lifecycle_fixture',
        register(context) {
          const effect = contentEffects(context.pool, context.client).find(
            (candidate) => candidate.name === REALM_SUBJECT_LIFECYCLE_EFFECT,
          );
          if (!effect) throw new Error('Content registration omitted the Realm Subject lifecycle effect');
          context.addEffects([effect]);
        },
      };
      worker = await startWorker({ databaseUrl: world.db.url, poolSize: 10, executorId: 'realm-subject-lifecycle' }, [
        module,
      ]);

      const discussionCandidate = () => candidate(world.db.admin, discussion.threadId, original);
      const replacementCandidate = () => candidate(world.db.admin, discussion.threadId, replacement);
      const reviewCandidate = () => candidate(world.db.admin, review.threadId, reviewConcept);
      const currentDiscussion = await until(async () => {
        const old = await discussionCandidate();
        const next = await replacementCandidate();
        return old?.active === false && old.revision_id === revised.revisionId && next?.active === true
          ? { old, next }
          : null;
      });
      expect(currentDiscussion.next.source_position).toBe(revisionEvent.position);
      expect((await until(reviewCandidate)).active).toBe(true);

      for (const cut of cuts) {
        for (let step = 0; step < 520; step++) {
          if ((await census.step(cut.route, Date.now() + 60_000)) === 'exhausted') break;
        }
        expect((await census.observe(cut.route, Date.now() + 60_000))?.exhausted).toBe(true);
      }
      expect(await replacementCandidate()).toMatchObject({ active: true, revision_id: revised.revisionId });

      const lifecycle = createRealmSubjectLifecycle({ pool: world.db.pool });
      await lifecycle.effect.run(toCloudEvent(openingEvent));
      await lifecycle.effect.run(toCloudEvent(revisionEvent));
      expect(await replacementCandidate()).toMatchObject({ active: true, revision_id: revised.revisionId });
      expect(await discussionCandidate()).toMatchObject({ active: false, revision_id: revised.revisionId });

      const restoreTargets: Array<{ kind: 'post' | 'thread'; id: string }> = [
        { kind: 'post' as const, id: discussion.itemId },
        { kind: 'thread' as const, id: discussion.threadId },
      ];
      const boardTarget = { kind: 'board' as const, id: discussionBoard.value.boardId };
      for (const target of [...restoreTargets, boardTarget]) {
        await world.checked('POST', '/v1/grants', {
          resource: { route: routeOf(target.id)!, id: target.id },
          subject: { kind: 'account', id: world.owner.accountId },
          actions: ['moderation:takedown'],
          valid: '(,)',
        });
      }
      for (const target of restoreTargets) {
        await takedown(dependencies, actor, { target, reason: 'Lifecycle verification' }, request());
        await until(async () => ((await replacementCandidate())?.active === false ? true : null));
        await runCommand(
          world.db.pool,
          {
            partition: partitionOf(routeOf(target.id)!),
            receipt: {
              actorAccountId: world.owner.accountId,
              kind: 'content.fixture.restore',
              key: crypto.randomUUID(),
              digest: new Uint8Array(32),
            },
          },
          async (client) => {
            const events: CommandEvent[] = [];
            const value = await liftTakedown(client, { target }, { events });
            if (!value) throw new Error('Expected native restoration to change the target');
            return { value, events };
          },
        );
        await until(async () => ((await replacementCandidate())?.active === true ? true : null));
      }

      const scope = lifecycle.scope;
      const beforeBoardChange = await scope.observe(world.realm.realmId, Date.now() + 60_000);
      if (!beforeBoardChange) throw new Error('Expected a current Realm ancestor observation');
      await takedown(
        dependencies,
        actor,
        { target: { kind: 'board', id: discussionBoard.value.boardId }, reason: 'Lifecycle board reduction' },
        request(),
      );
      await until(async () =>
        (await scope.current(world.realm.realmId, beforeBoardChange, Date.now() + 60_000)) === 'changed' ? true : null,
      );
      expect(await replacementCandidate()).toMatchObject({ active: true });
      expect(await reviewCandidate()).toMatchObject({ active: true });
    } finally {
      await worker?.stop();
      await world.close();
    }
  },
  180_000,
);

async function candidate(pool: Pool, thread: string, original: string) {
  const result = await pool.query<
    {
      active: boolean;
      revision_id: string;
      source_epoch: number;
      source_position: string;
    } & Record<string, unknown>
  >(
    `SELECT active,revision_id,source_epoch,source_position::text AS source_position
     FROM content.realm_subject_candidate WHERE thread_id=$1 AND original_id=$2 ORDER BY route,realm_id LIMIT 1`,
    [thread, original],
  );
  return result.rows[0];
}

async function nativeEvent(pool: Pool, type: string, data: Record<string, unknown>): Promise<OutboxRow> {
  const result = await pool.query(
    `SELECT partition_no,position::text AS position,epoch,id,type,subject,data,recorded_at
     FROM core.outbox WHERE type=$1 AND data @> $2::jsonb ORDER BY position DESC LIMIT 1`,
    [type, JSON.stringify(data)],
  );
  const row = result.rows[0] as OutboxRow | undefined;
  if (!row) throw new Error(`Missing native ${type} outbox event`);
  return row;
}

function toCloudEvent(row: OutboxRow): CloudEvent {
  return {
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type: row.type,
    ...(row.subject === null ? {} : { subject: row.subject }),
    time: new Date(row.recorded_at).toISOString(),
    datacontenttype: 'application/json',
    sequence: row.position.padStart(19, '0'),
    data: row.data,
  };
}

async function until<T>(read: () => Promise<T | null | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for native Realm Subject lifecycle progress');
}
