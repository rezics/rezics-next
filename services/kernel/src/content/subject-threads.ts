import { deadlineClient, within } from '../access/authenticate.ts';
import { accessCheck, type AccessCheck, type Actor } from '../request/access.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import { ContentNotFoundError, readSubjectThread, type ContentReadDependencies, type ThreadView } from './reads.ts';
import page from './page-subject-threads.sql';
import { prepareSubjectThreadContext, type SubjectThreadContext } from './subject-threads-context.ts';

export type SubjectThreadKind = 'discussion' | 'review';
export type SubjectThreadPageInput = {
  place: string;
  kind: SubjectThreadKind;
  cursor?: string;
  limit?: number;
};
export type SubjectThreadPage = {
  context: SubjectThreadContext;
  entries: readonly ThreadView[];
  nextCursor: string | null;
  anchor: AnchoredPosition;
  anchors: readonly AnchoredPosition[];
};
export type SubjectThreadDependencies = ContentReadDependencies & {
  /** Trusted service configuration, independent of authentication's wall clock. */
  cursorNow?: () => number;
};

type SubjectThreadKey = { lastActivityAt: string; threadId: string };
type Candidate = SubjectThreadKey;
type CandidatePage = { candidates: readonly Candidate[]; anchor: AnchoredPosition };

const PAGE_LIMIT = 20;
const SCAN_FACTOR = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.toISOString().slice(0, 19) === value.slice(0, 19);
}

function binding(subjectId: string, input: SubjectThreadPageInput, actor: Actor): CursorBinding {
  return {
    operation: 'subject.threads.list',
    parameters: {
      subjectId,
      placeId: input.place,
      kind: input.kind,
      viewer: actor.kind === 'account' ? actor.accountId : null,
    },
  };
}

function decodeKey(ring: KeyRing, scope: CursorBinding, token: string, epoch: number, now: number): SubjectThreadKey {
  const decoded = decodeCursor(ring, scope, token, now);
  const threadId = decoded.ok && decoded.after.length === 2 ? decoded.after[1] : undefined;
  const lastActivityAt = decoded.ok && decoded.after.length === 2 ? decoded.after[0] : undefined;
  if (
    !decoded.ok ||
    decoded.epoch !== epoch ||
    !timestamp(lastActivityAt) ||
    typeof threadId !== 'string' ||
    !UUID.test(threadId) ||
    routeOf(threadId) === null
  )
    throw new TypeError('Invalid content cursor');
  return { lastActivityAt, threadId };
}

async function pageCandidates(
  dependencies: SubjectThreadDependencies,
  subjectId: string,
  input: SubjectThreadPageInput,
  context: ReadContext,
  limit: number,
  scope: CursorBinding,
  now: number,
): Promise<CandidatePage> {
  const route = routeOf(subjectId);
  if (route === null) throw new ContentNotFoundError();
  const subject: AccessCheck = await accessCheck(
    dependencies.access,
    context.actor,
    'subject:read',
    { route, id: subjectId, eligibility: subjectReadEligibility({ route, id: subjectId }) },
    { pool: dependencies.pool, deadline: context.deadline },
  );

  return within(context.deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout = '3000ms'");
        const partition = await readPartition(client, partitionOf(route));
        if (!partition) throw new CommandUnavailableError('deadline', partitionOf(route));
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionOf(route), partition.movedTo);
        if (!(await subject(client))) throw new ContentNotFoundError();

        const after =
          input.cursor === undefined ? null : decodeKey(dependencies.tokens, scope, input.cursor, partition.epoch, now);
        const parameters = {
          route,
          subject_id: subjectId,
          place_id: input.place,
          kind: input.kind,
          has_after: after !== null,
          after_at: after?.lastActivityAt ?? '-infinity',
          after_thread_id: after?.threadId ?? '00000000-0000-0000-0000-000000000000',
          limit,
        };
        const rows = await client.query<(typeof page)['~reylo']['element']>(
          page.sql,
          page.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        await client.query('COMMIT');
        return {
          candidates: rows.rows.map((row) => ({ threadId: row.thread_id, lastActivityAt: row.last_activity_at! })),
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
}

/** Pages a bounded subject/place/kind index range and discloses every candidate before returning it. */
export async function listSubjectThreads(
  dependencies: SubjectThreadDependencies,
  subjectId: string,
  context: ReadContext,
  input: SubjectThreadPageInput,
): Promise<SubjectThreadPage> {
  const subjectRoute = routeOf(subjectId);
  const placeRoute = routeOf(input.place);
  const limit = input.limit ?? PAGE_LIMIT;
  if (subjectRoute === null || placeRoute === null) throw new ContentNotFoundError();
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) throw new RangeError('Page limit must be 1 to 20');
  if (input.kind !== 'discussion' && input.kind !== 'review') throw new TypeError('Invalid subject thread kind');

  const now = (dependencies.cursorNow ?? Date.now)();
  if (!Number.isSafeInteger(now)) throw new TypeError('Invalid content cursor');
  const scope = binding(subjectId, input, context.actor);
  const pageContext = await prepareSubjectThreadContext(dependencies, subjectId, input.place, input.kind, context);
  const candidates = await pageCandidates(dependencies, subjectId, input, context, limit * SCAN_FACTOR, scope, now);
  const entries: ThreadView[] = [];
  const anchors: AnchoredPosition[] = [candidates.anchor];
  let scanned = 0;
  let lastScanned: Candidate | null = null;
  while (scanned < candidates.candidates.length && entries.length < limit) {
    const candidate = candidates.candidates[scanned]!;
    scanned++;
    lastScanned = candidate;
    const result = await readSubjectThread(dependencies, candidate.threadId, subjectId, input.place, context);
    anchors.push(result.anchor);
    if (result.value) entries.push(result.value);
  }

  const hasMore = scanned < candidates.candidates.length || candidates.candidates.length === limit * SCAN_FACTOR;
  return {
    context: await pageContext.finish(),
    entries,
    anchor: candidates.anchor,
    anchors,
    nextCursor:
      hasMore && lastScanned
        ? encodeCursor(
            dependencies.tokens,
            scope,
            { epoch: candidates.anchor.epoch, after: [lastScanned.lastActivityAt, lastScanned.threadId] },
            now,
          )
        : null,
  };
}
