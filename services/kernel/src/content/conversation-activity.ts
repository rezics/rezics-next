import type {
  ConversationActivityReplyCount,
  ConversationActivityWitness as SelectedActivityWitness,
  ConversationActivityCurrent as SelectedActivityCurrent,
  ConversationActivitySelection as SelectedActivitySelection,
} from './community-projection/index.ts';
import { Value } from 'typebox/value';
import type { Pool } from 'pg';
import type { AccessClient } from '../request/access.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { CommandUnavailableError, runCommand } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS, type ContentEventType } from './events.ts';
import type { AnchoredPosition } from './model.ts';
import page from './conversation-activity-page.sql';
import upsert from './conversation-activity-upsert.sql';
import sourceActivity from './read-source-activity.sql';
import sourceEvent from './read-outbox-event-index.sql';
import batchPage from './conversation-activity-batch.sql';
import adjustSource from './conversation-activity-adjust-source.sql';
import latestContribution from './conversation-activity-latest.sql';

const publication = 'com.rezics.content.post.published.v1';
const sourceTypes = [
  'com.rezics.content.thread.created.v1',
  'com.rezics.content.post.created.v1',
  'com.rezics.content.revision.created.v1',
  publication,
  'com.rezics.content.post.erased.v1',
  'com.rezics.content.post.restored.v1',
  'com.rezics.content.moderation.takedown.v1',
  'com.rezics.content.moderation.restored.v1',
  'com.rezics.content.moderation.erasure.v1',
] as const satisfies readonly ContentEventType[];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CONVERSATION_ACTIVITY_SOURCE_LIMIT = 32;
export const CONVERSATION_ACTIVITY_BATCH_LIMIT = 100;
export const CONVERSATION_ACTIVITY_REPLY_COUNT_CAP = 10_000;

/** Internal candidates only. Neither a timestamp nor a length is a disclosed figure. */
export type ConversationContributionSource = Readonly<{
  postId: string;
  opening: boolean;
  contributedAt: string;
}>;
export type ConversationActivitySource = Readonly<{
  threadId: string;
  coverage: 'unproven';
  contributions: readonly ConversationContributionSource[];
  /** A full prefix may have more rows; this is not an exact count. */
  more: boolean;
  anchor: AnchoredPosition;
}>;

// Native adapters bind the pure selected-value contracts to their partition anchor.
export type { ConversationActivityReplyCount, ConversationActivityWithheld } from './community-projection/index.ts';
export type ConversationActivityWitness = SelectedActivityWitness<AnchoredPosition>;
export type ConversationActivityCurrent = SelectedActivityCurrent<AnchoredPosition>;
export type ConversationActivitySelection = SelectedActivitySelection<AnchoredPosition>;
export type ConversationActivityBatch = Readonly<{
  /** Selects by raw keys, before consumer hydration. It never returns a protected cohort. */
  select(threadIds: readonly string[], deadline: number): Promise<readonly ConversationActivitySelection[]>;
  /** Reopens current native thread, place and cohort state after hydration. */
  confirm(
    selected: readonly ConversationActivitySelection[],
    deadline: number,
  ): Promise<readonly ConversationActivitySelection[]>;
}>;
export {
  CONVERSATION_ACTIVITY_REPAIR_PAGE_SIZE,
  repairConversationActivityPage,
} from './conversation-activity-repair.ts';

export function toConversationActivityReplyCount(count: bigint | string): ConversationActivityReplyCount {
  const value = typeof count === 'bigint' ? count : BigInt(count);
  if (value < 0n) throw new RangeError('Conversation activity count cannot be negative');
  const cap = BigInt(CONVERSATION_ACTIVITY_REPLY_COUNT_CAP);
  return value > cap
    ? { kind: 'lower-bound', value: CONVERSATION_ACTIVITY_REPLY_COUNT_CAP }
    : { kind: 'exact', value: Number(value) };
}

type ConversationActivityBatchRow = Readonly<{
  thread_id: string | null;
  board_id: string | null;
  thread_security_revision: string | null;
  thread_visibility: string | null;
  thread_availability: string | null;
  board_security_revision: string | null;
  board_visibility: string | null;
  realm_id: string | null;
  board_generation: string;
  coverage_state: string | null;
  coverage_generation: string | null;
  coverage_epoch: number | null;
  coverage_position: string | null;
  coverage_event_seq: number | null;
  reply_count: string | null;
  coverage_latest_post_id: string | null;
  latest_at: string | null;
  covered_thread_security_revision: string | null;
  coverage_board_id: string | null;
  covered_board_security_revision: string | null;
  covered_board_generation: string | null;
}>;

