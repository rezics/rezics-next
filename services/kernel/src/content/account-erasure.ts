import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { acknowledgeErasure, readErasureStatus, resolveRetention } from './access-port.ts';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import type { Effect, NativeEffect } from '../events/effects.ts';
import { enqueueWorkIntent } from '../work/client.ts';
import type { CloudEvent } from '../events/log.ts';
import { closeErasureFence } from './erasure-fence.ts';
import { eraseAccountAuthoredPage, type AuthoredErasureCursor } from './account-erasure-authored.ts';
import {
  eraseAccountUploadsPage,
  type UploadErasureCursor,
  eraseAccountUploadItem,
} from './account-erasure-uploads.ts';
import { eraseAccountReactionsPage, type ReactionErasureCursor } from './account-erasure-reactions.ts';
import { eraseAccountModerationPage, purgeAccountStatementsPage } from './account-erasure-moderation.ts';
import type { MediaStorage } from './media-storage.ts';
import { eraseFeedInboxPage } from './feed-activity.ts';
import { deadlineFor } from '../request/deadline.ts';
import { eraseAccountNoticesPage, type NoticeErasureCursor } from './notices.ts';
import { eraseBoardSlowModeAccountPage } from './board-slow.ts';
import { markAccountErasureFound } from './account-erasure-progress.ts';
import {
  advanceKnowledgeAccountErasure,
  isKnowledgeAccountErasureCursor,
} from './knowledge-account-erasure.ts';

const workflow = 'content.account-erasure.step';
const retentionWorkflow = 'content.account-erasure.retention';
type Phase =
  | 'close'
  | 'slow-mode'
  | 'authored'
  | 'knowledge'
  | 'uploads'
  | 'reactions'
  | 'moderation'
  | 'notices'
  | 'proof'
  | 'complete';
type Progress = {
  step: string;
  phase: Exclude<Phase, 'close'>;
  cursor: unknown;
  erased_at: Date;
  content_found: boolean;
  delivery_found: boolean;
  phase_pending: boolean;
  statements_kept_until: Date | null;
};
type Continuation = { phase: Phase; step: number; delayMs?: number; retentionAt?: string | null } | null;

function route(accountId: string): number {
  const value = routeOf(accountId);
  if (value === null) throw new TypeError('Invalid content account-erasure identity');
  return value;
}

function workflowId(accountId: string, phase: Phase, step: number): string {
  return `content-account-erasure:${accountId}:${phase}:${step}`;
}

async function readProgress(pool: Pool, accountId: string): Promise<Progress | null> {
  const home = route(accountId);
  return withConnection(pool, async (client) => {
    const { rows } = await client.query<Progress>(
      `SELECT step::text,phase,cursor,erased_at,content_found,delivery_found,phase_pending,statements_kept_until
       FROM content.account_erasure_progress WHERE route=$1 AND account_id=$2`,
      [home, accountId],
    );
    return rows[0] ?? null;
  });
}

async function start(pool: Pool, accountId: string): Promise<Continuation> {
  const home = route(accountId);
  const status = await readErasureStatus(pool, accountId);
  if (!status || status.participants.content?.outcome !== 'pending')
    throw new Error('Content participant requires the committed account-erasure obligation');
  await runCommand(
    pool,
    {
      partition: partitionOf(home),
      receipt: {
        actorAccountId: accountId,
        kind: 'content.account-erasure.start',
        key: accountId,
        digest: createHash('sha256').update(status.at).digest(),
      },
    },
    async (tx) => {
      await closeErasureFence(tx, accountId);
      await tx.query(
        `INSERT INTO content.account_erasure_progress(route,account_id,step,phase,cursor,erased_at)
         VALUES ($1,$2,1,'slow-mode',NULL,$3::timestamptz) ON CONFLICT (route,account_id) DO NOTHING`,
        [home, accountId, status.at],
      );
      return noEffect(null);
    },
  );
  const progress = await readProgress(pool, accountId);
  if (!progress) throw new Error('Content account-erasure progress was not created');
  return { phase: progress.phase, step: Number(progress.step) };
}

async function assertContentErasureProofReady(pool: Pool, accountId: string, erasedAt: Date): Promise<void> {
  const home = route(accountId);
  const ready = await withConnection(pool, async (client) => {
    const { rows } = await client.query<{ ready: boolean }>(
      `SELECT NOT EXISTS (
         SELECT 1 FROM access.erasure_late_item
         WHERE route=$1 AND account_id=$2 AND participant='content' AND resolved_at IS NULL
       ) AS ready
       FROM access.erasure
       WHERE route=$1 AND account_id=$2 AND date_trunc('milliseconds',at)=$3::timestamptz`,
      [home, accountId, erasedAt],
    );
    return rows[0]?.ready === true;
  });
  if (!ready) throw new Error('Content erasure proof requires its committed obligation and no open Content late item');
}

