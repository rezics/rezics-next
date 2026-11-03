import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import {
  createGrowthAppealBoundariesFixture,
  type AppealHistoryAxis,
} from './support/growth-appeal-boundaries-fixture.ts';

const scales = [256, 1024, 4096] as const;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const axes: readonly AppealHistoryAxis[] = [
  'unrelated-pending',
  'retained-history',
  'identity-history',
  'authority-history',
];
const relations = [
  'content.moderation_appeal',
  'content.moderation_decision',
  'content.moderation_appeal_board',
  'access.account',
  'access.resource_grant',
];

let fixture: Awaited<ReturnType<typeof createGrowthAppealBoundariesFixture>>;

beforeAll(async () => {
  fixture = await createGrowthAppealBoundariesFixture();
}, 300_000);

afterAll(async () => {
  await fixture?.close();
});

test('native appeal queue paths keep bounded work as each retained history grows independently', async () => {
  const { db, people } = fixture;
  const boardId = fixture.base.mainBoardId;
  await fixture.grant(boardId, people.reviewer.accountId, ['moderation:read_reports']);

  const selected = [];
  for (let index = 0; index < 6; index++) {
    const target = await fixture.createThread(boardId, `Selected appeal ${index}`);
    const result = await fixture.submitAppeal(boardId, target);
    expect(result.reportReceipt.response.status).toBe(200);
    expect(result.reportReceipt.body?.report).toMatchObject({ outcome: 'actioned' });
    expect(result.appeal.response.status).toBe(201);
    expect(result.appealReplay.response.status).toBe(201);
    expect(result.appealReplay.body).toEqual(result.appeal.body);
    expect(result.authorDecision.response.status).toBe(200);
    expect(result.authorDecision.body?.appeal).toMatchObject({ id: result.record.appealId });
    selected.push(result.record);
  }

  const firstControl = await fixture.listAppeals(boardId, people.reviewer.bearer);
  expect(firstControl.response.status).toBe(200);
  expect(firstControl.body?.appeals).toHaveLength(2);
  expect(typeof firstControl.body?.next).toBe('string');
  const firstIds = firstControl.body!.appeals.map((row: { id: string }) => row.id) as string[];
  const deepCursor = firstControl.body!.next as string;
  const deepControl = await fixture.listAppeals(boardId, people.reviewer.bearer, deepCursor);
  expect(deepControl.response.status).toBe(200);
  expect(deepControl.body?.appeals).toHaveLength(2);
  expect(typeof deepControl.body?.next).toBe('string');
  const deepIds = deepControl.body!.appeals.map((row: { id: string }) => row.id) as string[];
  expect(new Set([...firstIds, ...deepIds]).size).toBe(4);

  const deniedControl = await fixture.listAppeals(boardId, people.author.bearer);
  expect(deniedControl.response.status).toBe(404);
  expect(deniedControl.body).toMatchObject({ code: 'not_found' });

  const lost = selected.find((item) => item.appealId === firstIds[0]);
  expect(lost).toBeDefined();
  await fixture.revokeTargetModeration(lost!.threadId, people.reviewer.accountId);
  const lostControl = await fixture.listAppeals(boardId, people.reviewer.bearer);
  expect(lostControl.response.status).toBe(200);
  expect(lostControl.body?.appeals.find((row: { id: string }) => row.id === lost!.appealId)).toMatchObject({
    canResolve: false,
  });

  const emptyBoardId = await fixture.createBoard('Terminal empty appeal boundary');
  await fixture.grant(emptyBoardId, people.reviewer.accountId, ['moderation:read_reports']);
  const terminalRecords = [];
  for (let index = 0; index < 4; index++) {
    const target = await fixture.createThread(emptyBoardId, `Terminal appeal ${index}`);
    const result = await fixture.submitAppeal(emptyBoardId, target);
    expect(result.reportReceipt.body?.report).toMatchObject({ outcome: 'actioned' });
    expect(result.appealReplay.body).toEqual(result.appeal.body);
    terminalRecords.push(result.record);
  }
  const terminalStart = await fixture.listAppeals(emptyBoardId, people.reviewer.bearer);
  expect(terminalStart.response.status).toBe(200);
  expect(terminalStart.body?.appeals).toHaveLength(2);
  expect(typeof terminalStart.body?.next).toBe('string');
  const terminalCursor = terminalStart.body!.next as string;
  const terminalLastPage = await fixture.listAppeals(emptyBoardId, people.reviewer.bearer, terminalCursor);
  expect(terminalLastPage.response.status).toBe(200);
  expect(terminalLastPage.body?.appeals).toHaveLength(2);
  expect(terminalLastPage.body?.next).toBeNull();
  for (const record of terminalRecords) await fixture.resolveAppeal(record);
  const terminalControl = await fixture.listAppeals(emptyBoardId, people.reviewer.bearer, terminalCursor);
  expect(terminalControl.response.status).toBe(200);
  expect(terminalControl.body?.appeals).toEqual([]);
  expect(terminalControl.body?.next).toBeNull();

  const pressureBoardId = await fixture.createBoard('Unrelated appeal history pressure');
  const pressureTarget = await fixture.createThread(pressureBoardId, 'Unrelated appeal history target');
  const scenarios = [
    {
      name: 'first-page',
      boardId,
      bearer: people.reviewer.bearer,
      cursor: undefined,
      expectedStatus: 200,
      assert(body: Record<string, any> | null) {
        expect(body?.appeals.map((row: { id: string }) => row.id)).toEqual(firstIds);
      },
    },
    {
      name: 'deep-page',
      boardId,
      bearer: people.reviewer.bearer,
      cursor: deepCursor,
      expectedStatus: 200,
      assert(body: Record<string, any> | null) {
        expect(body?.appeals.map((row: { id: string }) => row.id)).toEqual(deepIds);
      },
    },
    {
      name: 'terminal-empty',
      boardId: emptyBoardId,
      bearer: people.reviewer.bearer,
      cursor: terminalCursor,
      expectedStatus: 200,
      assert(body: Record<string, any> | null) {
        expect(body?.appeals).toEqual([]);
        expect(body?.next).toBeNull();
      },
    },
    {
      name: 'exact-terminal-readback',
      boardId: emptyBoardId,
      bearer: people.reviewer.bearer,
      cursor: terminalCursor,
      inspect: terminalRecords[0]!.appealId,
      expectedStatus: 200,
      assert(body: Record<string, any> | null) {
        expect(body?.appeals).toEqual([]);
        expect(body?.selectedAppeal).toMatchObject({
          id: terminalRecords[0]!.appealId,
          resolution: {
            outcome: 'upheld',
            statement: 'Reviewed independently',
            resolvedAt: expect.any(String),
          },
        });
        expect(body?.next).toBeNull();
      },
    },
    {
      name: 'denied',
      boardId,
      bearer: people.author.bearer,
      cursor: undefined,
      expectedStatus: 404,
      assert(body: Record<string, any> | null) {
        expect(body).toMatchObject({ code: 'not_found' });
      },
    },
    {
      name: 'late-current-authority-loss',
      boardId,
      bearer: people.reviewer.bearer,
      cursor: undefined,
      expectedStatus: 200,
      assert(body: Record<string, any> | null) {
        const rows = body?.appeals as Array<{ id: string; canResolve: boolean }>;
        expect(rows.find((row) => row.id === lost!.appealId)).toMatchObject({ canResolve: false });
        expect(rows.length).toBeGreaterThan(0);
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    for (const axis of axes) {
      const name = `appeal queue ${scenario.name} ${axis}`;
      const report = await checkGrowth(db, {
        name,
        scales,
        bounds,
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        includeBackends: true,
        grow: (database, scale, previous) =>
          fixture.seedHistory(
            database,
            axis,
            `${scenario.name}-${axis}`,
            scale,
            previous,
            axis === 'authority-history' ? scenario.boardId : pressureBoardId,
            pressureTarget.threadId,
          ),
        async operation() {
          const query = new URLSearchParams({ limit: '2' });
          if (scenario.cursor) query.set('cursor', scenario.cursor);
          if ('inspect' in scenario) query.set('inspect', scenario.inspect);
          const result = await fixture.call('GET', `/v1/boards/${scenario.boardId}/appeals?${query}`, {
            bearer: scenario.bearer,
          });
          expect(result.response.status).toBe(scenario.expectedStatus);
          scenario.assert(result.body);
          return result.response.status;
        },
      });
      assertGrowthAccessPaths(name, report.samples, relations);
      console.info(JSON.stringify({ name, report }));
    }
  }
}, 1_800_000);

test('registered appeal projection, resolution notification and replay retain bounded native phases', async () => {
  const boardId = await fixture.createBoard('Registered appeal phases');
  await fixture.grant(boardId, fixture.people.reviewer.accountId, ['moderation:read_reports']);
  const pressure = await fixture.createThread(boardId, 'Registered phase history');
  for (const axis of axes) {
    for (const phase of ['creation', 'resolution', 'replay'] as const) {
      let principal: string;
      let key: string;
      let record: Awaited<ReturnType<typeof fixture.submitAppeal>>['record'];
      const kind = phase === 'creation' ? 'content.appeal' : 'content.resolve-appeal';
      const prepare = async () => {
        const target = await fixture.createThread(boardId, `Registered ${phase}`);
        const submitted = await fixture.submitAppeal(boardId, target, phase !== 'creation');
        record = submitted.record;
        principal = fixture.people.author.accountId;
        key = submitted.appealKey;
        if (phase !== 'creation') {
          principal = fixture.people.reviewer.accountId;
          const resolved = await fixture.command(
            'POST',
            `/v1/moderation-appeals/${record.appealId}:resolve`,
            { outcome: 'uphold', statement: 'Registered phase result' },
            { bearer: fixture.people.reviewer.bearer, expectedStatus: 200 },
          );
          key = resolved.key;
          if (phase === 'replay') await fixture.completeRegisteredCommand(principal, key, kind);
        }
      };
      const operation = async () => {
        const before = fixture.runnerPhases.length;
        await fixture.completeRegisteredCommand(principal, key, kind);
        const phases = fixture.runnerPhases.slice(before).filter((entry) => entry.subject === record.appealId);
        expect(phases.filter((entry) => entry.effect === 'content_moderation_appeal')).toHaveLength(
          phase === 'replay' ? 0 : 1,
        );
      };
      const name = `appeal registered ${phase} ${axis}`;
      const report = await checkGrowth(fixture.db, {
        name,
        scales,
        bounds,
        repetitions: 1,
        includeBackends: true,
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        grow: (db, scale, previous) => fixture.seedHistory(db, axis, name, scale, previous, boardId, pressure.threadId),
        prepare,
        warmup: async () => {
          await prepare();
          await operation();
        },
        operation,
      });
      assertGrowthAccessPaths(name, report.samples, relations);
      console.info(JSON.stringify({ name, report }));
    }
  }
}, 1_800_000);

test('current authority, session replacement, concurrent resolution and a lost response preserve exact readback', async () => {
  const { people } = fixture;
  const boardId = await fixture.createBoard('Appeal state changes');
  const target = await fixture.createThread(boardId, 'Appeal state change target');
  const { record } = await fixture.submitAppeal(boardId, target);
  await fixture.grant(boardId, people.reviewer.accountId, ['moderation:read_reports']);
  const inspect = `/v1/boards/${boardId}/appeals?limit=2&inspect=${record.appealId}`;
  const path = `/v1/moderation-appeals/${record.appealId}:resolve`;
  const input = { outcome: 'uphold', statement: 'Concurrent retained result' };
  const key = randomUUID();
  const before = await fixture.call('GET', inspect, { bearer: people.reviewer.bearer });
  expect(before.response.status).toBe(200);
  expect(before.body?.selectedAppeal).toMatchObject({ id: record.appealId, canResolve: true });
  await fixture.revokeTargetModeration(record.threadId, people.reviewer.accountId);
  const revoked = await fixture.call('GET', inspect, { bearer: people.reviewer.bearer });
  expect(revoked.body?.selectedAppeal).toMatchObject({ canResolve: false });
  expect((await fixture.call('POST', path, { bearer: people.reviewer.bearer, key, body: input })).response.status).toBe(
    403,
  );
  await fixture.grant(record.threadId, people.reviewer.accountId, ['moderation:takedown']);

  const replacement = await fixture.reviewerSession();
  const session = before.response.headers.get(SESSION_HEADER) ?? undefined;
  const switched = await fixture.call('GET', inspect, { bearer: replacement.bearer, session });
  expect(switched.response.status).toBe(200);
  expect(switched.body?.provenance.actorId).toBe(people.reviewer.accountId);
  expect(switched.body?.provenance.session.clientId).not.toBe(before.body?.provenance.session.clientId);
  expect(JSON.stringify(switched.body)).not.toContain(replacement.bearer);

  const pageSql = fixture.observer.records.find((entry) =>
    /FROM\s+content\.moderation_appeal_board\b/i.test(entry.statement),
  );
  expect(pageSql).toBeDefined();
  const barrier = fixture.observer.hold({ statement: pageSql!.statement }, 'after');
  const inFlight = fixture.call('GET', inspect, { bearer: replacement.bearer });
  try {
    await barrier.entered;
    await fixture.revokeTargetModeration(boardId, people.reviewer.accountId, 'moderation:read_reports');
  } finally {
    barrier.release();
  }
  const retired = await inFlight;
  expect(retired.response.status).toBe(404);
  expect(retired.body).toMatchObject({ code: 'not_found' });
  await fixture.grant(boardId, people.reviewer.accountId, ['moderation:read_reports']);

  const competingKey = randomUUID();
  const results = await Promise.all([
    fixture.call('POST', path, { bearer: people.reviewer.bearer, key, body: input }),
    fixture.call('POST', path, {
      bearer: people.reviewer.bearer,
      key: competingKey,
      body: { ...input, outcome: 'reverse' },
    }),
  ]);
  expect(results.map((result) => result.response.status).sort()).toEqual([200, 409]);
  const winner = results[0]!.response.status === 200 ? 0 : 1;
  const winningKey = winner === 0 ? key : competingKey;
  const winningInput = { ...input, outcome: winner === 0 ? 'uphold' : 'reverse' };
  await fixture.completeRegisteredCommand(people.reviewer.accountId, winningKey, 'content.resolve-appeal');
  // Discard the successful transport result and recover using the original command key.
  const retry = await fixture.call('POST', path, {
    bearer: people.reviewer.bearer,
    key: winningKey,
    body: winningInput,
  });
  expect(retry.response.status).toBe(200);
  expect(retry.body).toEqual(results[winner]!.body);
  expect(
    (
      await fixture.call('POST', path, {
        bearer: people.reviewer.bearer,
        key: winningKey,
        body: { ...winningInput, statement: 'Changed retry' },
      })
    ).response.status,
  ).toBe(422);
  const exact = await fixture.call('GET', inspect, { bearer: replacement.bearer });
  expect(exact.body?.appeals).toEqual([]);
  expect(exact.body?.selectedAppeal.resolution).toMatchObject({
    outcome: winner === 0 ? 'upheld' : 'reversed',
    statement: input.statement,
  });
  await fixture.revokeTargetModeration(record.threadId, people.reviewer.accountId);
  expect(
    (await fixture.call('POST', path, { bearer: people.reviewer.bearer, key: winningKey, body: winningInput })).response
      .status,
  ).toBe(403);
  await fixture.revokeTargetModeration(boardId, people.reviewer.accountId, 'moderation:read_reports');
  const denied = await fixture.call('GET', inspect, { bearer: people.reviewer.bearer });
  expect(denied.response.status).toBe(404);
  expect(denied.body).toMatchObject({ code: 'not_found' });
  await fixture.grant(boardId, people.reviewer.accountId, ['moderation:read_reports']);
  await fixture.reviewerSession(true);
  await fixture.deleteReviewer();
  for (const bearer of [people.reviewer.bearer, replacement.bearer]) {
    expect((await fixture.call('GET', inspect, { bearer, session })).response.status).toBe(401);
    expect((await fixture.call('POST', path, { bearer, key: winningKey, body: winningInput })).response.status).toBe(
      401,
    );
  }
}, 300_000);