function activitySelection(
  threadId: string,
  row: ConversationActivityBatchRow | undefined,
  anchor: AnchoredPosition,
): ConversationActivitySelection {
  if (!row?.thread_id || !row.board_id || !row.thread_security_revision || !row.board_security_revision)
    return { threadId, status: 'withheld', reason: 'missing' };
  if (
    row.thread_availability !== 'available' ||
    row.thread_visibility !== 'published' ||
    row.board_visibility !== 'published'
  )
    return { threadId, status: 'withheld', reason: 'unsupported-cohort' };
  if (
    row.coverage_state !== 'current' ||
    row.coverage_generation === null ||
    row.coverage_epoch === null ||
    row.coverage_position === null ||
    row.coverage_event_seq === null ||
    row.reply_count === null ||
    row.covered_thread_security_revision !== row.thread_security_revision ||
    row.coverage_board_id !== row.board_id ||
    row.covered_board_security_revision !== row.board_security_revision ||
    row.covered_board_generation !== row.board_generation
  )
    return { threadId, status: 'withheld', reason: 'coverage' };
  const replyCount = BigInt(row.reply_count);
  if (row.latest_at === null) return { threadId, status: 'withheld', reason: 'coverage' };
  return {
    threadId,
    status: 'current',
    cohort: 'public',
    replyCount: toConversationActivityReplyCount(replyCount),
    lastContributionAt: row.latest_at?.replace(/(\.\d{3})000Z$/, '$1Z') ?? null,
    witness: {
      threadId,
      boardId: row.board_id,
      threadSecurityRevision: row.thread_security_revision,
      boardSecurityRevision: row.board_security_revision,
      realmId: row.realm_id,
      boardGeneration: row.board_generation,
      generation: row.coverage_generation,
      sourceHead: {
        epoch: row.coverage_epoch,
        position: BigInt(row.coverage_position),
        eventSeq: row.coverage_event_seq,
      },
      source: anchor,
    },
  };
}

/** Factory bound at the consumer's selected native key set, before labels/actions are hydrated. */
export function createConversationActivityBatch(pool: Pool): ConversationActivityBatch {
  async function select(
    threadIds: readonly string[],
    deadline: number,
  ): Promise<readonly ConversationActivitySelection[]> {
    if (threadIds.length > CONVERSATION_ACTIVITY_BATCH_LIMIT)
      throw new RangeError('Conversation activity accepts at most 100 raw keys');
    const unique = [...new Set(threadIds)];
    const groups = new Map<number, { route: number; thread_id: string }[]>();
    for (const id of unique) {
      const home = route(id);
      const partition = partitionOf(home);
      const keys = groups.get(partition) ?? [];
      keys.push({ route: home, thread_id: id });
      groups.set(partition, keys);
    }
    const result = new Map<string, ConversationActivitySelection>();
    for (const [partitionNo, keys] of groups) {
      const current = await within(deadline, () =>
        withConnection(pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const partition = await readPartition(client, partitionNo);
            if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
            if (partition.writeState === 'moved')
              throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
            const parameters = { keys: JSON.stringify(keys) };
            const { rows } = await client.query<ConversationActivityBatchRow>(
              batchPage.sql,
              batchPage.params.map((name) => parameters[name as keyof typeof parameters]),
            );
            await client.query('COMMIT');
            return {
              rows,
              anchor: { partition, epoch: partition.epoch, position: partition.position },
            };
          } catch (error) {
            try {
              await connection.query('ROLLBACK');
            } catch (rollbackError) {
              discardConnection(connection, rollbackError as Error);
            }
            throw error;
          }
        }),
      );
      const byThread = new Map(current.rows.map((row) => [row.thread_id, row]));
      for (const key of keys)
        result.set(key.thread_id, activitySelection(key.thread_id, byThread.get(key.thread_id), current.anchor));
    }
    return unique.map((id) => result.get(id)!);
  }

  return Object.freeze({
    select,
    async confirm(selected, deadline) {
      if (selected.length > CONVERSATION_ACTIVITY_BATCH_LIMIT)
        throw new RangeError('Conversation activity accepts at most 100 raw keys');
      const current = await select(
        selected
          .filter((item): item is ConversationActivityCurrent => item.status === 'current')
          .map(({ threadId }) => threadId),
        deadline,
      );
      const byThread = new Map(current.map((item) => [item.threadId, item]));
      return selected.map((item) => {
        if (item.status !== 'current') return item;
        const now = byThread.get(item.threadId);
        if (
          now?.status !== 'current' ||
          now.witness.generation !== item.witness.generation ||
          now.witness.threadSecurityRevision !== item.witness.threadSecurityRevision ||
          now.witness.boardId !== item.witness.boardId ||
          now.witness.boardSecurityRevision !== item.witness.boardSecurityRevision ||
          now.witness.boardGeneration !== item.witness.boardGeneration ||
          now.witness.realmId !== item.witness.realmId ||
          now.witness.sourceHead.epoch !== item.witness.sourceHead.epoch ||
          now.witness.sourceHead.position !== item.witness.sourceHead.position ||
          now.witness.sourceHead.eventSeq !== item.witness.sourceHead.eventSeq ||
          now.replyCount.kind !== item.replyCount.kind ||
          now.replyCount.value !== item.replyCount.value ||
          now.lastContributionAt !== item.lastContributionAt
        )
          return { threadId: item.threadId, status: 'withheld', reason: 'stale' } as const;
        return now;
      });
    },
  });
}

