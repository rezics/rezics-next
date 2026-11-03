import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import {
  acknowledgeErasure,
  readErasureStatus,
  resolveRetention,
  type ErasureOutcome,
  type RetentionException,
} from '../access/erasure.ts';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { CloudEvent } from '../events/log.ts';
import type { Effect } from '../events/effects.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMUNITY_PLATFORM_BASIS } from './party-locator.ts';
import { closeErasureFence } from './erasure-fence.ts';
import { eraseAccountMembershipsPage, type MembershipErasureCursor } from './account-erasure-memberships.ts';
import { eraseAccountRevisionsPage } from './account-erasure-revisions.ts';
import {
  eraseAccountCommunityRecordsPage,
  purgeAccountBanReasonsPage,
  type CommunityRecordsCursor,
} from './account-erasure-records.ts';
import { eraseAccountNoticesPage, type NoticeErasureCursor } from '../content/notices.ts';
import { readRatingErasureDone } from '../rating/erasure-status.ts';
import nextDue from './account-erasure-records-next-due.sql';

const workflow = 'community.account-erasure.step';
const retentionWorkflow = 'community.account-erasure.retention';
const RETENTION_PURPOSE = 'Ban reasons kept for complaints by the banned person, open six months after each ban';
const RECHECK_DELAY_MS = 600_000;

type Phase = 'close' | 'memberships' | 'revisions' | 'records' | 'notices' | 'rating' | 'proof' | 'complete';
type Cursor = MembershipErasureCursor | NoticeErasureCursor | CommunityRecordsCursor | string | null;
type Progress = {
  step: string;
  phase: Phase;
  cursor: Cursor;
  erased_at: Date;
  community_found: boolean;
  phase_pending: boolean;
  reasons_kept_until: Date | null;
  rating_had_votes: boolean;
};
type ProgressRow = Omit<Progress, 'phase' | 'cursor'> & { phase: string; cursor: unknown };
type LocatorProof = {
  fence_open: boolean;
  member_locator: boolean;
  revision_locator: boolean;
  unexpected_party_locator: boolean;
  notice: boolean;
  notice_seen: boolean;
  late_item: boolean;
};
type Continuation = { phase: Phase; step: number; delayMs?: number; retentionAt?: string | null } | null;
type Page = { next: Cursor; found: number; pending: number; reasonsKeptUntil?: string | null };

function homeRoute(accountId: string): number {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid community account-erasure identity');
  return route;
}

function workflowId(accountId: string, phase: Phase, step: number): string {
  return `community-account-erasure:${accountId}:${phase}:${step}`;
}

const phases: readonly string[] = [
  'close',
  'memberships',
  'revisions',
  'records',
  'notices',
  'rating',
  'proof',
  'complete',
];
const recordKinds: readonly string[] = ['ban_actor', 'ban_target', 'membership_operation', 'verdict'];

function isRecordKind(value: string): value is CommunityRecordsCursor['kind'] {
  return recordKinds.includes(value);
}

function isRecordsCursor(value: unknown): value is CommunityRecordsCursor {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    isRecordKind(value.kind) &&
    'dueAt' in value &&
    typeof value.dueAt === 'string' &&
    'ownerRoute' in value &&
    typeof value.ownerRoute === 'number' &&
    'ownerId' in value &&
    typeof value.ownerId === 'string' &&
    'key' in value &&
    typeof value.key === 'string'
  );
}

function pageCursor(value: unknown, label: string): Cursor {
  if (value === null || typeof value === 'string' || isRecordsCursor(value)) return value;
  throw new TypeError(`Invalid ${label} erasure cursor`);
}

function recordsCursor(value: Cursor): CommunityRecordsCursor | null {
  if (value === null) return null;
  if (!isRecordsCursor(value)) throw new TypeError('Invalid community records erasure cursor in progress');
  return value;
}

function stringCursor(value: Cursor, label: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new TypeError(`Invalid ${label} erasure cursor in progress`);
}

function later(left: Date | null, right: string | null): Date | null {
  if (right === null) return left;
  const value = new Date(right);
  if (!Number.isFinite(value.getTime())) throw new TypeError('Invalid community ban-reason expiry');
  return left === null || value.getTime() > left.getTime() ? value : left;
}

