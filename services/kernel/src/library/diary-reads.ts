import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { admitGroup } from '../access/gates/admission.ts';
import type { KernelClock } from '../clock.ts';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { AuthenticationError, type Access, type AccountActor, type Actor } from '../request/access.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readSubjectSummaries, type SubjectSummary } from '../semantic/summaries.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { DIARY_LIMIT, DIARY_PAYLOAD_BYTES, type DiaryPage, type DiarySubject } from './diary-model.ts';
import {
  cancelDiaryNavigation,
  createDiaryNavigation,
  diaryRows,
  readDiaryNavigation,
  type DiaryKey,
  type DiaryNavigation,
} from './diary-store.ts';

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; clock: KernelClock; routeKey: Uint8Array };
type Client = Pick<PoolClient, 'query'>;
type PageOptions = { limit?: number; cursor?: string };

function ownerOf(actor: Actor): AccountActor {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (routeOf(actor.accountId) === null || !actor.scopes.includes('progress_session:list'))
    throw new ProblemError('forbidden');
  return actor;
}

/** Do not retain credentials or permissions. A changed caller must start again with current authority. */
function callerOf(owner: AccountActor): string {
  return createHash('sha256')
    .update(JSON.stringify([owner.clientId, owner.requestedBy, owner.authnEpoch, [...new Set(owner.scopes)].sort()]))
    .digest('hex');
}

/** UTF-8 bounded display strings; never return a partial surrogate or a byte-fragment replacement. */
function bounded(value: string, bytes: number): string {
  let result = '';
  let length = 0;
  for (const point of value) {
    length += Buffer.byteLength(point);
    if (length > bytes) break;
    result += point;
  }
  return result;
}

function subjectView(value: SubjectSummary | null | undefined): DiarySubject | null {
  return value
    ? {
        id: value.id,
        label: value.label ? bounded(value.label.value, 256) : null,
        language: value.label ? bounded(value.label.language, 64) : null,
      }
    : null;
}

function sizeOf(options: PageOptions): number {
  const size = options.limit ?? 20;
  if (!Number.isInteger(size) || size < 1 || size > DIARY_LIMIT) throw new ProblemError('invalid_request');
  return size;
}