function route(id: string): number {
  const value = routeOf(id);
  if (!uuid.test(id) || value === null) throw new TypeError('Invalid conversation activity identity');
  return value;
}

function source(event: CloudEvent, id: string) {
  const match = /^urn:rezics:log:(0|[1-9][0-9]*)\.([1-9][0-9]*)$/.exec(event.source);
  const epoch = Number(match?.[2]);
  const partition = partitionOf(route(id));
  if (
    !match ||
    Number(match[1]) !== partition ||
    !Number.isSafeInteger(epoch) ||
    epoch > 2147483647 ||
    !uuid.test(event.id) ||
    event.specversion !== '1.0' ||
    event.datacontenttype !== 'application/json' ||
    !/^\d{19}$/.test(event.sequence) ||
    BigInt(event.sequence) < 1n ||
    BigInt(event.sequence) > 9223372036854775807n
  )
    throw new TypeError('Invalid conversation activity source envelope');
  return { partition, epoch, position: BigInt(event.sequence) };
}

type Targets = Readonly<{
  postIds: readonly string[];
  threadId?: string;
  boardId?: string;
  contributedAt: string | null;
}>;
function targets(event: CloudEvent): Targets {
  if (!sourceTypes.includes(event.type as (typeof sourceTypes)[number]))
    throw new TypeError('Unsupported conversation activity event');
  const type = event.type as (typeof sourceTypes)[number];
  if (!Value.Check(CONTENT_EVENTS[type], event.data)) throw new TypeError('Invalid conversation activity payload');
  const data = event.data as Record<string, unknown>;
  if (type === 'com.rezics.content.moderation.erasure.v1')
    return { postIds: data.postIds as string[], threadId: data.threadId as string, contributedAt: null };
  if (type === 'com.rezics.content.moderation.takedown.v1' || type === 'com.rezics.content.moderation.restored.v1') {
    return {
      postIds: data.targetKind === 'post' ? [data.targetId as string] : [],
      ...(data.targetKind === 'thread' ? { threadId: data.targetId as string } : {}),
      ...(data.targetKind === 'board' ? { boardId: data.targetId as string } : {}),
      contributedAt: null,
    };
  }
  if ('postId' in data) return { postIds: [data.postId as string], contributedAt: null };
  return {
    postIds: [data.itemId as string],
    threadId: data.threadId as string,
    contributedAt: type === publication ? (data.activityAt as string) : null,
  };
}

class UnchangedActivity extends Error {}

async function proveEnvelope(client: AccessClient, event: CloudEvent, id: string) {
  const identity = source(event, id);
  const proof = await sourceEvent.run(client, {
    partition_no: identity.partition,
    epoch: identity.epoch,
    position: identity.position,
    id: event.id,
    type: event.type,
    subject: event.subject ?? null,
    data: event.data,
  });
  if (proof.length !== 1 || proof[0]!.event_count > 1000 || proof[0]!.event_seq >= proof[0]!.event_count)
    throw new TypeError('Conversation activity event has no native source');
  return { ...identity, eventSeq: proof[0]!.event_seq };
}

