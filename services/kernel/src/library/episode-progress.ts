import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { readAccount } from '../access/account-data.ts';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  releaseOperationalTime,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type Actor, type AccountActor } from '../request/access.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { readRelease } from '../semantic/definitions.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  createLibraryCommandRunner,
  LibraryNotFoundError,
  sameAccountRoute,
  WORK_STEP_DEADLINE_MS,
} from './command-support.ts';
import { readEpisodeSources, type EpisodeSourceDependencies } from './episode-source.ts';
import { compatibleProgressUnits, nativeProgressUnit, resolveLibraryProfilePin } from './profile.ts';
import { readLibraryProfileSource } from './profile-source.ts';
import * as store from './progress-store.ts';
import { createShelfHeads, createProgressActivity } from './shelf-heads.ts';
import { enterShelfWrite } from './shelf-counter-owner.ts';
import { ProgressConflictError, ProgressInvalidError } from './sessions.ts';
import sessionLock from './session-lock.sql';
import readCount from './episode-progress-read.sql';
import pageFacts from './episode-progress-page.sql';
import inspectFacts from './episode-progress-inspect.sql';
import writeFacts from './episode-progress-write.sql';

export const MAX_EPISODE_IDS = 20;
export type EpisodeProgressIntent = { revision: number; add: string[]; remove: string[]; clear: boolean };
export type EpisodeCompletion = {
  episodeSubjectId: string | null;
  completed: boolean | null;
  membership: 'member' | 'detached' | 'unavailable';
  ordinal: string | null;
};
export type EpisodeProgressView = { revision: number; episodes: EpisodeCompletion[]; next: string | null };
type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; routeKey: Uint8Array; clock?: KernelClock };

/** Lowercase canonical UUIDs only; ordinals and legacy sparse tokens never enter this set. */
export function episodeIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_EPISODE_IDS) throw new ProgressInvalidError('episodeSubjectIds');
  const seen = new Set<string>();
  for (const id of value) {
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ||
      routeOf(id) === null ||
      seen.has(id)
    )
      throw new ProgressInvalidError('episodeSubjectIds');
    seen.add(id);
  }
  return [...seen];
}
export function episodeIntent(input: unknown): EpisodeProgressIntent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProgressInvalidError('intent');
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !['revision', 'add', 'remove', 'clear'].includes(key)) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    (value.revision as number) >= 2_147_483_647
  )
    throw new ProgressInvalidError('revision');
  if (value.clear !== undefined) {
    if (value.clear !== true || Object.keys(value).length !== 2) throw new ProgressInvalidError('clear');
    return { revision: value.revision as number, add: [], remove: [], clear: true };
  }
  const add = episodeIds(value.add === undefined ? [] : value.add),
    remove = episodeIds(value.remove === undefined ? [] : value.remove);
  if (
    add.length + remove.length < 1 ||
    add.length + remove.length > MAX_EPISODE_IDS ||
    add.some((id) => remove.includes(id))
  )
    throw new ProgressInvalidError('episodeSubjectIds');
  return { revision: value.revision as number, add, remove, clear: false };
}
function ownerOf(actor: Actor, action: string): AccountActor {
  if (actor.kind !== 'account' || !actor.scopes.includes(action) || routeOf(actor.accountId) === null)
    throw new GrantDeniedError();
  return actor;
}

