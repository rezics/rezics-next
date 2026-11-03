import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  releaseOperationalTime,
  type AuthoritativeTime,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { type Access, type AccountActor, type Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding, type CursorKey } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, requireRoute, sameAccountRoute } from './command-support.ts';
import {
  changeIntent,
  nextUnitCount,
  parseRecord,
  parseSessionCreate,
  transition,
  type ProgressAction,
  type ProgressOutcome,
} from './progress.ts';
import type { ProgressPresentation, ProgressSession, ProgressSessionUpdate } from './progress-model.ts';
import * as store from './progress-store.ts';
import { readLibraryProfileSource } from './profile-source.ts';
import {
  compatibleProgressUnits,
  nativeProgressUnit,
  resolveLibraryProfilePin,
  type LibraryProfileDescriptor,
} from './profile.ts';
import { readRelease } from '../semantic/definitions.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { WORK_STEP_DEADLINE_MS } from './command-support.ts';
import { createShelfHeads, createProgressActivity } from './shelf-heads.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { prepareProgressPresentation } from './progress-presentation.ts';
import sessionLock from './session-lock.sql';
import { clearProgressValues, isProgressClear } from './progress-commands.ts';
import { enterShelfWrite } from './shelf-counter-owner.ts';

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock };
type Page = { limit?: number; cursor?: string };
type Client = CommandTransaction;

export class ProgressInvalidError extends Error {
  constructor(readonly field: string) {
    super(`Invalid progress field: ${field}`);
    this.name = 'ProgressInvalidError';
  }
}

export class ProgressConflictError extends Error {
  constructor() {
    super('Progress revision conflicts');
    this.name = 'ProgressConflictError';
  }
}

function valid<T>(result: ProgressOutcome<T>): T {
  if (!result.ok) throw new ProgressInvalidError(result.field);
  return result.value;
}

function account(actor: Actor, action: string): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null || !actor.scopes.includes(action)) {
    throw new GrantDeniedError();
  }
  return actor;
}

function revisionInput(input: unknown): { revision: number; record: Record<string, unknown> } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ProgressInvalidError('revision');
  const { revision, ...record } = input as Record<string, unknown>;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || revision >= 2_147_483_647) {
    throw new ProgressInvalidError('revision');
  }
  return { revision, record };
}

function event(session: ProgressSession) {
  return {
    type: 'com.rezics.library.progress_session.updated.v1',
    subject: session.accountId,
    data: { sessionId: session.id },
  };
}