async function readProgress(pool: Pool, accountId: string): Promise<Progress | null> {
  const route = homeRoute(accountId);
  return withConnection(pool, async (client) => {
    const result = await client.query<ProgressRow>(
      `SELECT step::text,phase,cursor,erased_at,community_found,phase_pending,
              reasons_kept_until,rating_had_votes
       FROM community.account_erasure_progress WHERE route=$1 AND account_id=$2`,
      [route, accountId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!phases.includes(row.phase)) throw new TypeError('Invalid community account-erasure progress phase');
    return { ...row, phase: row.phase as Phase, cursor: pageCursor(row.cursor, row.phase) };
  });
}

async function start(pool: Pool, accountId: string): Promise<Continuation> {
  const route = homeRoute(accountId);
  const status = await readErasureStatus(pool, accountId);
  if (!status || status.participants.community?.outcome !== 'pending')
    throw new Error('Community participant requires the committed account-erasure obligation');

  await runCommand(
    pool,
    {
      partition: partitionOf(route),
      basis: COMMUNITY_PLATFORM_BASIS,
      receipt: {
        actorAccountId: COMMUNITY_PLATFORM_BASIS.actorAccountId,
        kind: 'community.account-erasure.start',
        key: accountId,
        digest: createHash('sha256').update(status.at).digest(),
      },
    },
    async (tx) => {
      await closeErasureFence(tx, accountId);
      await tx.query(
        `INSERT INTO community.account_erasure_progress(route,account_id,step,phase,cursor,erased_at)
         VALUES ($1,$2,1,'memberships',NULL,$3::timestamptz)
         ON CONFLICT (route,account_id) DO NOTHING`,
        [route, accountId, status.at],
      );
      return noEffect(null);
    },
  );

  const progress = await readProgress(pool, accountId);
  if (!progress) throw new Error('Community account-erasure progress was not created');
  return { phase: progress.phase, step: Number(progress.step) };
}

async function persist(
  pool: Pool,
  accountId: string,
  progress: Progress,
  next: {
    phase: Phase;
    cursor: Cursor;
    found: boolean;
    pending: boolean;
    reasonsKeptUntil: Date | null;
    ratingHadVotes: boolean;
  },
): Promise<void> {
  const route = homeRoute(accountId);
  const expectedStep = Number(progress.step);
  const receiptKey = `${accountId}:${expectedStep}`;
  await runCommand(
    pool,
    {
      partition: partitionOf(route),
      basis: COMMUNITY_PLATFORM_BASIS,
      receipt: {
        actorAccountId: COMMUNITY_PLATFORM_BASIS.actorAccountId,
        kind: 'community.account-erasure.progress',
        key: receiptKey,
        digest: createHash('sha256').update(JSON.stringify(next)).digest(),
      },
    },
    async (tx) => {
      const result = await tx.query(
        `UPDATE community.account_erasure_progress
         SET step=step+1,phase=$3,cursor=$4::jsonb,
             community_found=community_found OR $5,
             phase_pending=$6,
             reasons_kept_until=CASE WHEN $7::timestamptz IS NULL THEN reasons_kept_until
               ELSE GREATEST(COALESCE(reasons_kept_until,$7::timestamptz),$7::timestamptz) END,
             rating_had_votes=rating_had_votes OR $8
         WHERE route=$1 AND account_id=$2 AND step=$9`,
        [
          route,
          accountId,
          next.phase,
          next.cursor === null ? null : JSON.stringify(next.cursor),
          next.found,
          next.pending,
          next.reasonsKeptUntil?.toISOString() ?? null,
          next.ratingHadVotes,
          expectedStep,
        ],
      );
      if (!result.rowCount) throw new Error('Community account-erasure progress step changed unexpectedly');
      return noEffect(null);
    },
  );
}

async function phasePage(context: WorkContext, accountId: string, progress: Progress): Promise<Page> {
  const { pool, clock } = context;
  if (progress.phase === 'memberships') {
    return eraseAccountMembershipsPage(
      { pool, access: context.getAuthorization().access, clock, deadline: Date.now() + 60_000 },
      accountId,
      stringCursor(progress.cursor, 'membership'),
    );
  }
  if (progress.phase === 'revisions')
    return eraseAccountRevisionsPage({ pool }, accountId, stringCursor(progress.cursor, 'revision'));
  if (progress.phase === 'records') {
    const result = await eraseAccountCommunityRecordsPage({ pool }, accountId, {
      erasedAt: progress.erased_at.toISOString(),
      after: recordsCursor(progress.cursor),
    });
    return {
      next: result.next,
      found: result.found,
      pending: result.pending,
      reasonsKeptUntil: result.reasonsKeptUntil,
    };
  }
  if (progress.phase === 'notices')
    return eraseAccountNoticesPage({ pool }, accountId, stringCursor(progress.cursor, 'notice'));
  throw new Error(`Community account-erasure phase ${progress.phase} is not a page phase`);
}

async function prove(pool: Pool, accountId: string, progress: Progress) {
  const route = homeRoute(accountId);
  const expiry = progress.reasons_kept_until?.toISOString() ?? null;
  return withConnection(pool, async (client) => {
    const result = await client.query<LocatorProof>(
      `SELECT
        EXISTS (
          SELECT 1 FROM community.erasure_fence
          WHERE route=$1::integer AND account_id=$2::uuid AND closed_at IS NULL
        ) AS fence_open,
        EXISTS (
          SELECT 1 FROM community.member_locator
          WHERE route=$1::integer AND account_id=$2::uuid
        ) AS member_locator,
        EXISTS (
          SELECT 1 FROM community.revision_locator
          WHERE route=$1::integer AND account_id=$2::uuid
        ) AS revision_locator,
        EXISTS (
          SELECT 1 FROM community.party_locator
          WHERE route=$1::integer AND account_id=$2::uuid
            AND (kind <> 'ban_actor' OR $3::timestamptz IS NULL
              OR due_at <= $4::timestamptz OR due_at > $3::timestamptz)
        ) AS unexpected_party_locator,
        EXISTS (
          SELECT 1 FROM content.notice
          WHERE route=$1::integer AND recipient_id=$2::uuid
        ) AS notice,
        EXISTS (
          SELECT 1 FROM content.notice_seen
          WHERE route=$1::integer AND account_id=$2::uuid
        ) AS notice_seen,
        EXISTS (
          SELECT 1 FROM access.erasure_late_item
          WHERE route=$1::integer AND account_id=$2::uuid
            AND participant='community' AND resolved_at IS NULL
        ) AS late_item`,
      [route, accountId, expiry, progress.erased_at.toISOString()],
    );
    const due = await nextDue.run(client, { route, account_id: accountId });
    const row = result.rows[0];
    if (!row) throw new Error('Community account-erasure locator proof returned no row');
    return { ...row, next_due_at: due?.due_at ?? null };
  });
}

function validateRatingStatus(value: unknown): { done: boolean; hadVotes: boolean } {
  if (
    !value ||
    typeof value !== 'object' ||
    !('done' in value) ||
    typeof value.done !== 'boolean' ||
    !('hadVotes' in value) ||
    typeof value.hadVotes !== 'boolean'
  )
    throw new TypeError('Rating erasure status is invalid');
  return { done: value.done, hadVotes: value.hadVotes };
}

async function step(context: WorkContext, accountId: string, expectedStep: number): Promise<Continuation> {
  const { pool, clock } = context;
  const progress = await readProgress(pool, accountId);
  if (!progress) return start(pool, accountId);
  if (Number(progress.step) !== expectedStep) return { phase: progress.phase, step: Number(progress.step) };

  if (progress.phase === 'close') return start(pool, accountId);

  let nextPhase: Phase = progress.phase;
  let nextCursor = pageCursor(progress.cursor, progress.phase);
  let found = false;
  let pending = false;
  let reasonsKeptUntil: Date | null = progress.reasons_kept_until;
  let ratingHadVotes = false;
  let delayMs: number | undefined;
  let retentionAt: string | null = null;

  try {
    if (
      progress.phase === 'memberships' ||
      progress.phase === 'revisions' ||
      progress.phase === 'records' ||
      progress.phase === 'notices'
    ) {
      const page = await phasePage(context, accountId, progress);
      found = page.found > 0;
      const seenPending = progress.phase_pending || page.pending > 0;
      if (progress.phase === 'records') reasonsKeptUntil = later(reasonsKeptUntil, page.reasonsKeptUntil ?? null);
      if (page.next !== null) {
        nextCursor = page.next;
        pending = seenPending;
      } else if (seenPending) {
        nextCursor = null;
        pending = false;
        delayMs = RECHECK_DELAY_MS;
      } else {
        nextCursor = null;
        pending = false;
        nextPhase =
          progress.phase === 'memberships'
            ? 'revisions'
            : progress.phase === 'revisions'
              ? 'records'
              : progress.phase === 'records'
                ? 'notices'
                : 'rating';
      }
    } else if (progress.phase === 'rating' || progress.phase === 'proof') {
      const rating = validateRatingStatus(await readRatingErasureDone({ pool }, accountId));
      ratingHadVotes = rating.hadVotes;
      if (!rating.done) {
        nextPhase = 'rating';
        nextCursor = null;
        delayMs = RECHECK_DELAY_MS;
      } else if (progress.phase === 'rating') {
        nextPhase = 'proof';
        nextCursor = null;
      } else {
        const current = await readErasureStatus(pool, accountId);
        if (!current || Date.parse(current.at) !== progress.erased_at.getTime())
          throw new Error('Community erasure proof lost its committed obligation');
        const result = await prove(pool, accountId, progress);
        if (result.late_item) {
          nextPhase = 'proof';
          nextCursor = null;
          delayMs = RECHECK_DELAY_MS;
        } else if (
          result.fence_open ||
          result.member_locator ||
          result.revision_locator ||
          result.unexpected_party_locator ||
          result.notice ||
          result.notice_seen
        ) {
          throw new Error('Community account-erasure locator proof found unhandled data');
        } else {
          if (progress.reasons_kept_until !== null && result.next_due_at === null)
            throw new Error('Retained community ban reasons have no expiry locator');
          if (progress.reasons_kept_until === null && result.next_due_at !== null)
            throw new Error('Community ban reason locator has no retention exception');

          const outcome: ErasureOutcome =
            progress.community_found || progress.rating_had_votes || rating.hadVotes ? 'erased' : 'none';
          const retained: readonly RetentionException[] = progress.reasons_kept_until
            ? [
                {
                  store: 'community.realm_ban',
                  fields: ['reason'],
                  purpose: RETENTION_PURPOSE,
                  expiresAt: progress.reasons_kept_until,
                },
              ]
            : [];
          await acknowledgeErasure({ pool, clock }, { accountId, participant: 'community', outcome, retained });
          retentionAt = result.next_due_at;
          nextPhase = 'complete';
          nextCursor = null;
        }
      }
    } else if (progress.phase === 'complete') {
      return null;
    } else {
      throw new Error(`Unknown community account-erasure phase ${progress.phase}`);
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'CommunityErasureProducerUnavailableError') throw error;
    nextPhase = progress.phase;
    nextCursor = progress.cursor;
    pending = false;
    delayMs = RECHECK_DELAY_MS;
  }

  await persist(pool, accountId, progress, {
    phase: nextPhase,
    cursor: nextCursor,
    found,
    pending,
    reasonsKeptUntil,
    ratingHadVotes,
  });
  if (nextPhase === 'complete') return { phase: 'complete', step: expectedStep + 1, retentionAt };
  return { phase: nextPhase, step: expectedStep + 1, ...(delayMs ? { delayMs } : {}) };
}

async function enqueue(context: WorkContext, accountId: string, next: Exclude<Continuation, null>) {
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

export function createCommunityAccountErasureEffect(context: Pick<WorkContext, 'client'>): Effect {
  return {
    name: 'community_account_erasure',
    types: ['com.rezics.access.account-tombstoned.v1'],
    async run(event: CloudEvent) {
      const accountId = (event.data as { accountId?: unknown }).accountId;
      if (typeof accountId !== 'string' || routeOf(accountId) === null)
        throw new TypeError('Invalid community account-erasure tombstone event');
      await context.client.enqueue(
        {
          workflowName: workflow,
          queueName: 'governance',
          workflowID: workflowId(accountId, 'close', 0),
          workflowIDReusePolicy: 'return-existing',
        },
        accountId,
        0,
      );
    },
  };
}

/** Registers bounded community erasure pages and the independent ban-reason expiry workflow. */
export function registerCommunityAccountErasureWork(context: WorkContext): void {
  const run = DBOS.registerStep(
    async (accountId: string, expectedStep: number) => step(context, accountId, expectedStep),
    { name: 'community.account-erasure.run', retriesAllowed: true, maxAttempts: 10, intervalSeconds: 1 },
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
              workflowID: `${workflowId(accountId, 'complete', next.step)}:retention:${next.retentionAt}`,
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
    async (accountId: string, asOf: string, after: CommunityRecordsCursor | null) =>
      purgeAccountBanReasonsPage({ pool: context.pool }, accountId, { asOf, after }),
    { name: 'community.account-erasure.retention-page', retriesAllowed: true, maxAttempts: 10, intervalSeconds: 1 },
  );
  const resolve = DBOS.registerStep(
    async (accountId: string) =>
      resolveRetention(
        { pool: context.pool, clock: context.clock },
        { accountId, participant: 'community', store: 'community.realm_ban' },
      ),
    { name: 'community.account-erasure.retention-resolve', retriesAllowed: true, maxAttempts: 10, intervalSeconds: 1 },
  );
  DBOS.registerWorkflow(
    async (accountId: string, firstDueAt: string) => {
      let dueAt = firstDueAt;
      for (;;) {
        const waitMs = Date.parse(dueAt) - context.clock().getTime();
        if (waitMs > 0) await DBOS.sleep(waitMs);
        let after: CommunityRecordsCursor | null = null;
        let nextDueAt: string | null = null;
        do {
          const page = await purge(accountId, context.clock().toISOString(), after);
          after = page.next;
          nextDueAt = page.nextDueAt;
        } while (after !== null);
        if (nextDueAt === null) {
          await resolve(accountId);
          return;
        }
        if (Date.parse(nextDueAt) <= context.clock().getTime()) {
          dueAt = nextDueAt;
          continue;
        }
        await context.client.enqueue(
          {
            workflowName: retentionWorkflow,
            queueName: 'governance',
            workflowID: `${workflowId(accountId, 'complete', 0)}:retention:${nextDueAt}`,
            workflowIDReusePolicy: 'return-existing',
          },
          accountId,
          nextDueAt,
        );
        return;
      }
    },
    { name: retentionWorkflow },
  );
}
