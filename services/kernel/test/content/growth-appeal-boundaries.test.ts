import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth } from '../support/growth.ts';
import {
  createGrowthAppealBoundariesFixture,
  type AppealHistoryAxis,
} from './support/growth-appeal-boundaries-fixture.ts';

const scales = [64, 256, 1024] as const;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const axes: readonly AppealHistoryAxis[] = ['unrelated-pending', 'retained-history'];

let fixture: Awaited<ReturnType<typeof createGrowthAppealBoundariesFixture>>;

beforeAll(async () => {
  fixture = await createGrowthAppealBoundariesFixture();
}, 300_000);

afterAll(async () => {
  await fixture?.close();
});

test('native appeal queue paths keep bounded work across unrelated and retained decision histories', async () => {
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
  expect(lostControl.body?.appeals.map((row: { id: string }) => row.id)).not.toContain(lost!.appealId);

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
        const rows = body?.appeals as Array<{ id: string }>;
        expect(rows.map((row) => row.id)).not.toContain(lost!.appealId);
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
        grow: (database, scale, previous) =>
          fixture.seedHistory(
            database,
            axis,
            `${scenario.name}-${axis}`,
            scale,
            previous,
            pressureBoardId,
            pressureTarget.threadId,
          ),
        async operation() {
          const result = await fixture.listAppeals(scenario.boardId, scenario.bearer, scenario.cursor);
          expect(result.response.status).toBe(scenario.expectedStatus);
          scenario.assert(result.body);
          return result.response.status;
        },
      });
      console.info(JSON.stringify({ name, report }));
    }
  }
}, 300_000);