/** Owner-only indexed occurrence reader. No subject enumeration, copied facts or per-row owner reads. */
export function createDiaryReads(deps: Dependencies) {
  const { pool, access, clock, tokens } = deps;

  function binding(owner: AccountActor): CursorBinding {
    return { operation: 'library.diary', parameters: { accountId: owner.accountId, caller: callerOf(owner) } };
  }

  function decode(owner: AccountActor, token: string, now: Date, limit?: number) {
    if (token.length === 0 || token.length > 2048) throw new ProblemError('invalid_cursor');
    const decoded = decodeCursor(tokens, binding(owner), token, now.getTime());
    if (!decoded.ok) throw new ProblemError(decoded.reason === 'expired' ? 'stale_cursor' : 'invalid_cursor');
    const [id, size, time, sessionId] = decoded.after;
    if (
      (decoded.after.length !== 2 && decoded.after.length !== 4) ||
      typeof id !== 'string' ||
      routeOf(id) !== routeOf(owner.accountId) ||
      typeof size !== 'number' ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > DIARY_LIMIT ||
      (limit !== undefined && (size !== limit || decoded.after.length !== 4)) ||
      (decoded.after.length === 4 &&
        (typeof time !== 'string' ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(time) ||
          !Number.isFinite(Date.parse(time)) ||
          typeof sessionId !== 'string' ||
          routeOf(sessionId) !== routeOf(owner.accountId)))
    )
      throw new ProblemError('invalid_cursor');
    return {
      id,
      epoch: decoded.epoch,
      after: decoded.after.length === 4 ? { recordedStartedAt: time as string, id: sessionId as string } : null,
    };
  }

  /** The authenticated owner and client scope select this private partition, as for Continue. */
  async function snapshot<T>(
    owner: AccountActor,
    deadline: number,
    body: (client: Client, epoch: number, now: Date) => Promise<T>,
  ) {
    const at = await withConnection(pool, (client) => mintReadTime(deadlineClient(client, deadline), clock));
    try {
      const route = routeOf(owner.accountId)!;
      return await withConnection(pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        await client.query('BEGIN');
        try {
          // Serializes slot allocation and prevents terminal erasure from racing a retained navigation write.
          await client.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE', [
            route,
            owner.accountId,
          ]);
          const account = await readAccount(client, route, owner.accountId);
          if (
            !account ||
            account.kind !== 'actor' ||
            account.state !== 'active' ||
            account.fenced ||
            !Number.isSafeInteger(owner.authnEpoch) ||
            owner.authnEpoch < 1 ||
            account.minimumAuthnEpoch > BigInt(owner.authnEpoch)
          )
            throw new ProblemError('forbidden');
          const partition = await readPartition(client, partitionOf(route));
          if (!partition || partition.writeState !== 'active' || partition.movedTo !== null)
            throw new ProblemError('partition_unavailable');
          const result = await body(client, partition.epoch, new Date(authoritativeTimeValue(at)));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    } finally {
      releaseOperationalTime(at);
    }
  }

  async function currentNavigation(
    client: Client,
    owner: AccountActor,
    id: string,
    epoch: number,
    now: Date,
  ): Promise<DiaryNavigation> {
    const value = await readDiaryNavigation(client, routeOf(owner.accountId)!, owner.accountId, id, callerOf(owner));
    if (!value || value.epoch !== epoch || Date.parse(value.expiresAt) <= now.getTime())
      throw new ProblemError('stale_cursor');
    return value;
  }

  return {
    async list(actor: Actor, options: PageOptions, deadline: number): Promise<DiaryPage> {
      const owner = ownerOf(actor);
      const limit = sizeOf(options);
      const route = routeOf(owner.accountId)!;
      return withRequestDeadline(deadline, () =>
        within(deadline, async () => {
          await admitGroup({
            ...deps,
            access: () => access,
            actor: owner,
            group: 'reading_progress',
            clientAction: 'progress_session:list',
            deadline,
          });
          let after: DiaryKey | null = null;
          let navigation: DiaryNavigation | null = null;
          const before = await snapshot(owner, deadline, async (client, epoch, now) => {
            if (options.cursor !== undefined) {
              const decoded = decode(owner, options.cursor, now, limit);
              if (decoded.epoch !== epoch) throw new ProblemError('stale_cursor');
              navigation = await currentNavigation(client, owner, decoded.id, epoch, now);
              after = decoded.after;
            }
            return { epoch, rows: await diaryRows(client, route, owner.accountId, after, limit + 1) };
          });
          const shown = before.rows.slice(0, limit);
          const ids = [
            ...new Set(
              shown.flatMap((row) => (row.versionSubjectId ? [row.subjectId, row.versionSubjectId] : [row.subjectId])),
            ),
          ];
          // Shared native summary projection batches current disclosure, including redirects and missing subjects.
          const summaries = await readSubjectSummaries({ ...deps, actor: owner, deadline }, ids);
          const occurrences = shown.map((row) => ({
            ...row,
            subject: subjectView(summaries.get(row.subjectId)),
            versionSubject: row.versionSubjectId ? subjectView(summaries.get(row.versionSubjectId)) : null,
          }));
          const more = before.rows.length > limit;
          navigation = await snapshot(owner, deadline, async (client, epoch, now) => {
            if (epoch !== before.epoch) throw new ProblemError('stale_cursor');
            const current = await diaryRows(client, route, owner.accountId, after, limit + 1);
            if (JSON.stringify(current) !== JSON.stringify(before.rows)) throw new ProblemError('conflict');
            if (navigation) return currentNavigation(client, owner, navigation.id, epoch, now);
            return more ? createDiaryNavigation(client, route, owner.accountId, callerOf(owner), epoch, now) : null;
          });
          const last = shown.at(-1);
          const token = (keys: (string | number)[]) =>
            navigation
              ? encodeCursor(
                  tokens,
                  binding(owner),
                  {
                    epoch: navigation.epoch,
                    after: [navigation.id, limit, ...keys],
                  },
                  Date.parse(navigation.createdAt),
                )
              : null;
          const result: DiaryPage = {
            occurrences,
            order: 'recorded_started_desc_id_desc',
            next: more && last ? token([last.recordedStartedAt, last.id]) : null,
            continuation: token([]),
            expiresAt: navigation?.expiresAt ?? null,
          };
          if (Buffer.byteLength(JSON.stringify(result)) > DIARY_PAYLOAD_BYTES) throw new ProblemError('overloaded');
          return result;
        }),
      );
    },

    /** Authenticated, caller-bound and idempotent, including an already cancelled/expired navigation. */
    async cancel(actor: Actor, token: string, deadline: number): Promise<{ cancelled: true }> {
      const owner = ownerOf(actor);
      return withRequestDeadline(deadline, () =>
        within(deadline, async () => {
          await admitGroup({
            ...deps,
            access: () => access,
            actor: owner,
            group: 'reading_progress',
            clientAction: 'progress_session:list',
            deadline,
          });
          await snapshot(owner, deadline, async (client, _epoch, now) => {
            let decoded: ReturnType<typeof decode>;
            try {
              decoded = decode(owner, token, now);
            } catch (error) {
              // Expiration is already retirement; a malformed or foreign token is still invalid.
              if (error instanceof ProblemError && error.code === 'stale_cursor') return;
              throw error;
            }
            await cancelDiaryNavigation(client, routeOf(owner.accountId)!, owner.accountId, decoded.id);
          });
          return { cancelled: true };
        }),
      );
    },
  };
}