async function assertFinalProof(pool: Pool, storage: MediaStorage, accountId: string, cursor: unknown) {
  const home = route(accountId);
  const state = (cursor ?? { phase: 'media', after: null }) as { phase: 'media' | 'fields'; after: string | null };
  if (!['media', 'fields'].includes(state.phase) || (state.after !== null && routeOf(state.after) === null))
    throw new TypeError('Invalid content account-erasure proof cursor');
  if (state.phase === 'media' && state.after === null) {
    const residual = await withConnection(pool, async (client) => {
      const { rows } = await client.query<{ found: boolean }>(
        `SELECT
          EXISTS(SELECT 1 FROM content.author_item WHERE route=$1 AND author_account_id=$2) OR
          EXISTS(SELECT 1 FROM content.reaction WHERE route=$1 AND actor_account_id=$2 LIMIT 1) OR
          EXISTS(SELECT 1 FROM content.reaction_liked_version WHERE route=$1 AND actor_account_id=$2) OR
          EXISTS(SELECT 1 FROM content.report_reporter WHERE route=$1 AND reporter_account_id=$2) OR
          EXISTS(SELECT 1 FROM content.feed_inbox WHERE route=$1 AND account_id=$2) OR
          EXISTS(SELECT 1 FROM content.party_locator WHERE route=$1 AND account_id=$2 AND kind <> 'decision')
          AS found`,
        [home, accountId],
      );
      return rows[0]?.found ?? false;
    });
    if (residual) throw new Error('Content account-erasure locator proof found unhandled data');
  }
  const ids = await withConnection(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id::text FROM content.account_upload
       WHERE route=$1 AND account_id=$2 AND phase=$3 AND id > COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
       ORDER BY id LIMIT 50`,
      [home, accountId, state.phase, state.after],
    );
    return rows.map((row) => row.id);
  });
  for (const id of ids) {
    const result = await eraseAccountUploadItem({ pool, storage }, accountId, state.phase, id);
    if (result !== 'retained') throw new Error('Content account-erasure upload proof found an unhandled item');
  }
  if (ids.length === 50) return { next: { phase: state.phase, after: ids.at(-1)! }, done: false } as const;
  if (state.phase === 'media') return { next: { phase: 'fields', after: null }, done: false } as const;
  return { next: null, done: true } as const;
}

async function hasOpenLateMedia(pool: Pool, accountId: string): Promise<boolean> {
  const home = route(accountId);
  return withConnection(pool, async (client) => {
    const { rows } = await client.query<{ open: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM access.erasure_late_item
         WHERE route=$1 AND account_id=$2 AND participant='content'
           AND locator LIKE 'media:%' AND resolved_at IS NULL
       ) AS open`,
      [home, accountId],
    );
    return rows[0]?.open ?? false;
  });
}

