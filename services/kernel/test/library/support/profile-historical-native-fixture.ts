import type { Pool } from 'pg';
import type { KernelClock } from '../../../src/clock.ts';
import { authoritativeTimeValue, currentCommandReceipt } from '../../../src/command/command.ts';
import { nativeReceiptKeyCandidates } from '../../../src/command/receipt-key.ts';
import { createLibraryCommandRunner, type LibraryCommandBody } from '../../../src/library/command-support.ts';
import * as facts from '../../../src/library/entry-store.ts';
import * as progress from '../../../src/library/progress-store.ts';
import type { ProgressMode, ProgressUnit } from '../../../src/library/progress.ts';
import type { AccountActor } from '../../../src/request/access.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import type { ProfileReceiptRow } from '../../../../../specs/library-profiles-driver.ts';

export type HistoricalProfileCounts = { entries: number; sessions: number; copies: number };
export type StoredProfileReceipt = Omit<ProfileReceiptRow, 'requestKey' | 'status'> & {
  commandKind: string;
  storageKey: string;
};

/** Caller text is observed at transport, never reconstructed from the keyed storage token.
 * Only successful responses can describe a committed receipt; denied/conflicting replays cannot replace it.
 */
export function createProfileReceiptObservations(pool: Pool) {
  const observations = new Map<string, Map<string, { requestKey: string; statuses: Set<number> }>>();
  const originals = new Map<string, { requestKey: string; status: number }>();
  const identity = (accountId: string, kind: string, key: string) => JSON.stringify([accountId, kind, key]);
  return {
    observe(accountId: string, requestKey: string, response: Response, committed?: ReturnType<typeof currentCommandReceipt>, transportKey = requestKey) {
      if (!response.ok) return;
      if (committed) {
        if (committed.principal.kind !== 'account' || committed.principal.id !== accountId || committed.key !== requestKey)
          throw new Error('Historical receipt belongs to another command or owner');
        originals.set(identity(accountId, committed.kind, committed.storageKey), { requestKey, status: response.status });
      }
      let account = observations.get(accountId);
      if (!account) observations.set(accountId, (account = new Map()));
      let observation = account.get(requestKey);
      if (!observation) account.set(requestKey, (observation = { requestKey: transportKey, statuses: new Set() }));
      observation.statuses.add(response.status);
    },
    bind(row: StoredProfileReceipt): ProfileReceiptRow {
      const original = originals.get(identity(row.accountId, row.commandKind, row.storageKey));
      if (original) return { accountId: row.accountId, digest: row.digest, response: row.response, ...original };
      const matches = [...(observations.get(row.accountId) ?? [])].filter(([key]) =>
        nativeReceiptKeyCandidates(pool, row.commandKind, row.accountId, key).includes(row.storageKey),
      );
      if (matches.length !== 1 || matches[0]![1].statuses.size !== 1)
        throw new Error('Native Library dependency_unavailable: unobserved or ambiguous original receipt HTTP identity');
      const { requestKey, statuses } = matches[0]![1];
      return {
        accountId: row.accountId,
        requestKey,
        digest: row.digest,
        status: [...statuses][0]!,
        response: row.response,
      };
    },
  };
}

type HistoricalProfileHost = {
  pool: Pool;
  actor: AccountActor;
  clock?: KernelClock;
  createSubject(): Promise<string>;
  send(method: 'PUT' | 'POST', path: string, body: unknown, requestKey: string): Promise<Response>;
  receipts: ReturnType<typeof createProfileReceiptObservations>;
};

/** Test-only old command bodies, on the caller's native owner and database. No provisioning,
 * profile selection, migration implementation or SQL fact/receipt manufacture lives here.
 */
