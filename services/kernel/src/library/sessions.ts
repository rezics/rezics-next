import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  noEffect,
  releaseOperationalTime,
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
  correctOccurrence,
  nextUnitCount,
  parseRecord,
  parseProgressMeasureCreate,
  parseSessionCreate,
  transition,
  type ProgressAction,
  type ProgressOutcome,
} from './progress.ts';
import type {
  ProgressMeasurePresentation,
  ProgressPresentation,
  ProgressSession,
  ProgressSessionJournalDate,
  ProgressSessionUpdate,
} from './progress-model.ts';
import * as store from './progress-store.ts';
import { readLibraryProfileSource, readLibraryProfileSourceObservation } from './profile-source.ts';
import type { LibraryProfilePin } from './profile.ts';
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
import { parseProgressSessionJournalPatch } from './progress-journal.ts';

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock };
type Page = { limit?: number; cursor?: string };
type Client = CommandTransaction;
export type ProgressSessionJournalAdmission = {
  identity: unknown;
  assert: (tx: CommandTransaction) => Promise<void>;
};
type ExpectedProgressBinding = {
  subjectId: string;
  requestedSubjectId: string | null;
  acceptingType: string;
  identityEpoch: string;
  component: { partition: number; epoch: number; position: string };
  profilePin: Extract<LibraryProfilePin, { provenance: 'profile' }>;
};

function assertExpectedBinding(
  observation: Awaited<ReturnType<typeof readLibraryProfileSourceObservation>>,
  expected?: ExpectedProgressBinding,
) {
  const source = observation?.source;
  if (
    expected &&
    (!observation ||
      !source ||
      source.kind !== 'supported' ||
      source.subjectId !== expected.subjectId ||
      JSON.stringify(source.pin) !== JSON.stringify(expected.profilePin) ||
      observation.anchor.requestedSubjectId !== expected.requestedSubjectId ||
      observation.anchor.acceptingType !== expected.acceptingType ||
      observation.anchor.identityEpoch.toString() !== expected.identityEpoch ||
      observation.anchor.component.partition !== expected.component.partition ||
      observation.anchor.component.epoch !== expected.component.epoch ||
      observation.anchor.component.position.toString() !== expected.component.position)
  )
    throw new ProblemError('conflict');
}

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

function event(session: Pick<ProgressSession, 'accountId' | 'id'>) {
  return {
    type: 'com.rezics.library.progress_session.updated.v1',
    subject: session.accountId,
    data: { sessionId: session.id },
  };
}