async function persist(
  pool: Pool,
  accountId: string,
  progress: Progress,
  next: {
    phase: Exclude<Phase, 'close'>;
    cursor: unknown;
    contentFound: boolean;
    deliveryFound: boolean;
    pending: boolean;
    statementsKeptUntil: Date | null;
  },
): Promise<void> {
  const home = route(accountId);
  const expectedStep = Number(progress.step);
  const key = `${accountId}:${expectedStep}`;
  await runCommand(
    pool,
    {
      partition: partitionOf(home),
      receipt: {
        actorAccountId: accountId,
        kind: 'content.account-erasure.progress',
        key,
        digest: createHash('sha256').update(JSON.stringify(next)).digest(),
      },
    },
    async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE content.account_erasure_progress SET step=step+1,phase=$3,cursor=$4::jsonb,
          content_found=content_found OR $5,delivery_found=delivery_found OR $6,
          phase_pending=$7,statements_kept_until=CASE WHEN $8::timestamptz IS NULL THEN statements_kept_until
            ELSE GREATEST(COALESCE(statements_kept_until,$8::timestamptz),$8::timestamptz) END
         WHERE route=$1 AND account_id=$2 AND step=$9`,
        [
          home,
          accountId,
          next.phase,
          next.cursor === null ? null : JSON.stringify(next.cursor),
          next.contentFound,
          next.deliveryFound,
          next.pending,
          next.statementsKeptUntil?.toISOString() ?? null,
          expectedStep,
        ],
      );
      if (!rowCount) throw new Error('Content account-erasure progress step changed unexpectedly');
      return noEffect(null);
    },
  );
}

async function step(
  pool: Pool,
  storage: MediaStorage,
  routeKey: Uint8Array,
  accountId: string,
  expectedStep: number,
): Promise<Continuation> {
  const home = route(accountId);
  const progress = await readProgress(pool, accountId);
  if (!progress) return start(pool, accountId);
  if (Number(progress.step) !== expectedStep) return { phase: progress.phase, step: Number(progress.step) };
  const currentPhase = progress.phase as Phase;
  let nextPhase: Exclude<Phase, 'close'> = progress.phase;
  let nextCursor: unknown = progress.cursor;
  let found = 0;
  let pendingNow = false;
  let statementsKeptUntil: Date | null = progress.statements_kept_until;
  let delayMs: number | undefined;
  let deliveryAcknowledgement: 'none' | 'erased' | null = null;
  let retentionAt: string | null = null;
  let finished = false;

  if (currentPhase === 'slow-mode') {
    const readyAt = progress.erased_at.getTime() + 30_000;
    if (Date.now() < readyAt) {
      delayMs = readyAt - Date.now();
    } else {
      const page = await eraseBoardSlowModeAccountPage(pool, routeKey, accountId, undefined, deadlineFor(120_000));
      if (page.pending) {
        pendingNow = true;
        delayMs = 60_000;
      } else if (page.more) {
        nextCursor = null;
      } else {
        nextPhase = 'authored';
        nextCursor = null;
      }
    }
  } else if (currentPhase === 'authored') {
    const feedRows = await eraseFeedInboxPage(pool, accountId, deadlineFor(5000));
    if (feedRows > 0) {
      await persist(pool, accountId, progress, {
        phase: 'authored',
        cursor: progress.cursor,
        contentFound: true,
        deliveryFound: false,
        pending: false,
        statementsKeptUntil,
      });
      return { phase: 'authored', step: expectedStep + 1 };
    }
    const page = await eraseAccountAuthoredPage({ pool }, accountId, progress.cursor as AuthoredErasureCursor | null);
    found = page.found;
    if (page.next) nextCursor = page.next;
    else {
      nextPhase = 'knowledge';
      nextCursor = null;
    }
  } else if (currentPhase === 'knowledge') {
    if (progress.cursor !== null && !isKnowledgeAccountErasureCursor(progress.cursor))
      throw new TypeError('Invalid Knowledge account-erasure cursor');
    const page = await runCommand(
      pool,
      {
        partition: partitionOf(home),
        deadline: deadlineFor(120_000),
        receipt: {
          actorAccountId: accountId,
          kind: 'content.account-erasure.knowledge',
          key: `${accountId}:${expectedStep}`,
          digest: createHash('sha256')
            .update(JSON.stringify([progress.erased_at.toISOString(), progress.cursor]))
            .digest(),
        },
      },
      async (tx) => {
        // Progress stores the status API's millisecond timestamp; Access keeps its native precision.
        const proof = await tx.query(
          `SELECT 1 FROM content.account_erasure_progress p
           JOIN access.erasure e ON e.route=p.route AND e.account_id=p.account_id
             AND date_trunc('milliseconds',e.at)=p.erased_at
           WHERE p.route=$1 AND p.account_id=$2 AND p.step=$3 AND p.phase='knowledge'
             AND p.cursor IS NOT DISTINCT FROM $4::jsonb
             AND NOT EXISTS (SELECT 1 FROM access.erasure_acknowledgement a
               WHERE a.route=p.route AND a.account_id=p.account_id AND a.participant='content')
           FOR SHARE OF e FOR UPDATE OF p`,
          [
            home,
            accountId,
            expectedStep,
            progress.cursor === null ? null : JSON.stringify(progress.cursor),
          ],
        );
        if (!proof.rowCount) throw new Error('Knowledge account erasure requires its current committed participant step');
        const result = await advanceKnowledgeAccountErasure(tx, accountId, progress.cursor, 100);
        if (result.found > 0) await markAccountErasureFound(tx, accountId, 'content');
        return noEffect(result);
      },
    ).then((result) => result.value);
    found = page.found;
    nextCursor = page.next;
    pendingNow = page.pending === true;
    if (pendingNow) delayMs = 60_000;
    else if (page.next === null) nextPhase = 'uploads';
  } else if (currentPhase === 'uploads') {
    const page = await eraseAccountUploadsPage(
      { pool, storage },
      accountId,
      progress.cursor as UploadErasureCursor | null,
    );
    found = page.found;
    pendingNow = page.pending > 0;
    const seenPending = progress.phase_pending || pendingNow;
    if (page.next) {
      nextCursor = page.next;
      pendingNow = seenPending;
    } else if (seenPending) {
      nextCursor = null;
      pendingNow = false;
      delayMs = 600_000;
    } else {
      if (await hasOpenLateMedia(pool, accountId)) {
        nextCursor = null;
        pendingNow = false;
        delayMs = 600_000;
      } else {
        nextPhase = 'reactions';
        nextCursor = null;
        deliveryAcknowledgement = progress.delivery_found ? 'erased' : 'none';
      }
    }
  } else if (currentPhase === 'reactions') {
    const page = await eraseAccountReactionsPage({ pool }, accountId, progress.cursor as ReactionErasureCursor | null);
    found = page.found;
    if (page.next) nextCursor = page.next;
    else {
      nextPhase = 'moderation';
      nextCursor = null;
    }
  } else if (currentPhase === 'moderation') {
    const page = await eraseAccountModerationPage({ pool }, accountId, {
      erasedAt: progress.erased_at,
      after: typeof progress.cursor === 'string' ? progress.cursor : null,
    });
    found = page.found;
    pendingNow = page.pending > 0;
    if (page.statementsKeptUntil) statementsKeptUntil = page.statementsKeptUntil;
    const seenPending = progress.phase_pending || pendingNow;
    if (page.next) {
      nextCursor = page.next;
      pendingNow = seenPending;
    } else if (seenPending) {
      nextCursor = null;
      pendingNow = false;
      delayMs = 600_000;
    } else {
      nextPhase = 'notices';
      nextCursor = null;
    }
  } else if (currentPhase === 'notices') {
    const page = await eraseAccountNoticesPage(
      { pool },
      accountId,
      typeof progress.cursor === 'string' ? (progress.cursor as NoticeErasureCursor) : null,
    );
    found = page.found;
    if (page.next) nextCursor = page.next;
    else {
      nextPhase = 'proof';
      nextCursor = null;
    }
  } else if (currentPhase === 'proof') {
    await assertContentErasureProofReady(pool, accountId, progress.erased_at);
    const proof = await assertFinalProof(pool, storage, accountId, progress.cursor);
    if (proof.done) {
      await assertContentErasureProofReady(pool, accountId, progress.erased_at);
      const latest = await readProgress(pool, accountId);
      statementsKeptUntil = latest?.statements_kept_until ?? statementsKeptUntil;
      if (statementsKeptUntil) {
        retentionAt = await withConnection(pool, async (client) => {
          const { rows } = await client.query<{ due_at: Date }>(
            `SELECT due_at FROM content.account_erasure_statement
             WHERE route=$1 AND account_id=$2
             ORDER BY due_at,decision_id LIMIT 1`,
            [home, accountId],
          );
          return rows[0]?.due_at.toISOString() ?? null;
        });
      }
      const retained = statementsKeptUntil
        ? [
            {
              store: 'content.moderation_decision',
              fields: ['statement'],
              purpose:
                'Statements of reasons kept for complaints by the affected person, open six months after each decision',
              expiresAt: statementsKeptUntil,
            },
          ]
        : [];
      const outcome = (latest?.content_found ?? progress.content_found) ? 'erased' : 'none';
      await acknowledgeErasure({ pool }, { accountId, participant: 'content', outcome, retained });
      nextPhase = 'complete';
      nextCursor = null;
      finished = true;
    } else {
      nextCursor = proof.next;
    }
  } else {
    return null;
  }

  if (deliveryAcknowledgement) {
    const latest = await readProgress(pool, accountId);
    await acknowledgeErasure(
      { pool },
      {
        accountId,
        participant: 'delivery',
        outcome: latest?.delivery_found ? 'erased' : deliveryAcknowledgement,
      },
    );
  }
  await persist(pool, accountId, progress, {
    phase: nextPhase,
    cursor: nextCursor,
    contentFound: found > 0,
    deliveryFound:
      found > 0 &&
      currentPhase === 'uploads' &&
      ((progress.cursor as UploadErasureCursor | null)?.phase ?? 'media') === 'media',
    pending: pendingNow,
    statementsKeptUntil,
  });
  if (finished)
    return {
      phase: 'complete',
      step: expectedStep + 1,
      retentionAt,
    };
  return { phase: nextPhase, step: expectedStep + 1, ...(delayMs ? { delayMs } : {}) };
}

async function enqueue(context: Pick<WorkContext, 'client'>, accountId: string, next: Exclude<Continuation, null>) {
  await context.client.enqueue(
    {
      workflowName: workflow,
      queueName: 'governance',
      workflowID: workflowId(accountId, next.phase, next.step),
      workflowIDReusePolicy: 'return-existing',
    },
    accountId,
    next.step,
  );
}

function accountFromTombstone(event: CloudEvent): string {
  const accountId = (event.data as { accountId?: unknown }).accountId;
  if (typeof accountId !== 'string' || routeOf(accountId) === null)
    throw new TypeError('Invalid content account-erasure tombstone event');
  return accountId;
}

/** Transfer the tombstone to its stable governance workflow in the relay admission transaction. */
export function createAccountErasureEffect(context: Pick<WorkContext, 'client'>): NativeEffect & Pick<Effect, 'run'> {
  return {
    name: 'content_account_erasure',
    types: ['com.rezics.access.account-tombstoned.v1'],
    delivery: 'native',
    async admit(tx, event) {
      const accountId = accountFromTombstone(event);
      await enqueueWorkIntent(context.client, tx, {
        queue: 'governance',
        workflowName: workflow,
        workflowId: workflowId(accountId, 'close', 0),
        input: { accounts: [accountId] },
        arguments: [accountId, 0],
      });
    },
    async run(event) {
      await enqueue(context, accountFromTombstone(event), { phase: 'close', step: 0 });
    },
  };
}

/** Registers the content participant and its expiry purge as durable platform work. */
export function registerAccountErasureWork(context: WorkContext, storage: MediaStorage, routeKey: Uint8Array): void {
  const run = DBOS.registerStep(
    async (accountId: string, expectedStep: number) => step(context.pool, storage, routeKey, accountId, expectedStep),
    { name: 'content.account-erasure.run', retriesAllowed: true, maxAttempts: 10, intervalSeconds: 1 },
  );
  DBOS.registerWorkflow(
    async (accountId: string, expectedStep: number) => {
      const next = await run(accountId, expectedStep);
      if (!next) return;
      if (next.phase === 'complete') {
        if (next.retentionAt)
          await context.client.enqueue(
            {
              workflowName: retentionWorkflow,
              queueName: 'governance',
              workflowID: `content-account-erasure:${accountId}:retention:${next.retentionAt}`,
              workflowIDReusePolicy: 'return-existing',
            },
            accountId,
            next.retentionAt,
          );
        return;
      }
      if (next.delayMs) await DBOS.sleep(next.delayMs);
      await enqueue(context, accountId, next);
    },
    { name: workflow },
  );
  const purge = DBOS.registerStep(
    async (accountId: string, asOf: string, after: string | null) =>
      purgeAccountStatementsPage({ pool: context.pool }, accountId, { asOf: new Date(asOf), after }),
    { name: 'content.account-erasure.retention-page', retriesAllowed: true, maxAttempts: 10, intervalSeconds: 1 },
  );
  DBOS.registerWorkflow(
    async (accountId: string, dueAt: string) => {
      for (;;) {
        const waitMs = Date.parse(dueAt) - context.clock().getTime();
        if (waitMs > 0) await DBOS.sleep(waitMs);
        let after: string | null = null;
        let nextDueAt: Date | null = null;
        do {
          const page = await purge(accountId, context.clock().toISOString(), after);
          after = page.next;
          nextDueAt = page.nextDueAt;
        } while (after !== null);
        if (nextDueAt && nextDueAt.getTime() > context.clock().getTime()) {
          await context.client.enqueue(
            {
              workflowName: retentionWorkflow,
              queueName: 'governance',
              workflowID: `content-account-erasure:${accountId}:retention:${nextDueAt.toISOString()}`,
              workflowIDReusePolicy: 'return-existing',
            },
            accountId,
            nextDueAt.toISOString(),
          );
          return;
        }
        if (!nextDueAt) {
          await resolveRetention(
            { pool: context.pool },
            {
              accountId,
              participant: 'content',
              store: 'content.moderation_decision',
            },
          );
          return;
        }
      }
    },
    { name: retentionWorkflow },
  );
  if (!context.addNativeEffects) throw new Error('Content account erasure requires native effects admission');
  context.addNativeEffects([createAccountErasureEffect(context)]);
}