async function invalidateActivityCoverage(
  client: AccessClient,
  threadIds: readonly string[],
  identity: Readonly<{ partition: number; epoch: number; position: bigint; eventSeq: number }>,
  force = false,
): Promise<void> {
  const unique = [...new Set(threadIds)];
  if (!unique.length) return;
  const route = routeOf(unique[0]!);
  if (route === null || partitionOf(route) !== identity.partition || unique.some((id) => routeOf(id) !== route))
    throw new TypeError('Conversation activity invalidation crosses a home');
  await client.query(
    `UPDATE content.conversation_activity_episode AS opening
       SET coverage_state='uncovered', coverage_generation=opening.coverage_generation + 1,
           coverage_epoch=CASE WHEN (opening.coverage_epoch,opening.coverage_position,opening.coverage_event_seq)
             < ($3,$4,$5) THEN $3 ELSE opening.coverage_epoch END,
           coverage_position=CASE WHEN (opening.coverage_epoch,opening.coverage_position,opening.coverage_event_seq)
             < ($3,$4,$5) THEN $4 ELSE opening.coverage_position END,
           coverage_event_seq=CASE WHEN (opening.coverage_epoch,opening.coverage_position,opening.coverage_event_seq)
             < ($3,$4,$5) THEN $5 ELSE opening.coverage_event_seq END,
           coverage_reply_count=0, coverage_latest_post_id=NULL, coverage_latest_at=NULL,
           coverage_thread_security_revision=NULL, coverage_board_id=NULL,
           coverage_board_security_revision=NULL, repair_generation=NULL,
           repair_after_created_at=NULL, repair_after_post_id=NULL,
           repair_missing_publication=false, repair_source_epoch=NULL, repair_source_position=NULL
      FROM unnest($2::uuid[]) AS affected(thread_id)
     WHERE opening.route=$1 AND opening.thread_id=affected.thread_id AND opening.opening
       AND ((opening.coverage_epoch, opening.coverage_position, opening.coverage_event_seq)
         < ($3, $4, $5) OR ($6 AND opening.coverage_state='current'))`,
    [route, unique, identity.epoch, identity.position.toString(), identity.eventSeq, force],
  );
  await client.query(
    `INSERT INTO content.conversation_activity_episode
       (route, post_id, thread_id, opening, contributed_at, native_eligible, public_eligible,
        security_revision, source_epoch, source_position, source_event_seq,
        coverage_state, coverage_generation, coverage_epoch, coverage_position, coverage_event_seq)
     SELECT thread.route, thread.first_post_id, thread.thread_id, true, NULL, false, false,
            COALESCE(opening_post.security_revision, thread.security_revision), $3, $4, $5,
            'uncovered', 1, $3, $4, $5
       FROM content.thread AS thread
       LEFT JOIN content.post AS opening_post
         ON opening_post.route=thread.route AND opening_post.post_id=thread.first_post_id
      WHERE thread.route=$1 AND thread.thread_id=ANY($2::uuid[]) AND thread.first_post_id IS NOT NULL
     ON CONFLICT (route, post_id) DO NOTHING`,
    [route, unique, identity.epoch, identity.position.toString(), identity.eventSeq],
  );
}

async function invalidateBoardCoverage(
  client: AccessClient,
  boardId: string,
  identity: Readonly<{ epoch: number; position: bigint; eventSeq: number }>,
): Promise<void> {
  const boardRoute = route(boardId);
  await client.query(
    `INSERT INTO content.conversation_activity_board_frontier AS stored
       (route, board_id, generation, source_epoch, source_position, source_event_seq, complete)
     VALUES ($1, $2, 1, $3, $4, $5, false)
     ON CONFLICT (route, board_id) DO UPDATE SET
       generation=stored.generation + 1,
       source_epoch=EXCLUDED.source_epoch,
       source_position=EXCLUDED.source_position,
       source_event_seq=EXCLUDED.source_event_seq,
       after_thread_id=NULL,
       complete=false
     WHERE (stored.source_epoch, stored.source_position, stored.source_event_seq)
       < (EXCLUDED.source_epoch, EXCLUDED.source_position, EXCLUDED.source_event_seq)`,
    [boardRoute, boardId, identity.epoch, identity.position.toString(), identity.eventSeq],
  );
}