function sameJournalDate(left: ProgressSessionJournalDate | null, right: ProgressSessionJournalDate | null): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.year === right.year &&
      (left.month ?? null) === (right.month ?? null) &&
      (left.day ?? null) === (right.day ?? null))
  );
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

  async function startSession(actor: Actor, input: unknown, requestKey: string, expected?: ExpectedProgressBinding) {
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
            const observation = await readLibraryProfileSourceObservation(deps, parsed.subjectId),
              source = observation?.source ?? null;
            const version =
              parsed.versionSubjectId === null
                ? null
                : parsed.versionSubjectId === parsed.subjectId
                  ? source
                  : await readLibraryProfileSource(deps, parsed.versionSubjectId);
            assertExpectedBinding(observation, expected);
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
        for (const measure of parsed.additionalMeasures ?? []) {
          const unit = descriptor(source.profile, { mode: 'scalar_amount', unit: measure.unit });
          valid(parseProgressMeasureCreate(measure, unit));
        }
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
    action: ProgressAction | 'record' | 'reopen' | 'retire',
    expected?: ExpectedProgressBinding,
  ) {
    const owner = account(actor, 'progress_session:update');
    const route = sameAccountRoute(owner.accountId, sessionId);
    const { revision, record } = revisionInput(input);
    const measureId = action === 'record' && Object.hasOwn(record, 'measureId') ? record.measureId : undefined;
    if (measureId !== undefined && (typeof measureId !== 'string' || measureId.length < 1 || measureId.length > 64))
      throw new ProgressInvalidError('measureId');
    const recordValue = { ...record };
    delete recordValue.measureId;
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
            if (action === 'reopen' || action === 'retire' || (expected && action !== 'record')) {
              const session = await snapshot(owner, 'progress_session:update', (client) =>
                load(client, owner, sessionId),
              );
              const sourceDeps = { pool, access, actor: owner, at: attempt.time, deadline },
                observation = await readLibraryProfileSourceObservation(sourceDeps, session.subjectId),
                source = observation?.source ?? null;
              assertExpectedBinding(observation, expected);
              if (!source) throw new LibraryNotFoundError();
              // No new value is admitted. The original session identity and meaning stay intact,
              // including when the current profile no longer offers its unit.
              return { original: null, source, pin: null };
            }
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
            const sourceDeps = { pool, access, actor: owner, at: attempt.time, deadline },
              observation = expected
                ? await readLibraryProfileSourceObservation(sourceDeps, fact.session.subjectId)
                : null,
              source = expected
                ? (observation?.source ?? null)
                : await readLibraryProfileSource(sourceDeps, fact.session.subjectId);
            assertExpectedBinding(observation, expected);
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
        if (current.state === 'retired') throw new LibraryNotFoundError();
        if (expected) {
          // Prepared profile and identity were checked against the reviewed binding before effects.
          // Record's original compatibility check remains below.
          if (!prepared.source || prepared.source.subjectId !== expected.subjectId) throw new ProblemError('conflict');
        }
        if (
          measureId !== undefined &&
          (current.mode !== 'scalar_amount' ||
            (measureId !== current.unit && !current.measures?.some((measure) => measure.unit === measureId)))
        )
          throw new ProgressInvalidError('measureId');
        // A concurrent NULL-pin migration cannot let prepared legacy meaning admit a pinned value.
        if (action === 'record' && !clearing && JSON.stringify(fact.pin) !== JSON.stringify(prepared.pin))
          throw new ProgressConflictError();
        if (current.revision !== revision) throw new ProgressConflictError();
        const context = { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) };
        const changes: ProgressSessionUpdate = { ...current };
        let intent: unknown;
        if (clearing) {
          Object.assign(changes, await clearProgressValues(tx, route, current, measureId));
          intent = measureId === undefined ? { clear: true } : { measureId, clear: true };
        } else if (action === 'record') {
          const mode = measureId === undefined ? current.mode : 'scalar_amount';
          const unit = measureId ?? current.unit;
          const parsed = valid(
            parseRecord(
              mode,
              recordValue,
              { unit, state: current.state },
              prepared.original ? descriptor(prepared.original, { mode, unit }) : undefined,
            ),
          );
          if (prepared.original) {
            const source = prepared.source;
            if (!source) throw new LibraryNotFoundError();
            if (source.kind !== 'supported') throw new ProblemError('unsupported_library_profile');
            const originalUnit = descriptor(prepared.original, { mode, unit });
            const currentUnit = descriptor(source.profile, { mode, unit });
            if (!compatibleProgressUnits(originalUnit, currentUnit))
              throw new ProblemError('unsupported_library_profile');
            const admitted = parseRecord(mode, recordValue, { unit, state: current.state }, currentUnit);
            if (!admitted.ok) throw new ProblemError('unsupported_library_profile');
          }
          intent = changeIntent(parsed, measureId);
          if ('amount' in parsed) {
            if (measureId === undefined || measureId === current.unit) changes.amount = parsed.amount;
            else if (current.measures)
              changes.measures = current.measures.map((measure) =>
                measure.unit === measureId ? { ...measure, amount: parsed.amount } : measure,
              );
            else throw new ProgressInvalidError('measureId');
          } else if ('locator' in parsed) {
            changes.locator = parsed.locator;
            changes.position = parsed.position;
          } else {
            const removed = 'remove' in parsed ? await store.removeUnits(tx, route, sessionId, parsed.remove) : 0;
            const added = 'add' in parsed ? await store.addUnits(tx, route, sessionId, parsed.add, context) : 0;
            changes.completedUnitCount = valid(nextUnitCount(current.completedUnitCount, added, removed));
          }
        } else if (action === 'reopen' || action === 'retire') {
          changes.state = valid(correctOccurrence(current.state, action));
          changes.completedAt = null;
          intent = { lifecycle: action, previousState: current.state, previousCompletedAt: current.completedAt };
        } else {
          changes.state = valid(transition(current.state, action));
          changes.completedAt = action === 'complete' ? context.time : null;
        }
        const session = await store.updateSession(tx, route, sessionId, revision, changes, context);
        if (!session) throw new ProgressConflictError();
        if (action === 'record' || action === 'reopen' || action === 'retire')
          await store.appendChange(tx, route, sessionId, session.revision, intent, context);
        // Corrections leave the current shelf and holdings untouched. Native source hooks
        // invalidate derived membership; they do not rewrite an independent Library entry.
        if (action !== 'reopen' && action !== 'retire')
          await activity.touch(write, {
            subjectId: session.subjectId,
            time: context.time,
            completed: action === 'complete',
          });
        return { value: session, events: [event(session)] };
      },
    );
  }

  const recordProgress = (
    actor: Actor,
    sessionId: string,
    input: unknown,
    requestKey: string,
    expected?: ExpectedProgressBinding,
  ) => update(actor, sessionId, input, requestKey, 'record', expected);
  const completeSession = (
    actor: Actor,
    sessionId: string,
    input: unknown,
    requestKey: string,
    expected?: ExpectedProgressBinding,
  ) => update(actor, sessionId, input, requestKey, 'complete', expected);
  const abandonSession = (
    actor: Actor,
    sessionId: string,
    input: unknown,
    requestKey: string,
    expected?: ExpectedProgressBinding,
  ) => update(actor, sessionId, input, requestKey, 'abandon', expected);
  const reopenSession = (actor: Actor, sessionId: string, input: unknown, requestKey: string) =>
    update(actor, sessionId, input, requestKey, 'reopen');
  const retireSession = (actor: Actor, sessionId: string, input: unknown, requestKey: string) =>
    update(actor, sessionId, input, requestKey, 'retire');

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

  const inspectSession = (actor: Actor, sessionId: string) =>
    snapshot(actor, 'progress_session:read', async (client, owner) => {
      const route = sameAccountRoute(owner.accountId, sessionId);
      const session = await store.readSession(client, route, sessionId);
      if (!session || session.accountId !== owner.accountId) throw new LibraryNotFoundError();
      const fact = await store.readSessionFact(client, route, sessionId);
      if (!fact || fact.session.accountId !== owner.accountId) throw new LibraryNotFoundError();
      return fact;
    });

  const readSessionJournal = (actor: Actor, sessionId: string) =>
    snapshot(actor, 'progress_session:read', async (client, owner) => {
      const route = sameAccountRoute(owner.accountId, sessionId);
      const journal = await store.readSessionJournal(client, route, owner.accountId, sessionId);
      if (!journal) throw new LibraryNotFoundError();
      return journal;
    });

  async function patchSessionJournal(
    actor: Actor,
    sessionId: string,
    input: unknown,
    requestKey: string,
    admission?: ProgressSessionJournalAdmission,
  ) {
    const owner = account(actor, 'progress_session:update');
    const route = sameAccountRoute(owner.accountId, sessionId);
    const parsed = parseProgressSessionJournalPatch(input);
    if (!parsed.ok) throw new ProgressInvalidError(parsed.field);
    const patch = parsed.value;
    return runner.ownAccount(
      actor,
      {
        action: 'progress_session:update',
        kind: 'progress_session.journal',
        requestKey,
        input: { sessionId, patch, admission: admission?.identity ?? null },
      },
      async (tx) => {
        if (admission) {
          await sessionLock.run(tx, { route, session_id: sessionId });
          const fact = await store.readSessionFact(tx, route, sessionId);
          if (!fact || fact.session.accountId !== owner.accountId || fact.session.state === 'retired')
            throw new LibraryNotFoundError();
        }
        await admission?.assert(tx);
        const current = await store.lockSessionJournal(tx, route, owner.accountId, sessionId);
        if (!current) throw new LibraryNotFoundError();
        if (current.revision !== patch.revision) throw new ProgressConflictError();

        const startDate = Object.hasOwn(patch, 'startDate') ? (patch.startDate ?? null) : current.startDate;
        const finishDate = Object.hasOwn(patch, 'finishDate') ? (patch.finishDate ?? null) : current.finishDate;
        const reflection = Object.hasOwn(patch, 'reflection') ? (patch.reflection ?? null) : current.reflection;
        const unchanged =
          sameJournalDate(startDate, current.startDate) &&
          sameJournalDate(finishDate, current.finishDate) &&
          reflection === current.reflection;
        if (unchanged) return noEffect({ sessionId, revision: current.revision, changed: false });
        if (current.revision >= 2_147_483_646) throw new ProgressConflictError();

        const updated = await store.updateSessionJournal(tx, route, owner.accountId, sessionId, current.revision, {
          sessionId,
          revision: current.revision,
          startDate,
          finishDate,
          reflection,
        });
        if (!updated) throw new ProgressConflictError();
        return {
          value: { sessionId, revision: updated.revision, changed: true },
          events: [event({ accountId: owner.accountId, id: sessionId })],
        };
      },
    );
  }

  /** Presentation owns no stored state. Rendering runs between released reads and final native checks. */
  async function readPresentedSession<T>(
    actor: Actor,
    sessionId: string,
    render: (
      session: ProgressSession,
      presentation: ProgressPresentation,
      disclosure: { subject: boolean; versionSubject: boolean },
      measurePresentations: readonly ProgressMeasurePresentation[],
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
        async function observed() {
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
          const before = await observed();
          const prepared = await prepareProgressPresentation({ pool, access, actor: owner, at, deadline }, before.fact);
          const result = await render(
            before.fact.session,
            prepared.presentation,
            prepared.disclosure,
            prepared.measurePresentations,
          );
          const finalTime = await time();
          try {
            await prepared.verify(finalTime);
            const after = await observed();
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
    reopenSession,
    retireSession,
    readSession,
    inspectSession,
    readSessionJournal,
    patchSessionJournal,
    readPresentedSession,
    listSessions,
    listUnits,
    listChanges,
  };
}
