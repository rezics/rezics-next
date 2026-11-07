import type { Pool } from 'pg';
import { deadlineClient, within } from './access-port.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccessClient } from '../request/access.ts';
import { PARTITIONS } from '../route/route.ts';
import repairThreads from './conversation-activity-repair-threads.sql';
import repairPosts from './conversation-activity-repair-posts.sql';
import repairEpisodes from './conversation-activity-repair-upsert.sql';

export const CONVERSATION_ACTIVITY_REPAIR_PAGE_SIZE = 100;

export type ConversationActivityRepairPage = Readonly<{
  partition: number;
  kind: 'source' | 'board' | 'thread' | 'idle';
  scannedThreads: number;
  repairedPosts: number;
  completedThreads: number;
  /** Source enumeration and visible convergence are intentionally separate. */
  sourceComplete: boolean;
  more: boolean;
}>;

type RepairFrontier = Readonly<{
  cut_epoch: number;
  cut_position: string;
  after_route: number | null;
  after_thread_id: string | null;
  complete: boolean;
  repair_after_route: number | null;
  repair_after_thread_id: string | null;
}>;
type ThreadRow = Readonly<{
  route: number;
  thread_id: string;
  first_post_id: string | null;
  thread_security_revision: string;
  board_id: string;
  board_security_revision: string;
}>;
type BoardFrontier = Readonly<{
  route: number;
  board_id: string;
  generation: string;
  source_epoch: number;
  source_position: string;
  source_event_seq: number;
  after_thread_id: string | null;
}>;
type OpeningRow = Readonly<{
  route: number;
  thread_id: string;
  post_id: string;
  coverage_state: 'uncovered' | 'repairing';
  coverage_generation: string;
  coverage_epoch: number;
  coverage_position: string;
  coverage_event_seq: number;
  coverage_reply_count: string;
  coverage_latest_post_id: string | null;
  coverage_latest_at: string | null;
  coverage_thread_security_revision: string | null;
  coverage_board_id: string | null;
  coverage_board_security_revision: string | null;
  coverage_board_generation: string;
  repair_generation: string | null;
  repair_after_created_at: string | null;
  repair_after_post_id: string | null;
  repair_missing_publication: boolean;
  repair_source_epoch: number | null;
  repair_source_position: string | null;
}>;
type RepairPostRow = Readonly<{
  route: number;
  thread_id: string;
  post_id: string;
  first_post_id: string;
  created_at: string;
  post_visibility: string;
  post_availability: string;
  author_erased: boolean;
  security_revision: string;
  head_availability: string | null;
  thread_visibility: string;
  thread_availability: string;
  thread_security_revision: string;
  board_id: string;
  board_visibility: string;
  board_security_revision: string;
  has_saved_contribution: boolean;
  contributed_at: string | null;
  has_publication_source: boolean;
}>;

/**
 * Advances exactly one resumable native prefix: the raw thread census, one
 * board invalidation page, or one thread's ordered post page. Each transaction
 * commits its frontier with the data it covers so a retry replays safely.
 */