export function createProfileHistoricalNativeFixture(host: HistoricalProfileHost) {
  const { actor, pool } = host;
  const accountId = actor.accountId;
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Unroutable historical fixture owner');
  const ownerRoute = route;
  const runner = createLibraryCommandRunner({ pool, clock: host.clock });

  async function commit<T>(
    action: string,
    kind: string,
    input: unknown,
    method: 'PUT' | 'POST',
    path: string,
    body: unknown,
    write: LibraryCommandBody<T>,
  ) {
    const requestKey = crypto.randomUUID();
    let original: ReturnType<typeof currentCommandReceipt> | undefined;
    const result = await runner.ownAccount(actor, { action, kind, requestKey, input }, async (tx, command) => {
      original = currentCommandReceipt(tx);
      return write(tx, command);
    });
    if (!original || original.key !== requestKey || original.kind !== kind || result.replayed)
      throw new Error('Historical fixture did not commit an original native command');
    // The installed HTTP adapter replays that actual receipt. Its status comes from
    // the route and committed result, never an expected assertion or a status lookup table.
    const response = await host.send(method, path, body, requestKey);
    if (!response.ok)
      throw new Error(`Historical native receipt replay returned ${response.status}: ${await response.text()}`);
    host.receipts.observe(accountId, original.key, response, original);
    return { ...result, requestKey, storageKey: original.storageKey, kind, method, path, body };
  }

  const event = (type: string, data: Record<string, unknown>) => [
    { type: `com.rezics.library.${type}.updated.v1`, subject: accountId, data },
  ];

  async function entry(subjectId: string, state: string) {
    return commit(
      'library_entry:update',
      'library.entry.put',
      { subjectId, requestedSubjectId: null, state, revision: null },
      'PUT',
      `/v1/libraryEntries/${subjectId}`,
      { state },
      async (tx, command) => {
        const entry = await facts.insertEntry(
          tx,
          ownerRoute,
          { accountId, subjectId, state, requestedSubjectId: null },
          { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
        );
        return { value: { created: true, entry }, events: event('entry', { subjectId }) };
      },
    );
  }

  async function session(subjectId: string, mode: ProgressMode, unit: ProgressUnit) {
    const input = {
      subjectId,
      versionSubjectId: null,
      mode,
      unit,
      total: mode === 'scalar_amount' ? (unit === 'percent' ? '100' : '999999999999.999999') : null,
    };
    const started = await commit(
      'progress_session:create',
      'progress_session.start',
      input,
      'POST',
      '/v1/progressSessions',
      input,
      async (tx, command) => {
        const session = await progress.insertSession(
          tx,
          ownerRoute,
          { ...input, id: newId(ownerRoute), accountId },
          { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
        );
        return { value: session, events: event('progress_session', { sessionId: session.id }) };
      },
    );
    const sessionId = started.value.id;
    const intent: { amount: string } | { locator: string; position: string } | { add: string[] } =
      mode === 'scalar_amount'
        ? { amount: unit === 'percent' ? '99.999999' : '999999999999.999999' }
        : mode === 'cursor_position'
          ? { locator: 'Historic locator', position: '999999999999.999999' }
          : { add: ['1', '3', '7'] };
    const recorded = await commit(
      'progress_session:update',
      'progress_session.record',
      { sessionId, revision: 1, ...intent },
      'POST',
      `/v1/progressSessions/${sessionId}:record`,
      { revision: 1, ...intent },
      async (tx, command) => {
        const context = { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) };
        if ('add' in intent) await progress.addUnits(tx, ownerRoute, sessionId, intent.add, context);
        const session = await progress.updateSession(
          tx,
          ownerRoute,
          sessionId,
          1,
          {
            amount: 'amount' in intent ? intent.amount : null,
            locator: 'locator' in intent ? intent.locator : null,
            position: 'position' in intent ? intent.position : null,
            completedUnitCount: 'add' in intent ? intent.add.length : 0,
            state: 'active',
            completedAt: null,
          },
          context,
        );
        if (!session) throw new Error('Historical session revision was lost');
        await progress.appendChange(tx, ownerRoute, sessionId, session.revision, intent, context);
        return { value: session, events: event('progress_session', { sessionId }) };
      },
    );
    return { started, recorded };
  }

  async function copy(subjectId: string, status: string) {
    const id = newId(ownerRoute);
    const input = {
      subjectId,
      status,
      location: 'Historic shelf',
      source: 'Historic shop',
      acquiredOn: '2024-02-29',
      disposedOn: status === 'disposed' ? '2025-03-01' : null,
      note: id,
    };
    return commit('copy:create', 'library.copy.create', input, 'POST', '/v1/copies', input, async (tx, command) => {
      const { kind: _kind, ...copy } = await facts.insertCopy(
        tx,
        ownerRoute,
        { ...input, id, accountId },
        { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
      );
      return { value: copy, events: event('copy', { copyId: copy.id }) };
    });
  }

  return {
    entry,
    session,
    copy,
    async seed(rows: HistoricalProfileCounts = { entries: 5, sessions: 18, copies: 4 }) {
      for (const count of Object.values(rows))
        if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Historical relation counts must be nonnegative integers');
      const states = ['planned', 'in_progress', 'completed', 'paused', 'dropped'];
      const modes: ProgressMode[] = ['scalar_amount', 'cursor_position', 'completed_units'];
      const units: ProgressUnit[] = ['page', 'chapter', 'episode', 'volume', 'minute', 'percent'];
      const statuses = ['ordered', 'owned', 'lent', 'disposed'];
      const subjects: string[] = [];
      for (let n = 0; n < rows.entries; n++) {
        const subjectId = await host.createSubject();
        subjects.push(subjectId);
        await entry(subjectId, states[n % states.length]!);
      }
      if (!subjects.length && (rows.sessions || rows.copies)) subjects.push(await host.createSubject());
      for (let n = 0; n < rows.sessions; n++)
        await session(subjects[n % subjects.length]!, modes[Math.floor(n / units.length) % modes.length]!, units[n % units.length]!);
      for (let n = 0; n < rows.copies; n++) await copy(subjects[n % subjects.length]!, statuses[n % statuses.length]!);
    },
  };
}
