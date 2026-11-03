import type { Anchor, ShelvesSeed } from '../../../../../specs/library-shelves-driver.ts';
import type { NativeConformanceWorld } from './native-conformance.ts';
import { json, requestKey } from './native-conformance.ts';

type Actor = { accountId: string; credential: string };
type SeededSession = { id: string; subjectId: string; state: 'active' | 'completed' | 'abandoned' };

export interface NativeShelvesGrowthPopulation {
  entries: number;
  activeSessions: number;
  completedSessions: number;
  abandonedSessions: number;
  completedUnitRows: number;
  activeHeads: number;
  inactiveHeads: number;
  typeKeys: number;
  counterRows: { bucket: string; typeId: string; count: number }[];
}

export interface NativeShelvesGrowthFixture {
  seed(input: ShelvesSeed): Promise<void>;
  /** Counts only the actual rows owned by this fixture's accounts and recorded session identities. */
  inspect(): Promise<NativeShelvesGrowthPopulation>;
}

const day = 24 * 60 * 60 * 1000;

function seedTime(now: string): string {
  const instant = Date.parse(now);
  if (!Number.isFinite(instant)) throw new TypeError('Native shelf growth fixture requires a valid clock instant');
  return new Date(Math.min(instant - 365 * day, Date.parse('2030-01-01T00:00:00.000Z') - 1)).toISOString();
}