/** Private progress commands and snapshot/keyset reads on the owning account's partition. */
export function createSessionCommands(config: Dependencies) {
  const { pool, access, tokens, clock } = config;
  const runner = createLibraryCommandRunner({ pool, ...(clock === undefined ? {} : { clock }) });

  const heads = createShelfHeads();
  const activity = createProgressActivity();

  function descriptor(profile: LibraryProfileDescriptor, session: Pick<ProgressSession, 'mode' | 'unit'>) {
    const unit = nativeProgressUnit(profile, session);
    if (!unit) throw new ProblemError('unsupported_library_profile');
    return unit;
  }

  async function admit(client: Client, owner: AccountActor): Promise<void> {
    const current = await readAccount(client, requireRoute(owner.accountId), owner.accountId);
    if (
      !current ||
      current.kind !== 'actor' ||
      current.state !== 'active' ||
      current.fenced ||
      !Number.isSafeInteger(owner.authnEpoch) ||
      owner.authnEpoch < 1 ||
      current.minimumAuthnEpoch > BigInt(owner.authnEpoch)
    ) {
      throw new GrantDeniedError();
    }
  }

  async function load(client: Client, owner: AccountActor, sessionId: string): Promise<ProgressSession> {
    const route = sameAccountRoute(owner.accountId, sessionId);
    const session = await store.readSession(client, route, sessionId);
    if (!session || session.accountId !== owner.accountId) throw new LibraryNotFoundError();
    return session;
  }

  async function startSession(actor: Actor, input: unknown, requestKey: string) {
    const owner = account(actor, 'progress_session:create');
    // Syntax normalization is the existing receipt input; trusted metadata never enters its digest.
    const parsed = valid(parseSessionCreate(input, 'syntax'));
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    return runner.ownAccountPrepared(
      actor,
      {
        action: 'progress_session:create',
        kind: 'progress_session.start',
        requestKey,
        input: parsed,
        async prepare(attempt) {
          try {
            const deps = { pool, access, actor: owner, at: attempt.time, deadline };
            const source = await readLibraryProfileSource(deps, parsed.subjectId);
            const version =
              parsed.versionSubjectId === null
                ? null
                : parsed.versionSubjectId === parsed.subjectId
                  ? source
                  : await readLibraryProfileSource(deps, parsed.versionSubjectId);
            return { source, version };
          } catch (error) {
            return { error };
          }
        },
      },
      async (tx, command, prepared) => {
        if ('error' in prepared) throw prepared.error;
        const { source, version } = prepared;
        if (!source || (parsed.versionSubjectId !== null && !version)) throw new LibraryNotFoundError();
        if (source.kind !== 'supported') throw new ProblemError('unsupported_library_profile');
        valid(parseSessionCreate(parsed, descriptor(source.profile, parsed)));
        const route = requireRoute(owner.accountId);
        const write = { client: tx, route, accountId: owner.accountId };
        await enterShelfWrite(write);
        await heads.ensure(write, source.subjectId);
        const time = authoritativeTimeValue(command.time);
        const session = await store.insertSession(
          tx,
          route,
          {
            ...parsed,
            subjectId: source.subjectId,
            versionSubjectId: version?.subjectId ?? null,
            id: newId(route),
            accountId: owner.accountId,
          },
          { transactionId: command.transactionId, time },
          source.pin,
        );
        await activity.touch(write, { subjectId: session.subjectId, time, completed: false });
        return { value: session, events: [event(session)] };
      },
    );
  }

  async function update(
    actor: Actor,
    sessionId: string,
    input: unknown,
    requestKey: string,
    action: ProgressAction | 'record',
  ) {
    const owner = account(actor, 'progress_session:update');
    const route = sameAccountRoute(owner.accountId, sessionId);
    const { revision, record } = revisionInput(input);
    if (action !== 'record' && Object.keys(record).length)
      throw new ProgressInvalidError(Object.keys(record).sort()[0]!);
    const clearing = action === 'record' && isProgressClear(record);
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    return runner.ownAccountPrepared(
      actor,
      {
        action: 'progress_session:update',
        kind: `progress_session.${action}`,
        requestKey,
        input: { sessionId, revision, ...record },
        async prepare(attempt) {
          try {
            if (action !== 'record' || clearing) return { original: null, source: null, pin: null };
            // Release the owner snapshot before any source or Global connection is acquired.
            const fact = await withConnection(pool, async (client) => {
              await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
              try {
                await admit(client, owner);
                const value = await store.readSessionFact(client, route, sessionId);
                await client.query('COMMIT');
                return value;
              } catch (error) {
                await client.query('ROLLBACK');
                throw error;
              }
            });
            if (!fact || fact.session.accountId !== owner.accountId) throw new LibraryNotFoundError();
            if (fact.pin === null) throw new ProblemError('unsupported_library_profile');
            const release = await readRelease(pool, fact.pin.releaseDigest, { composed: false });
            const original = release && resolveLibraryProfilePin({ digest: fact.pin.releaseDigest, release }, fact.pin);
            if (!original) throw new ProblemError('unsupported_library_profile');
            const source = await readLibraryProfileSource(
              { pool, access, actor: owner, at: attempt.time, deadline },
              fact.session.subjectId,
            );
            return { original, source, pin: fact.pin };
          } catch (error) {
            return { error };
          }
        },
      },
      async (tx, command, prepared) => {
        if ('error' in prepared) throw prepared.error;
        const observed = await load(tx, owner, sessionId);
        const write = { client: tx, route, accountId: owner.accountId };
        // Every session writer orders the shared subject head before the session point lock.
        await enterShelfWrite(write);
        await heads.ensure(write, observed.subjectId);
        await sessionLock.run(tx, { route, session_id: sessionId });
        const fact = await store.readSessionFact(tx, route, sessionId);
        if (!fact || fact.session.accountId !== owner.accountId) throw new LibraryNotFoundError();
        const current = fact.session;
        // A concurrent NULL-pin migration cannot let prepared legacy meaning admit a pinned value.
        if (action === 'record' && !clearing && JSON.stringify(fact.pin) !== JSON.stringify(prepared.pin))
          throw new ProgressConflictError();
        if (current.revision !== revision) throw new ProgressConflictError();
        const context = { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) };
        const changes: ProgressSessionUpdate = { ...current };
        let intent: unknown;
        if (clearing) {
          Object.assign(changes, await clearProgressValues(tx, route, current));
          intent = { clear: true };
        } else if (action === 'record') {
          const parsed = valid(
            parseRecord(
              current.mode,
              record,
              current,
              prepared.original ? descriptor(prepared.original, current) : undefined,
            ),
          );
          if (prepared.original) {
            const source = prepared.source;
            if (!source) throw new LibraryNotFoundError();
            if (source.kind !== 'supported') throw new ProblemError('unsupported_library_profile');
            const originalUnit = descriptor(prepared.original, current);
            const currentUnit = descriptor(source.profile, current);
            if (!compatibleProgressUnits(originalUnit, currentUnit))
              throw new ProblemError('unsupported_library_profile');
            const admitted = parseRecord(current.mode, record, current, currentUnit);
            if (!admitted.ok) throw new ProblemError('unsupported_library_profile');
          }
          intent = changeIntent(parsed);
          if ('amount' in parsed) changes.amount = parsed.amount;
          else if ('locator' in parsed) {
            changes.locator = parsed.locator;
            changes.position = parsed.position;
          } else {
            const removed = 'remove' in parsed ? await store.removeUnits(tx, route, sessionId, parsed.remove) : 0;
            const added = 'add' in parsed ? await store.addUnits(tx, route, sessionId, parsed.add, context) : 0;
            changes.completedUnitCount = valid(nextUnitCount(current.completedUnitCount, added, removed));
          }
        } else {
          changes.state = valid(transition(current.state, action));
          changes.completedAt = action === 'complete' ? context.time : null;
        }
        const session = await store.updateSession(tx, route, sessionId, revision, changes, context);
        if (!session) throw new ProgressConflictError();
        if (action === 'record') await store.appendChange(tx, route, sessionId, session.revision, intent, context);
        await activity.touch(write, {
          subjectId: session.subjectId,
          time: context.time,
          completed: action === 'complete',
        });
        return { value: session, events: [event(session)] };
      },
    );
  }

  const recordProgress = (actor: Actor, sessionId: string, input: unknown, requestKey: string) =>
    update(actor, sessionId, input, requestKey, 'record');
  const completeSession = (actor: Actor, sessionId: string, input: unknown, requestKey: string) =>
    update(actor, sessionId, input, requestKey, 'complete');
  const abandonSession = (actor: Actor, sessionId: string, input: unknown, requestKey: string) =>
    update(actor, sessionId, input, requestKey, 'abandon');

  async function snapshot<T>(
    actor: Actor,
    action: string,
    body: (client: Client, owner: AccountActor) => Promise<T>,
  ): Promise<T> {
    const owner = account(actor, action);
    return withConnection(pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await admit(client, owner);
        const result = await body(client, owner);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  const readSession = (actor: Actor, sessionId: string) =>
    snapshot(actor, 'progress_session:read', (client, owner) => load(client, owner, sessionId));

  /** Presentation owns no stored state. Rendering runs between released reads and final native checks. */
  async function readPresentedSession<T>(
    actor: Actor,
    sessionId: string,
    render: (
      session: ProgressSession,
      presentation: ProgressPresentation,
      disclosure: { subject: boolean; versionSubject: boolean },
    ) => Promise<T>,
  ): Promise<T> {
    const owner = account(actor, 'progress_session:read');
    const route = sameAccountRoute(owner.accountId, sessionId);
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    return withRequestDeadline(deadline, () =>
      within(deadline, async () => {
        async function time() {
          return withConnection(pool, (client) => mintReadTime(deadlineClient(client, deadline), clock));
        }
        async function observed(at: AuthoritativeTime) {
          // Use the same private owner authority as readSession: client scope,
          // current native account, and the occurrence's exact owning account.
          return snapshot(owner, 'progress_session:read', async (client) => {
            const bounded = deadlineClient(client, deadline);
            const partition = await readPartition(bounded, partitionOf(route));
            if (!partition || partition.writeState !== 'active' || partition.movedTo !== null)
              throw new ProblemError('partition_unavailable');
            const fact = await store.readSessionFact(bounded, route, sessionId);
            if (!fact || fact.session.accountId !== owner.accountId) throw new LibraryNotFoundError();
            return { fact, epoch: partition.epoch };
          });
        }
        const at = await time();
        try {
          const before = await observed(at);
          const prepared = await prepareProgressPresentation({ pool, access, actor: owner, at, deadline }, before.fact);
          const result = await render(before.fact.session, prepared.presentation, prepared.disclosure);
          const finalTime = await time();
          try {
            await prepared.verify(finalTime);
            const after = await observed(finalTime);
            if (before.epoch !== after.epoch || JSON.stringify(before.fact) !== JSON.stringify(after.fact))
              throw new ProgressConflictError();
          } finally {
            releaseOperationalTime(finalTime);
          }
          return result;
        } finally {
          releaseOperationalTime(at);
        }
      }),
    );
  }

  async function page<T>(
    client: Client,
    owner: AccountActor,
    options: Page,
    operation: string,
    parameters: Record<string, string>,
    validAfter: (keys: CursorKey[]) => boolean,
    fetch: (after: CursorKey[] | null, limit: number) => Promise<T[]>,
    keyOf: (row: T) => CursorKey[],
  ) {
    const size = options.limit ?? 20;
    if (!Number.isInteger(size) || size < 1 || size > 100) throw new ProgressInvalidError('limit');
    const binding: CursorBinding = { operation, parameters: { accountId: owner.accountId, ...parameters } };
    const partition = await readPartition(client, partitionOf(requireRoute(owner.accountId)));
    let after: CursorKey[] | null = null;
    if (options.cursor !== undefined) {
      const cursor = decodeCursor(tokens, binding, options.cursor);
      if (!cursor.ok || !validAfter(cursor.after)) throw new ProblemError('invalid_cursor');
      if (cursor.epoch !== partition?.epoch) throw new ProblemError('stale_cursor');
      after = cursor.after;
    }
    const rows = await fetch(after, Math.min(100, size + 1));
    const shown = rows.slice(0, size);
    const last = shown.at(-1);
    const more = rows.length > size || (size === 100 && last !== undefined && (await fetch(keyOf(last), 1)).length > 0);
    return {
      rows: shown,
      next:
        more && last !== undefined && partition
          ? encodeCursor(tokens, binding, { epoch: partition.epoch, after: keyOf(last) })
          : null,
    };
  }

  async function listSessions(actor: Actor, subjectId: string, options: Page = {}) {
    requireRoute(subjectId);
    return snapshot(actor, 'progress_session:list', async (client, owner) => {
      const result = await page(
        client,
        owner,
        options,
        'progress_session.list',
        { subjectId },
        (keys) =>
          keys.length === 2 &&
          typeof keys[0] === 'string' &&
          Number.isFinite(Date.parse(keys[0])) &&
          typeof keys[1] === 'string' &&
          routeOf(keys[1]) === routeOf(owner.accountId),
        (after, limit) =>
          store.pageSessions(client, requireRoute(owner.accountId), owner.accountId, subjectId, {
            after: after ? { startedAt: after[0] as string, sessionId: after[1] as string } : null,
            limit,
          }),
        (row) => [row.startedAt, row.id],
      );
      return { sessions: result.rows, next: result.next };
    });
  }

  async function listUnits(actor: Actor, sessionId: string, options: Page = {}) {
    return snapshot(actor, 'progress_session:read', async (client, owner) => {
      const session = await load(client, owner, sessionId);
      const result = await page(
        client,
        owner,
        options,
        'progress_session.units',
        { sessionId },
        (keys) => keys.length === 1 && typeof keys[0] === 'string' && keys[0].length > 0 && keys[0].length <= 128,
        (after, limit) =>
          store.pageUnits(client, requireRoute(owner.accountId), session.id, {
            after: after ? { unitId: after[0] as string } : null,
            limit,
          }),
        (row) => [row.unitId],
      );
      return { units: result.rows, next: result.next };
    });
  }

  async function listChanges(actor: Actor, sessionId: string, options: Page = {}) {
    return snapshot(actor, 'progress_session:read', async (client, owner) => {
      const session = await load(client, owner, sessionId);
      const result = await page(
        client,
        owner,
        options,
        'progress_session.changes',
        { sessionId },
        (keys) =>
          keys.length === 1 &&
          typeof keys[0] === 'number' &&
          Number.isSafeInteger(keys[0]) &&
          keys[0] > 0 &&
          keys[0] <= 2_147_483_647,
        (after, limit) =>
          store.pageChanges(client, requireRoute(owner.accountId), session.id, {
            after: after ? { changeNo: after[0] as number } : null,
            limit,
          }),
        (row) => [row.changeNo],
      );
      return { changes: result.rows, next: result.next };
    });
  }

  return {
    startSession,
    recordProgress,
    completeSession,
    abandonSession,
    readSession,
    readPresentedSession,
    listSessions,
    listUnits,
    listChanges,
  };
}