export async function repairConversationActivityPage(
  pool: Pool,
  partitionNo: number,
  deadline: number,
): Promise<ConversationActivityRepairPage> {
  if (!Number.isInteger(partitionNo) || partitionNo < 0 || partitionNo >= PARTITIONS)
    throw new RangeError('Invalid conversation activity partition');
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try {
        const partition = await readPartition(client, partitionNo);
        if (!partition || partition.writeState === 'moved')
          throw new Error('Conversation activity repair partition is unavailable');
        const frontier = await ensureFrontier(client, partitionNo, partition.epoch, partition.position);
        const sourceComplete = frontier.complete;
        const boardPage = await repairBoardPage(client, partitionNo);
        if (boardPage) {
          await client.query('COMMIT');
          return { partition: partitionNo, kind: 'board', sourceComplete, ...boardPage };
        }
        if (!sourceComplete) {
          const source = await repairSourcePage(client, partitionNo, frontier);
          await client.query('COMMIT');
          return {
            partition: partitionNo,
            kind: 'source',
            scannedThreads: source.scannedThreads,
            repairedPosts: 0,
            completedThreads: 0,
            sourceComplete: source.sourceComplete,
            more: !source.sourceComplete,
          };
        }
        const thread = await nextOpening(client, partitionNo);
        if (!thread) {
          await client.query('COMMIT');
          return {
            partition: partitionNo,
            kind: 'idle',
            scannedThreads: 0,
            repairedPosts: 0,
            completedThreads: 0,
            sourceComplete: true,
            more: false,
          };
        }
        const repaired = await repairThreadPage(client, partitionNo, partition.epoch, partition.position, thread);
        await client.query('COMMIT');
        return {
          partition: partitionNo,
          kind: 'thread',
          scannedThreads: 0,
          repairedPosts: repaired.repairedPosts,
          completedThreads: repaired.completed ? 1 : 0,
          sourceComplete: true,
          more: repaired.more,
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
}

async function ensureFrontier(
  client: AccessClient,
  partitionNo: number,
  epoch: number,
  position: bigint,
): Promise<RepairFrontier> {
  await client.query(
    `INSERT INTO content.conversation_activity_repair_frontier
       (partition_no, cut_epoch, cut_position, complete)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (partition_no) DO NOTHING`,
    [partitionNo, epoch, position.toString()],
  );
  const { rows } = await client.query<RepairFrontier>(
    `SELECT cut_epoch, cut_position::text, after_route, after_thread_id, complete,
            repair_after_route, repair_after_thread_id
       FROM content.conversation_activity_repair_frontier
      WHERE partition_no=$1 FOR UPDATE`,
    [partitionNo],
  );
  if (!rows[0]) throw new Error('Conversation activity repair frontier is missing');
  return rows[0];
}

async function repairSourcePage(
  client: AccessClient,
  partitionNo: number,
  frontier: RepairFrontier,
): Promise<{ scannedThreads: number; sourceComplete: boolean }> {
  const parameters = {
    first_route: partitionNo * 16,
    last_route: partitionNo * 16 + 15,
    after_route: frontier.after_route,
    after_thread_id: frontier.after_thread_id,
    limit: CONVERSATION_ACTIVITY_REPAIR_PAGE_SIZE + 1,
  };
  const result = await client.query<ThreadRow>(
    repairThreads.sql,
    repairThreads.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  const page = result.rows.slice(0, CONVERSATION_ACTIVITY_REPAIR_PAGE_SIZE);
  await seedOpenings(client, page, frontier.cut_epoch, frontier.cut_position);
  const hasMore = result.rows.length > CONVERSATION_ACTIVITY_REPAIR_PAGE_SIZE;
  const last = page.at(-1);
  await client.query(
    `UPDATE content.conversation_activity_repair_frontier
        SET after_route=$2, after_thread_id=$3, complete=$4
      WHERE partition_no=$1`,
    [partitionNo, hasMore ? (last?.route ?? null) : null, hasMore ? (last?.thread_id ?? null) : null, !hasMore],
  );
  return { scannedThreads: page.length, sourceComplete: !hasMore };
}

async function seedOpenings(
  client: AccessClient,
  threads: readonly ThreadRow[],
  cutEpoch: number,
  cutPosition: string,
): Promise<void> {
  if (!threads.length) return;
  await client.query(
    `INSERT INTO content.conversation_activity_episode
       (route, post_id, thread_id, opening, contributed_at, native_eligible, public_eligible,
        security_revision, source_epoch, source_position, source_event_seq,
        coverage_state, coverage_generation, coverage_epoch, coverage_position, coverage_event_seq)
     SELECT source.route, source.first_post_id, source.thread_id, true, NULL, false, false,
            source.thread_security_revision, $2, $3, 0, 'uncovered', 1, $2, $3, 0
       FROM jsonb_to_recordset($1::jsonb) AS source(
         route integer, thread_id uuid, first_post_id uuid, thread_security_revision bigint)
      WHERE source.first_post_id IS NOT NULL
     ON CONFLICT (route, post_id) DO NOTHING`,
    [
      JSON.stringify(
        threads.map((thread) => ({
          route: thread.route,
          thread_id: thread.thread_id,
          first_post_id: thread.first_post_id,
          thread_security_revision: thread.thread_security_revision,
        })),
      ),
      cutEpoch,
      cutPosition,
    ],
  );
  const routes = threads.map(({ route }) => route);
  const ids = threads.map(({ thread_id }) => thread_id);
  await client.query(
    `UPDATE content.conversation_activity_episode AS opening
        SET coverage_epoch=$3, coverage_position=$4, coverage_event_seq=0,
            coverage_state='uncovered'
       FROM unnest($1::integer[], $2::uuid[]) AS selected(route, thread_id)
      WHERE opening.route=selected.route AND opening.thread_id=selected.thread_id AND opening.opening
        AND opening.coverage_epoch=0`,
    [routes, ids, cutEpoch, cutPosition],
  );
}

async function repairBoardPage(
  client: AccessClient,
  partitionNo: number,
): Promise<Pick<
  ConversationActivityRepairPage,
  'scannedThreads' | 'repairedPosts' | 'completedThreads' | 'more'
> | null> {
  const { rows } = await client.query<BoardFrontier>(
    `SELECT route, board_id, generation::text, source_epoch, source_position::text,
            source_event_seq, after_thread_id
       FROM content.conversation_activity_board_frontier
      WHERE route BETWEEN $1 AND $2 AND NOT complete
      ORDER BY route, board_id
      LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [partitionNo * 16, partitionNo * 16 + 15],
  );
  const board = rows[0];
  if (!board) return null;
  const { rows: threads } = await client.query<ThreadRow>(
    `SELECT thread.route, thread.thread_id, thread.first_post_id,
            thread.security_revision::text AS thread_security_revision,
            thread.board_id, board.security_revision::text AS board_security_revision
       FROM content.thread AS thread
       JOIN content.board AS board
         ON board.route=thread.route AND board.board_id=thread.board_id
      WHERE thread.route=$1 AND thread.board_id=$2
        AND thread.thread_id>=COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
        AND ($3::uuid IS NULL OR thread.thread_id>$3::uuid)
      ORDER BY thread.thread_id LIMIT $4`,
    [board.route, board.board_id, board.after_thread_id, CONVERSATION_ACTIVITY_REPAIR_PAGE_SIZE + 1],
  );
  const page = threads.slice(0, CONVERSATION_ACTIVITY_REPAIR_PAGE_SIZE);
  await seedOpenings(client, page, board.source_epoch, board.source_position);
  if (page.length) {
    await client.query(
      `UPDATE content.conversation_activity_episode AS opening
          SET coverage_state='uncovered', coverage_generation=opening.coverage_generation+1,
              coverage_epoch=CASE WHEN (opening.coverage_epoch,opening.coverage_position,opening.coverage_event_seq)
                < ($4,$5,$6) THEN $4 ELSE opening.coverage_epoch END,
              coverage_position=CASE WHEN (opening.coverage_epoch,opening.coverage_position,opening.coverage_event_seq)
                < ($4,$5,$6) THEN $5 ELSE opening.coverage_position END,
              coverage_event_seq=CASE WHEN (opening.coverage_epoch,opening.coverage_position,opening.coverage_event_seq)
                < ($4,$5,$6) THEN $6 ELSE opening.coverage_event_seq END,
              coverage_reply_count=0, coverage_latest_post_id=NULL, coverage_latest_at=NULL,
              coverage_thread_security_revision=NULL, coverage_board_id=NULL,
              coverage_board_security_revision=NULL, repair_generation=NULL,
              repair_after_created_at=NULL, repair_after_post_id=NULL,
              repair_missing_publication=false, repair_source_epoch=NULL, repair_source_position=NULL
         FROM unnest($1::integer[], $2::uuid[]) AS selected(route, thread_id)
        WHERE opening.route=selected.route AND opening.thread_id=selected.thread_id AND opening.opening
          AND opening.coverage_board_generation::text IS DISTINCT FROM $3`,
      [
        page.map((thread) => thread.route),
        page.map((thread) => thread.thread_id),
        board.generation,
        board.source_epoch,
        board.source_position,
        board.source_event_seq,
      ],
    );
  }
  const hasMore = threads.length > CONVERSATION_ACTIVITY_REPAIR_PAGE_SIZE;
  const last = page.at(-1);
  await client.query(
    `UPDATE content.conversation_activity_board_frontier
        SET after_thread_id=$3, complete=$4
      WHERE route=$1 AND board_id=$2`,
    [board.route, board.board_id, hasMore ? (last?.thread_id ?? null) : null, !hasMore],
  );
  return { scannedThreads: page.length, repairedPosts: 0, completedThreads: 0, more: hasMore };
}

async function nextOpening(client: AccessClient, partitionNo: number): Promise<OpeningRow | null> {
  const { rows: cursors } = await client.query<Pick<RepairFrontier, 'repair_after_route' | 'repair_after_thread_id'>>(
    `SELECT repair_after_route, repair_after_thread_id
       FROM content.conversation_activity_repair_frontier
      WHERE partition_no=$1`,
    [partitionNo],
  );
  const cursor = cursors[0]!;
  let rows = await dirtyOpening(client, partitionNo, cursor.repair_after_route, cursor.repair_after_thread_id);
  if (!rows[0] && (cursor.repair_after_route !== null || cursor.repair_after_thread_id !== null))
    rows = await dirtyOpening(client, partitionNo, null, null);
  const opening = rows[0];
  if (!opening) return null;
  await client.query(
    `UPDATE content.conversation_activity_repair_frontier
        SET repair_after_route=$2, repair_after_thread_id=$3 WHERE partition_no=$1`,
    [partitionNo, opening.route, opening.thread_id],
  );
  return opening;
}

async function dirtyOpening(
  client: AccessClient,
  partitionNo: number,
  afterRoute: number | null,
  afterThreadId: string | null,
): Promise<OpeningRow[]> {
  const { rows } = await client.query<OpeningRow>(
    `SELECT route, thread_id, post_id, coverage_state, coverage_generation::text,
            coverage_epoch, coverage_position::text, coverage_event_seq,
            coverage_reply_count::text, coverage_latest_post_id,
            to_char(coverage_latest_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS coverage_latest_at,
            coverage_thread_security_revision::text, coverage_board_id,
            coverage_board_security_revision::text, coverage_board_generation::text,
            repair_generation::text,
            to_char(repair_after_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS repair_after_created_at,
            repair_after_post_id, repair_missing_publication, repair_source_epoch,
            repair_source_position::text
       FROM content.conversation_activity_episode
      WHERE route BETWEEN $1 AND $2 AND opening
        AND coverage_state IN ('uncovered','repairing')
        AND (route,thread_id)>(COALESCE($3::integer,$1-1),
          COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000'::uuid))
      ORDER BY route,thread_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [partitionNo * 16, partitionNo * 16 + 15, afterRoute, afterThreadId],
  );
  return rows;
}

async function repairThreadPage(
  client: AccessClient,
  partitionNo: number,
  epoch: number,
  position: bigint,
  opening: OpeningRow,
): Promise<{ repairedPosts: number; completed: boolean; more: boolean }> {
  const generation = BigInt(opening.coverage_generation);
  const resumed = opening.coverage_state === 'repairing' && opening.repair_generation === generation.toString();
  const afterCreatedAt = resumed ? opening.repair_after_created_at : null;
  const afterPostId = resumed ? opening.repair_after_post_id : null;
  const sourceEpoch = resumed && opening.repair_source_epoch !== null ? opening.repair_source_epoch : epoch;
  const sourcePosition =
    resumed && opening.repair_source_position !== null ? opening.repair_source_position : position.toString();
  let replyCount = resumed ? BigInt(opening.coverage_reply_count) : 0n;
  let latestAt = resumed ? opening.coverage_latest_at : null;
  let latestPostId = resumed ? opening.coverage_latest_post_id : null;
  let missingPublication = resumed && opening.repair_missing_publication;

  const parameters = {
    partition_no: partitionNo,
    route: opening.route,
    thread_id: opening.thread_id,
    after_created_at: afterCreatedAt,
    after_post_id: afterPostId,
    limit: CONVERSATION_ACTIVITY_REPAIR_PAGE_SIZE + 1,
  };
  const result = await client.query<RepairPostRow>(
    repairPosts.sql,
    repairPosts.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  const page = result.rows.slice(0, CONVERSATION_ACTIVITY_REPAIR_PAGE_SIZE);
  if (!page.length) {
    await client.query(
      `UPDATE content.conversation_activity_episode
          SET coverage_state='unrecoverable', repair_generation=NULL
        WHERE route=$1 AND post_id=$2 AND coverage_generation=$3`,
      [opening.route, opening.post_id, generation.toString()],
    );
    return { repairedPosts: 0, completed: true, more: false };
  }

  const episodes = page.map((post) => {
    const nativeEligible =
      post.post_availability === 'available' &&
      post.head_availability === 'available' &&
      !post.author_erased &&
      ['published', 'protected'].includes(post.post_visibility);
    const publicEligible =
      nativeEligible &&
      post.post_visibility === 'published' &&
      post.thread_visibility === 'published' &&
      post.thread_availability === 'available' &&
      post.board_visibility === 'published';
    const contributedAt = post.has_saved_contribution || post.has_publication_source ? post.contributed_at : null;
    if (publicEligible && !contributedAt) missingPublication = true;
    if (publicEligible && post.post_id !== post.first_post_id) replyCount++;
    if (publicEligible && contributedAt && isLater(contributedAt, post.post_id, latestAt, latestPostId)) {
      latestAt = contributedAt;
      latestPostId = post.post_id;
    }
    return {
      route: post.route,
      post_id: post.post_id,
      thread_id: post.thread_id,
      opening: post.post_id === post.first_post_id,
      contributed_at: contributedAt,
      native_eligible: nativeEligible,
      public_eligible: publicEligible,
      security_revision: post.security_revision,
      source_epoch: sourceEpoch,
      source_position: sourcePosition,
      source_event_seq: 0,
    };
  });
  await client.query(repairEpisodes.sql, [JSON.stringify(episodes)]);
  const hasMore = result.rows.length > CONVERSATION_ACTIVITY_REPAIR_PAGE_SIZE;
  const last = page.at(-1)!;
  const complete = !hasMore && !missingPublication;
  const missing = missingPublication;
  await client.query(
    `UPDATE content.conversation_activity_episode AS opening
        SET coverage_state=CASE WHEN $4 THEN 'repairing' WHEN $5 THEN 'unrecoverable' ELSE 'current' END,
            coverage_epoch=CASE WHEN NOT $4 AND NOT $5
              AND (opening.coverage_epoch,opening.coverage_position,opening.coverage_event_seq)<($17,$18,1000)
              THEN $17 ELSE opening.coverage_epoch END,
            coverage_position=CASE WHEN NOT $4 AND NOT $5
              AND (opening.coverage_epoch,opening.coverage_position,opening.coverage_event_seq)<($17,$18,1000)
              THEN $18 ELSE opening.coverage_position END,
            coverage_event_seq=CASE WHEN NOT $4 AND NOT $5
              AND (opening.coverage_epoch,opening.coverage_position,opening.coverage_event_seq)<($17,$18,1000)
              THEN 1000 ELSE opening.coverage_event_seq END,
            coverage_reply_count=$6,
            coverage_latest_at=$7::timestamptz,
            coverage_latest_post_id=$8::uuid,
            coverage_thread_security_revision=$9::bigint,
            coverage_board_id=$10::uuid,
            coverage_board_security_revision=$11::bigint,
            coverage_board_generation=$12::bigint,
            repair_generation=CASE WHEN $4 THEN $13::bigint ELSE NULL END,
            repair_after_created_at=CASE WHEN $4 THEN $14::timestamptz ELSE NULL END,
            repair_after_post_id=CASE WHEN $4 THEN $15::uuid ELSE NULL END,
            repair_missing_publication=$16,
            repair_source_epoch=CASE WHEN $4 THEN $17::integer ELSE NULL END,
            repair_source_position=CASE WHEN $4 THEN $18::bigint ELSE NULL END
      WHERE opening.route=$1 AND opening.post_id=$2 AND opening.coverage_generation=$3`,
    [
      opening.route,
      opening.post_id,
      generation.toString(),
      hasMore,
      missing,
      replyCount.toString(),
      latestAt,
      latestPostId,
      page[0]!.thread_security_revision,
      page[0]!.board_id,
      page[0]!.board_security_revision,
      await boardGeneration(client, opening.route, page[0]!.board_id),
      generation.toString(),
      last.created_at,
      last.post_id,
      missing,
      sourceEpoch,
      sourcePosition,
    ],
  );
  return { repairedPosts: page.length, completed: complete, more: hasMore };
}

function isLater(
  candidateAt: string,
  candidateId: string,
  currentAt: string | null,
  currentId: string | null,
): boolean {
  return (
    currentAt === null || candidateAt > currentAt || (candidateAt === currentAt && candidateId > (currentId ?? ''))
  );
}

async function boardGeneration(client: AccessClient, route: number, boardId: string): Promise<string> {
  const { rows } = await client.query<{ generation: string }>(
    `SELECT COALESCE((SELECT generation FROM content.conversation_activity_board_frontier
                       WHERE route=$1 AND board_id=$2),0)::text AS generation`,
    [route, boardId],
  );
  return rows[0]!.generation;
}