type ActivityAdjustmentSource = Readonly<{
  thread_id: string | null;
  security_revision: string | null;
  post_id: string | null;
  post_visibility: string | null;
  post_availability: string | null;
  author_erased: boolean | null;
  head_availability: string | null;
  first_post_id: string | null;
  thread_visibility: string | null;
  thread_availability: string | null;
  thread_security_revision: string | null;
  board_id: string | null;
  board_visibility: string | null;
  board_security_revision: string | null;
  previous_opening: boolean | null;
  previous_native_eligible: boolean | null;
  previous_public_eligible: boolean | null;
  saved_contributed_at: string | null;
  publication_at: string | null;
}>;
type ActivitySummary = Readonly<{
  coverage_state: string;
  coverage_generation: string;
  coverage_reply_count: string;
  coverage_latest_post_id: string | null;
  coverage_latest_at: string | null;
  coverage_thread_security_revision: string | null;
  coverage_board_id: string | null;
  coverage_board_security_revision: string | null;
  coverage_board_generation: string;
}>;
type ActivityChange = {
  route: number;
  threadId: string;
  boardId: string | null;
  threadSecurityRevision: string | null;
  boardSecurityRevision: string | null;
  threadVisibility: string | null;
  threadAvailability: string | null;
  boardVisibility: string | null;
  delta: number;
  added: { postId: string; at: string }[];
  removedLatest: boolean;
  needsRepair: boolean;
};

/** Apply post-local inclusion changes against the previously admitted episode.
 * The opening row remains current for a bounded delta; deleting its latest
 * contribution asks the live episode index for exactly one replacement. */