function assertTotals(input: ShelvesSeed): void {
  for (const [name, value] of Object.entries(input))
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Shelf growth ${name} must be a non-negative integer`);
}

export function createNativeShelvesGrowthFixture(
  world: NativeConformanceWorld,
  input: { type: string; trackAccount(accountId: string): void },
): NativeShelvesGrowthFixture {
  const owner: Actor = { accountId: world.accounts.owner.id, credential: world.native.token('owner') };
  const entrySubjects: Anchor[] = [];
  const activeSubjects: Anchor[] = [];
  const activeSessions: SeededSession[] = [];
  const inactiveSessions: SeededSession[] = [];
  const completedUnitSessions = new Set<string>();
  let entryActor: Actor | undefined;
  let activeActor: Actor | undefined;

  async function unrelatedActor(role: 'entries' | 'activeSessions'): Promise<Actor> {
    const current = role === 'entries' ? entryActor : activeActor;
    if (current) return current;
    const principal = await world.native.principal(role === 'entries' ? 4030 : 4031);
    const actor = { accountId: principal.accountId, credential: principal.credential };
    input.trackAccount(actor.accountId);
    if (role === 'entries') entryActor = actor;
    else activeActor = actor;
    return actor;
  }

  async function subject(): Promise<Anchor> {
    return world.native.subject(input.type);
  }

  async function command<T>(actor: Actor, method: 'POST' | 'PUT', path: string, body: unknown, status: number): Promise<T> {
    const response = await world.native.bearerRequest(actor.credential, path, {
      method,
      headers: { 'content-type': 'application/json', 'Idempotency-Key': requestKey() },
      body: JSON.stringify(body),
    });
    return json<T>(response, status);
  }

  async function startSession(actor: Actor, subjectId: string, mode: 'scalar_amount' | 'completed_units') {
    return command<{ progressSession: { id: string; subjectId: string; revision: number; state: 'active' } }>(
      actor,
      'POST',
      '/v1/progressSessions',
      { subjectId, mode, unit: 'page' },
      201,
    );
  }

  async function growEntries(target: number): Promise<void> {
    if (entrySubjects.length >= target) return;
    const actor = await unrelatedActor('entries');
    while (entrySubjects.length < target) {
      const created = await subject();
      await command(actor, 'PUT', `/v1/libraryEntries/${created.id}`, { state: 'planned' }, 201);
      entrySubjects.push(created);
    }
  }

  async function growActiveSessions(target: number): Promise<void> {
    if (activeSessions.length >= target) return;
    const actor = await unrelatedActor('activeSessions');
    while (activeSessions.length < target) {
      const created = await subject();
      const started = await startSession(actor, created.id, 'scalar_amount');
      activeSubjects.push(created);
      activeSessions.push({ id: started.progressSession.id, subjectId: created.id, state: 'active' });
    }
  }

  async function ownerHistorySubjects(): Promise<string[]> {
    const result = await world.native.reader.query<{ subjectId: string }>(
      `SELECT e.subject_id AS "subjectId"
         FROM library.entry e
        WHERE e.route=$1 AND e.account_id=$2
          AND NOT EXISTS (
            SELECT 1 FROM library.progress_session s
             WHERE s.route=e.route AND s.account_id=e.account_id AND s.subject_id=e.subject_id AND s.state='active'
          )
        ORDER BY e.subject_id`,
      [world.accounts.owner.route, owner.accountId],
    );
    return result.rows.map((row) => row.subjectId);
  }

  async function growInactiveSessions(target: number): Promise<void> {
    const eligibleOwnerSubjects = await ownerHistorySubjects();
    while (inactiveSessions.length < target) {
      const ordinal = inactiveSessions.length;
      const subjectId = eligibleOwnerSubjects.length
        ? eligibleOwnerSubjects[ordinal % eligibleOwnerSubjects.length]!
        : (await subject()).id;
      const mode = ordinal % 4 === 0 ? 'completed_units' : 'scalar_amount';
      let session = (await startSession(owner, subjectId, mode)).progressSession;
      if (mode === 'completed_units') {
        const unitId = `native-shelf-growth:${ordinal}`;
        const recorded = await command<{
          progressSession: { id: string; subjectId: string; revision: number; state: 'active' };
        }>(owner, 'POST', `/v1/progressSessions/${session.id}:record`, { revision: session.revision, add: [unitId] }, 200);
        session = recorded.progressSession;
        completedUnitSessions.add(session.id);
      }
      const action = ordinal % 2 === 0 ? 'complete' : 'abandon';
      await command<{ progressSession: { id: string; subjectId: string; revision: number; state: string } }>(
        owner,
        'POST',
        `/v1/progressSessions/${session.id}:${action}`,
        { revision: session.revision },
        200,
      );
      inactiveSessions.push({ id: session.id, subjectId, state: action === 'complete' ? 'completed' : 'abandoned' });
    }
  }

  async function inspect(): Promise<NativeShelvesGrowthPopulation> {
    const entryAccountId = entryActor?.accountId ?? null;
    const activeAccountId = activeActor?.accountId ?? null;
    const activeIds = activeSessions.map((session) => session.id);
    const inactiveIds = inactiveSessions.map((session) => session.id);
    const activeSubjectIds = activeSubjects.map((subject) => subject.id);
    const inactiveSubjectIds = [...new Set(inactiveSessions.map((session) => session.subjectId))];
    const result = await world.native.reader.query<{
      entries: number;
      activeSessions: number;
      completedSessions: number;
      abandonedSessions: number;
      completedUnitRows: number;
      activeHeads: number;
      inactiveHeads: number;
      typeKeys: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM library.entry
           WHERE account_id=$1::uuid AND subject_id=ANY($2::uuid[])) AS entries,
         (SELECT count(*)::integer FROM library.progress_session
           WHERE account_id=$3::uuid AND session_id=ANY($4::uuid[]) AND state='active') AS "activeSessions",
         (SELECT count(*)::integer FROM library.progress_session
           WHERE account_id=$5::uuid AND session_id=ANY($6::uuid[]) AND state='completed') AS "completedSessions",
         (SELECT count(*)::integer FROM library.progress_session
           WHERE account_id=$5::uuid AND session_id=ANY($6::uuid[]) AND state='abandoned') AS "abandonedSessions",
         (SELECT count(*)::integer FROM library.progress_unit WHERE session_id=ANY($7::uuid[])) AS "completedUnitRows",
         (SELECT count(*)::integer FROM library.progress_head
           WHERE account_id=$3::uuid AND subject_id=ANY($8::uuid[])) AS "activeHeads",
         (SELECT count(*)::integer FROM library.progress_head
           WHERE account_id=$5::uuid AND subject_id=ANY($9::uuid[])) AS "inactiveHeads",
         (SELECT count(*)::integer FROM library.shelf_type_value WHERE account_id=$1::uuid) AS "typeKeys"`,
      [
        entryAccountId,
        entrySubjects.map((subject) => subject.id),
        activeAccountId,
        activeIds,
        owner.accountId,
        inactiveIds,
        [...completedUnitSessions],
        activeSubjectIds,
        inactiveSubjectIds,
      ],
    );
    const counters = entryAccountId
      ? await world.native.reader.query<{ bucket: string; typeId: string; count: number }>(
          `SELECT bucket,type_id AS "typeId",n::integer AS count
             FROM library.shelf_count WHERE account_id=$1::uuid ORDER BY bucket,type_id`,
          [entryAccountId],
        )
      : { rows: [] as { bucket: string; typeId: string; count: number }[] };
    const row = result.rows[0];
    if (!row) throw new Error('Native shelf growth population inspection returned no result');
    return { ...row, counterRows: counters.rows };
  }

  function verify(population: NativeShelvesGrowthPopulation): void {
    const expectedActiveHeads = activeSubjects.length;
    const expectedInactiveHeads = new Set(inactiveSessions.map((session) => session.subjectId)).size;
    const expectedCompleted = inactiveSessions.filter((session) => session.state === 'completed').length;
    const expectedAbandoned = inactiveSessions.filter((session) => session.state === 'abandoned').length;
    if (
      population.entries !== entrySubjects.length ||
      population.activeSessions !== activeSessions.length ||
      population.completedSessions !== expectedCompleted ||
      population.abandonedSessions !== expectedAbandoned ||
      population.completedUnitRows !== completedUnitSessions.size ||
      population.activeHeads !== expectedActiveHeads ||
      population.inactiveHeads !== expectedInactiveHeads ||
      population.typeKeys !== (entrySubjects.length ? 1 : 0) ||
      (entrySubjects.length > 0 &&
        (!population.counterRows.some((row) => row.bucket === 'planned' && row.count === entrySubjects.length) ||
          !population.counterRows.some((row) => row.bucket === 'all' && row.count === entrySubjects.length)))
    )
      throw new Error(`Native shelf growth population did not settle to its requested relations: ${JSON.stringify(population)}`);
  }

  return {
    async seed(requested) {
      assertTotals(requested);
      const previousTime = world.now();
      try {
        await world.setTime(seedTime(previousTime));
        await growEntries(requested.entries);
        await growActiveSessions(requested.activeSessions);
        await growInactiveSessions(requested.inactiveSessions);
        await world.settle();
        verify(await inspect());
      } finally {
        await world.setTime(previousTime);
      }
    },
    inspect,
  };
}