/** Canonical completion is orthogonal to the existing session's scalar/cursor/manual value. */
export function createEpisodeProgressCommands(config: Dependencies) {
  const { pool, access, tokens, clock, routeKey } = config;
  const runner = createLibraryCommandRunner({ pool, access, ...(clock ? { clock } : {}) });
  const heads = createShelfHeads(),
    activity = createProgressActivity();
  async function load(client: Pick<CommandTransaction, 'query'>, owner: AccountActor, sessionId: string) {
    const route = sameAccountRoute(owner.accountId, sessionId);
    const fact = await store.readSessionFact(client, route, sessionId);
    if (!fact || fact.session.accountId !== owner.accountId) throw new LibraryNotFoundError();
    return fact;
  }
  async function snapshot<T>(
    owner: AccountActor,
    sessionId: string,
    body: (client: CommandTransaction, fact: Awaited<ReturnType<typeof load>>) => Promise<T>,
  ) {
    const route = sameAccountRoute(owner.accountId, sessionId);
    return withConnection(pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const current = await readAccount(client, route, owner.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(owner.authnEpoch) ||
          owner.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(owner.authnEpoch)
        )
          throw new GrantDeniedError();
        const result = await body(client, await load(client, owner, sessionId));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async function recordEpisodes(actor: Actor, sessionId: string, input: unknown, requestKey: string) {
    const owner = ownerOf(actor, 'progress_session:update');
    const route = sameAccountRoute(owner.accountId, sessionId),
      intent = episodeIntent(input);
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    return runner.ownAccountPrepared(
      owner,
      {
        action: 'progress_session:update',
        kind: 'progress_session.record_episodes',
        requestKey,
        input: { sessionId, ...intent },
        async prepare(attempt) {
          try {
            // Correction/clear requires no current catalogue/profile permission to add a value.
            if (!intent.add.length) return { pin: null };
            const fact = await snapshot(owner, sessionId, async (_client, value) => value);
            if (!fact.pin || fact.session.unit !== 'episode') throw new ProblemError('unsupported_library_profile');
            const release = await readRelease(pool, fact.pin.releaseDigest, { composed: false });
            const profile = release && resolveLibraryProfilePin({ digest: fact.pin.releaseDigest, release }, fact.pin);
            const original = profile && nativeProgressUnit(profile, fact.session);
            const deps = { pool, access, actor: owner, at: attempt.time, deadline, routeKey };
            const source = await readLibraryProfileSource(deps, fact.session.subjectId);
            const current = source?.kind === 'supported' ? nativeProgressUnit(source.profile, fact.session) : null;
            if (!original || !current || !compatibleProgressUnits(original, current))
              throw new ProblemError('unsupported_library_profile');
            if (source?.subjectId !== fact.session.subjectId) throw new LibraryNotFoundError();
            const episodes = await readEpisodeSources(deps, fact.session.subjectId, intent.add);
            if (episodes.some((episode) => !episode || episode.membership !== 'member'))
              throw new LibraryNotFoundError();
            return { pin: fact.pin };
          } catch (error) {
            return { error };
          }
        },
      },
      async (tx, command, prepared) => {
        if ('error' in prepared) throw prepared.error;
        const observed = await load(tx, owner, sessionId);
        const write = { client: tx, route, accountId: owner.accountId };
        await enterShelfWrite(write);
        await heads.ensure(write, observed.session.subjectId);
        await sessionLock.run(tx, { route, session_id: sessionId });
        const fact = await load(tx, owner, sessionId),
          current = fact.session;
        if (
          current.revision !== intent.revision ||
          (intent.add.length && JSON.stringify(fact.pin) !== JSON.stringify(prepared.pin))
        )
          throw new ProgressConflictError();
        const context = { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) };
        // Exact key probes and one retained bounded counter; no owner-wide count or catalogue snapshot.
        const existing = await inspectFacts.run(tx, {
          route,
          session_id: sessionId,
          ids: [...intent.add, ...intent.remove],
        });
        const present = new Set(existing.map((row) => row.id));
        const count = await readCount.run(tx, { route, session_id: sessionId });
        const next = intent.clear
          ? 0
          : (count?.count ?? 0) +
            intent.add.filter((id) => !present.has(id)).length -
            intent.remove.filter((id) => present.has(id)).length;
        if (next > 20_000) throw new ProgressInvalidError('episodeSubjectIds');
        await writeFacts.run(tx, {
          route,
          session_id: sessionId,
          add: intent.add,
          remove: intent.remove,
          clear: intent.clear,
          time: context.time,
        });
        const session = await store.updateSession(tx, route, sessionId, intent.revision, current, context);
        if (!session) throw new ProgressConflictError();
        await activity.touch(write, { subjectId: session.subjectId, time: context.time, completed: false });
        return {
          value: { revision: session.revision },
          events: [
            {
              type: 'com.rezics.library.progress_session.updated.v1',
              subject: owner.accountId,
              data: { sessionId },
            },
          ],
        };
      },
    );
  }

  /** A supplied catalogue page, or a bounded retained-fact page with concealed rows redacted. */
  async function readEpisodes(
    actor: Actor,
    sessionId: string,
    options: { ids?: string[]; cursor?: string; limit?: number } = {},
  ): Promise<EpisodeProgressView> {
    const owner = ownerOf(actor, 'progress_session:read');
    const route = sameAccountRoute(owner.accountId, sessionId);
    const ids = options.ids === undefined ? undefined : episodeIds(options.ids);
    const limit = options.limit ?? MAX_EPISODE_IDS;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EPISODE_IDS || (ids && options.cursor !== undefined))
      throw new ProgressInvalidError('limit');
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    return withRequestDeadline(deadline, async () => {
      const at = await withConnection(pool, (client) => mintReadTime(client, clock));
      try {
        const check = await accessCheck(
          access,
          owner,
          'progress_session:read',
          { route, id: owner.accountId },
          { pool, deadline, time: at },
        );
        const binding: CursorBinding = {
          operation: 'progress_session.episodes',
          parameters: { accountId: owner.accountId, sessionId },
        };
        const before = await snapshot(owner, sessionId, async (client, fact) => {
          if (!(await check(client, at))) throw new GrantDeniedError();
          const partition = await readPartition(client, partitionOf(route));
          if (!partition) throw new LibraryNotFoundError();
          let after: string | null = null;
          if (options.cursor !== undefined) {
            const decoded = decodeCursor(tokens, binding, options.cursor);
            if (
              !decoded.ok ||
              decoded.after.length !== 2 ||
              typeof decoded.after[0] !== 'string' ||
              typeof decoded.after[1] !== 'number'
            )
              throw new ProblemError('invalid_cursor');
            after = episodeIds([decoded.after[0]])[0]!;
            if (decoded.epoch !== partition.epoch || decoded.after[1] !== fact.session.revision)
              throw new ProblemError('stale_cursor');
          }
          const rows =
            ids === undefined
              ? await pageFacts.run(client, { route, session_id: sessionId, after, limit: limit + 1 })
              : await inspectFacts.run(client, { route, session_id: sessionId, ids });
          return { fact, rows, epoch: partition.epoch };
        });
        const raw = ids ?? before.rows.slice(0, limit).map((row) => row.id);
        const present = new Set(before.rows.map((row) => row.id));
        const deps: EpisodeSourceDependencies = { pool, access, actor: owner, at, deadline, routeKey };
        const episodes: EpisodeCompletion[] = [];
        const sources = await readEpisodeSources(deps, before.fact.session.subjectId, raw);
        for (const [index, id] of raw.entries()) {
          const source = sources[index];
          episodes.push(
            source
              ? {
                  episodeSubjectId: id,
                  completed: present.has(id),
                  membership: source.membership,
                  ordinal: source.ordinal,
                }
              : { episodeSubjectId: null, completed: null, membership: 'unavailable', ordinal: null },
          );
        }
        // Refresh authoritative time and Access after foreign reads, before disclosing identities.
        const finalTime = await withConnection(pool, (client) => mintReadTime(client, clock));
        try {
          const finalDeps = { ...deps, at: finalTime };
          const disclosed = episodes.filter((shown) => shown.episodeSubjectId !== null);
          const currentSources = await readEpisodeSources(
            finalDeps,
            before.fact.session.subjectId,
            disclosed.map((shown) => shown.episodeSubjectId!),
          );
          for (const [index, shown] of disclosed.entries()) {
            const source = currentSources[index];
            if (!source || source.membership !== shown.membership || source.ordinal !== shown.ordinal)
              throw new ProblemError('semantic_not_ready');
          }
          const finalCheck = await accessCheck(
            access,
            owner,
            'progress_session:read',
            { route, id: owner.accountId },
            { pool, deadline, time: finalTime },
          );
          await snapshot(owner, sessionId, async (client, fact) => {
            if (!(await finalCheck(client, finalTime))) throw new GrantDeniedError();
            const partition = await readPartition(client, partitionOf(route));
            if (fact.session.revision !== before.fact.session.revision || partition?.epoch !== before.epoch)
              throw new ProgressConflictError();
          });
        } finally {
          releaseOperationalTime(finalTime);
        }
        const last = raw.at(-1);
        return {
          revision: before.fact.session.revision,
          episodes,
          next:
            ids === undefined && before.rows.length > limit && last
              ? encodeCursor(tokens, binding, { epoch: before.epoch, after: [last, before.fact.session.revision] })
              : null,
        };
      } finally {
        releaseOperationalTime(at);
      }
    });
  }
  return { recordEpisodes, readEpisodes };
}