async function adjustActivityCoverage(
  client: AccessClient,
  input: Targets,
  identity: Readonly<{ partition: number; epoch: number; position: bigint; eventSeq: number }>,
): Promise<void> {
  const changes = new Map<string, ActivityChange>();
  for (const postId of new Set(input.postIds)) {
    const postRoute = route(postId);
    const sourceParameters = { route: postRoute, post_id: postId, partition_no: identity.partition };
    const { rows } = await client.query<ActivityAdjustmentSource>(
      adjustSource.sql,
      adjustSource.params.map((name) => sourceParameters[name as keyof typeof sourceParameters]),
    );
    const row = rows[0];
    if (!row?.thread_id || !row.security_revision) continue;
    if (input.threadId && input.threadId !== row.thread_id)
      throw new TypeError('Conversation activity thread mismatch');
    const nativeEligible =
      row.post_availability === 'available' &&
      row.head_availability === 'available' &&
      !row.author_erased &&
      ['published', 'protected'].includes(row.post_visibility ?? '');
    const publicEligible =
      nativeEligible &&
      row.post_visibility === 'published' &&
      row.thread_visibility === 'published' &&
      row.thread_availability === 'available' &&
      row.board_visibility === 'published';
    const contributedAt = row.saved_contributed_at ?? row.publication_at;
    const opening = row.previous_opening ?? row.post_id === row.first_post_id;
    const previousPublic = row.previous_public_eligible ?? false;
    const change = changes.get(`${postRoute}:${row.thread_id}`) ?? {
      route: postRoute,
      threadId: row.thread_id,
      boardId: row.board_id,
      threadSecurityRevision: row.thread_security_revision,
      boardSecurityRevision: row.board_security_revision,
      threadVisibility: row.thread_visibility,
      threadAvailability: row.thread_availability,
      boardVisibility: row.board_visibility,
      delta: 0,
      added: [],
      removedLatest: false,
      needsRepair: false,
    };
    if (!opening && previousPublic !== publicEligible) change.delta += publicEligible ? 1 : -1;
    if (publicEligible && !contributedAt) change.needsRepair = true;
    if (publicEligible && !previousPublic && contributedAt) change.added.push({ postId, at: contributedAt });
    if (previousPublic && !publicEligible) {
      const summary = await openingSummary(client, postRoute, row.thread_id);
      if (summary?.coverage_latest_post_id === postId) change.removedLatest = true;
    }
    const parameters = {
      route: postRoute,
      post_id: postId,
      thread_id: row.thread_id,
      opening,
      contributed_at: contributedAt,
      eligible: nativeEligible,
      public_eligible: publicEligible,
      security_revision: BigInt(row.security_revision),
      source_epoch: identity.epoch,
      source_position: identity.position,
      source_event_seq: identity.eventSeq,
    };
    await client.query(
      upsert.sql,
      upsert.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    changes.set(`${postRoute}:${row.thread_id}`, change);
  }

  for (const change of changes.values()) await applyActivityChange(client, change, identity);
}

async function openingSummary(client: AccessClient, route: number, threadId: string): Promise<ActivitySummary | null> {
  const { rows } = await client.query<ActivitySummary>(
    `SELECT coverage_state, coverage_generation::text, coverage_reply_count::text,
            coverage_latest_post_id,
            to_char(coverage_latest_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS coverage_latest_at,
            coverage_thread_security_revision::text, coverage_board_id,
            coverage_board_security_revision::text, coverage_board_generation::text
       FROM content.conversation_activity_episode
      WHERE route=$1 AND thread_id=$2 AND opening FOR UPDATE`,
    [route, threadId],
  );
  return rows[0] ?? null;
}

async function applyActivityChange(
  client: AccessClient,
  change: ActivityChange,
  identity: Readonly<{ epoch: number; position: bigint; eventSeq: number }>,
): Promise<void> {
  if (change.needsRepair || !change.boardId || !change.threadSecurityRevision || !change.boardSecurityRevision) {
    await invalidateActivityCoverage(
      client,
      [change.threadId],
      { ...identity, partition: partitionOf(change.route) },
      true,
    );
    return;
  }
  const summary = await openingSummary(client, change.route, change.threadId);
  if (!summary) {
    await invalidateActivityCoverage(
      client,
      [change.threadId],
      { ...identity, partition: partitionOf(change.route) },
      true,
    );
    return;
  }
  const { rows: boardRows } = await client.query<{ generation: string }>(
    `SELECT COALESCE((SELECT generation FROM content.conversation_activity_board_frontier
                       WHERE route=$1 AND board_id=$2),0)::text AS generation`,
    [change.route, change.boardId],
  );
  const boardGeneration = boardRows[0]!.generation;
  if (
    summary.coverage_state !== 'current' ||
    summary.coverage_thread_security_revision !== change.threadSecurityRevision ||
    summary.coverage_board_id !== change.boardId ||
    summary.coverage_board_security_revision !== change.boardSecurityRevision ||
    summary.coverage_board_generation !== boardGeneration ||
    change.threadVisibility !== 'published' ||
    change.threadAvailability !== 'available' ||
    change.boardVisibility !== 'published'
  ) {
    await invalidateActivityCoverage(
      client,
      [change.threadId],
      { ...identity, partition: partitionOf(change.route) },
      true,
    );
    return;
  }
  if (change.delta === 0 && change.added.length === 0 && !change.removedLatest) return;
  const replyCount = BigInt(summary.coverage_reply_count) + BigInt(change.delta);
  if (replyCount < 0n) {
    await invalidateActivityCoverage(
      client,
      [change.threadId],
      { ...identity, partition: partitionOf(change.route) },
      true,
    );
    return;
  }
  let latestAt = summary.coverage_latest_at;
  let latestPostId = summary.coverage_latest_post_id;
  if (change.removedLatest) {
    const { rows } = await client.query<{ post_id: string; contributed_at: string }>(
      latestContribution.sql,
      latestContribution.params.map(
        (name) => ({ route: change.route, thread_id: change.threadId })[name as 'route' | 'thread_id'],
      ),
    );
    latestAt = rows[0]?.contributed_at ?? null;
    latestPostId = rows[0]?.post_id ?? null;
  } else {
    for (const candidate of change.added) {
      if (
        latestAt === null ||
        candidate.at > latestAt ||
        (candidate.at === latestAt && candidate.postId > (latestPostId ?? ''))
      ) {
        latestAt = candidate.at;
        latestPostId = candidate.postId;
      }
    }
  }
  if (latestAt === null || latestPostId === null) {
    await invalidateActivityCoverage(
      client,
      [change.threadId],
      { ...identity, partition: partitionOf(change.route) },
      true,
    );
    return;
  }
  await client.query(
    `UPDATE content.conversation_activity_episode AS opening
        SET coverage_generation=opening.coverage_generation+1,
            coverage_epoch=CASE WHEN (opening.coverage_epoch,opening.coverage_position,opening.coverage_event_seq)
              < ($3,$4,$5) THEN $3 ELSE opening.coverage_epoch END,
            coverage_position=CASE WHEN (opening.coverage_epoch,opening.coverage_position,opening.coverage_event_seq)
              < ($3,$4,$5) THEN $4 ELSE opening.coverage_position END,
            coverage_event_seq=CASE WHEN (opening.coverage_epoch,opening.coverage_position,opening.coverage_event_seq)
              < ($3,$4,$5) THEN $5 ELSE opening.coverage_event_seq END,
            coverage_reply_count=$6, coverage_latest_post_id=$7, coverage_latest_at=$8::timestamptz
      WHERE opening.route=$1 AND opening.thread_id=$2 AND opening.opening
        AND opening.coverage_state='current' AND opening.coverage_generation=$9`,
    [
      change.route,
      change.threadId,
      identity.epoch,
      identity.position.toString(),
      identity.eventSeq,
      replyCount.toString(),
      latestPostId,
      latestAt,
      summary.coverage_generation,
    ],
  );
}

/** Registered alongside board ranking, using its native source snapshot and
 * lifecycle. This is source maintenance, never an Access or disclosure engine. */
export function createConversationActivityEffect(pool: Pool): Effect {
  return {
    name: 'content_conversation_activity',
    types: [...sourceTypes],
    async admit(client, event) {
      const input = targets(event);
      const sourceId = input.postIds[0] ?? input.threadId ?? input.boardId;
      if (!sourceId) return;
      const identity = await proveEnvelope(client, event, sourceId);
      for (const id of input.postIds)
        if (partitionOf(route(id)) !== identity.partition) throw new TypeError('Foreign conversation activity target');
      if (input.threadId && partitionOf(route(input.threadId)) !== identity.partition)
        throw new TypeError('Foreign conversation activity thread');
      if (input.boardId) {
        if (partitionOf(route(input.boardId)) !== identity.partition)
          throw new TypeError('Foreign conversation activity board');
        await invalidateBoardCoverage(client, input.boardId, identity);
        return;
      }
      if (event.type === 'com.rezics.content.thread.created.v1') {
        await invalidateActivityCoverage(client, [input.threadId!], identity);
        return;
      }
      if (
        event.type === 'com.rezics.content.post.created.v1' ||
        event.type === 'com.rezics.content.revision.created.v1'
      )
        return;
      if (input.postIds.length) {
        await adjustActivityCoverage(client, input, identity);
        return;
      }
      if (input.threadId) await invalidateActivityCoverage(client, [input.threadId], identity);
    },
    async run(event) {
      const input = targets(event);
      if (!input.postIds.length) return;
      const identity = source(event, input.postIds[0]!);
      for (const id of input.postIds)
        if (partitionOf(route(id)) !== identity.partition) throw new TypeError('Foreign conversation activity target');
      if (input.threadId && partitionOf(route(input.threadId)) !== identity.partition)
        throw new TypeError('Foreign conversation activity thread');
      if (input.contributedAt !== null && !Number.isFinite(Date.parse(input.contributedAt)))
        throw new TypeError('Invalid contribution time');
      try {
        await runCommand(pool, { partition: identity.partition }, async (tx) => {
          // Proof is the exact bounded outbox envelope, not a caller-supplied
          // timestamp or the current wording's revision time.
          const sourceIdentity = await proveEnvelope(tx, event, input.postIds[0]!);
          const changed: string[] = [];
          for (const postId of input.postIds) {
            const postRoute = route(postId);
            const found = await tx.query<{ thread_id: string }>(
              'SELECT thread_id FROM content.post WHERE route = $1 AND post_id = $2',
              [postRoute, postId],
            );
            const threadId = found.rows[0]?.thread_id;
            if (!threadId) {
              // Physical purge can race a delayed lifecycle effect. Retire any
              // retained episode without reconstructing an erased contribution.
              const retired = await tx.query(
                `UPDATE content.conversation_activity_episode
                    SET native_eligible=false, public_eligible=false,
                        source_epoch=CASE WHEN (source_epoch,source_position,source_event_seq)
                          < ($3,$4,$5) THEN $3 ELSE source_epoch END,
                        source_position=CASE WHEN (source_epoch,source_position,source_event_seq)
                          < ($3,$4,$5) THEN $4 ELSE source_position END,
                        source_event_seq=CASE WHEN (source_epoch,source_position,source_event_seq)
                          < ($3,$4,$5) THEN $5 ELSE source_event_seq END
                  WHERE route=$1 AND post_id=$2 AND native_eligible
                    AND (source_epoch,source_position,source_event_seq)<($3,$4,$5)
                  RETURNING post_id`,
                [postRoute, postId, sourceIdentity.epoch, sourceIdentity.position.toString(), sourceIdentity.eventSeq],
              );
              if (retired.rowCount) changed.push(postId);
              continue;
            }
            if (input.threadId && input.threadId !== threadId)
              throw new TypeError('Conversation activity thread mismatch');
            const current = await sourceActivity.run(tx, { route: postRoute, thread_id: threadId, post_id: postId });
            if (!current?.post_id || !current.author_account_id || !current.security_revision)
              throw new Error('Conversation activity source post is unavailable');
            const eligible =
              current.post_availability === 'available' &&
              current.head_availability === 'available' &&
              !current.author_erased &&
              ['published', 'protected'].includes(current.post_visibility!);
            const publicEligible =
              eligible &&
              current.post_visibility === 'published' &&
              current.thread_visibility === 'published' &&
              current.thread_availability === 'available' &&
              current.board_visibility === 'published';
            const parameters = {
              route: postRoute,
              post_id: postId,
              thread_id: threadId,
              opening: current.first_post_id === postId,
              contributed_at: input.contributedAt,
              eligible,
              public_eligible: publicEligible,
              security_revision: BigInt(current.security_revision),
              source_epoch: sourceIdentity.epoch,
              source_position: sourceIdentity.position,
              source_event_seq: sourceIdentity.eventSeq,
            };
            const rows = await tx.query(
              upsert.sql,
              upsert.params.map((name) => parameters[name as keyof typeof parameters]),
            );
            if (rows.rowCount) changed.push(postId);
          }
          if (!changed.length) throw new UnchangedActivity();
          return {
            value: null,
            events: [
              {
                type: 'com.rezics.content.conversation-activity.projected.v1',
                data: {
                  postIds: [...new Set(changed)],
                  sourceEpoch: sourceIdentity.epoch,
                  sourcePosition: sourceIdentity.position.toString(),
                },
              },
            ],
          };
        });
      } catch (error) {
        if (!(error instanceof UnchangedActivity)) throw error;
      }
    },
  };
}

/** Trusted native producer seam. Group by represented home and release each
 * snapshot before any caller starts independent current-disclosure hydration. */
export async function readConversationActivitySources(
  pool: Pool,
  threadIds: readonly string[],
  deadline: number,
): Promise<readonly ConversationActivitySource[]> {
  // Bound raw input before deduplication, JSON encoding or pool work.
  if (threadIds.length > CONVERSATION_ACTIVITY_BATCH_LIMIT)
    throw new RangeError('Conversation activity accepts at most 100 raw keys');
  const groups = new Map<number, { route: number; thread_id: string }[]>();
  const unique = [...new Set(threadIds)];
  for (const id of unique) {
    const home = route(id);
    const partition = partitionOf(home);
    const keys = groups.get(partition) ?? [];
    keys.push({ route: home, thread_id: id });
    groups.set(partition, keys);
  }
  const result = new Map<string, ConversationActivitySource>();
  for (const [partitionNo, keys] of groups) {
    const selected = await within(deadline, () =>
      withConnection(pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const partition = await readPartition(client, partitionNo);
          if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
          if (partition.writeState === 'moved')
            throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
          const rows = await page.run(client, {
            keys: JSON.stringify(keys),
            limit: CONVERSATION_ACTIVITY_SOURCE_LIMIT,
          });
          await client.query('COMMIT');
          return { rows, anchor: { partition, epoch: partition.epoch, position: partition.position } };
        } catch (error) {
          try {
            await connection.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(connection, rollbackError as Error);
          }
          throw error;
        }
      }),
    );
    const contributions = new Map<string, ConversationContributionSource[]>();
    for (const row of selected.rows) {
      const entries = contributions.get(row.thread_id) ?? [];
      entries.push({
        postId: row.post_id,
        opening: row.opening,
        contributedAt: row.contributed_at!.replace(/(\.\d{3})000Z$/, '$1Z'),
      });
      contributions.set(row.thread_id, entries);
    }
    for (const key of keys) {
      const entries = contributions.get(key.thread_id) ?? [];
      result.set(key.thread_id, {
        threadId: key.thread_id,
        coverage: 'unproven',
        contributions: entries,
        more: entries.length === CONVERSATION_ACTIVITY_SOURCE_LIMIT,
        anchor: selected.anchor,
      });
    }
  }
  return unique.map((id) => result.get(id)!);
}
