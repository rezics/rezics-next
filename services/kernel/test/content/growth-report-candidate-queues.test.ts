import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { checkGrowth } from '../support/growth.ts';
import {
  createGrowthReportCandidateQueuesFixture,
  type QueueReport,
  type QueueTrace,
} from './support/growth-report-candidate-queues-fixture.ts';

const scales = [32, 256, 2048] as const;
const repetitions = 3;
const warmups = 1;

let fixture: Awaited<ReturnType<typeof createGrowthReportCandidateQueuesFixture>>;

type QueueBranch = Readonly<{
  name: string;
  path: string;
  before?: () => Promise<void>;
  finalAuthorityLoss?: boolean;
  verify: (result: Awaited<ReturnType<typeof fixture.callQueue>>, trace: QueueTrace) => void;
}>;

beforeAll(async () => {
  fixture = await createGrowthReportCandidateQueuesFixture();
}, 180_000);

afterAll(async () => {
  await fixture?.close();
});

function reports(value: Record<string, any> | null): Record<string, any>[] {
  return Array.isArray(value?.reports) ? value.reports : [];
}

function next(value: Record<string, any> | null): string | null {
  return typeof value?.next === 'string' ? value.next : null;
}

function pagePath(selection: string, cursor?: string): string {
  const query = new URLSearchParams({ limit: String(fixture.pageLimit) });
  for (const [key, value] of new URLSearchParams(selection)) query.set(key, value);
  if (cursor !== undefined) query.set('cursor', cursor);
  return `/v1/boards/${fixture.boardId}/reports?${query}`;
}

async function readPage(path: string, bearer?: string) {
  const result = await fixture.callQueue(path, bearer);
  expect(result.response.status).toBe(200);
  expect(Array.isArray(result.value?.reports)).toBe(true);
  return result;
}

function expectPageTrace(trace: QueueTrace, expected: { candidateReads: number; finalRevoked?: boolean }): void {
  expect(trace.candidatePageQueries).toBe(expected.candidateReads);
  expect(trace.rawCandidateReferences).toBeLessThanOrEqual(
    expected.candidateReads === 0 ? 0 : fixture.pageLimit + 1,
  );
  expect(trace.reportSourceRows).toBeLessThanOrEqual(fixture.pageLimit);
  expect(trace.finalAuthorityRevoked).toBe(expected.finalRevoked ?? false);
}

async function observePage(
  path: string,
  verify: (result: Awaited<ReturnType<typeof fixture.callQueue>>, trace: QueueTrace) => void,
  bearer?: string,
  finalAuthorityLoss = false,
): Promise<void> {
  if (finalAuthorityLoss) fixture.armFinalAuthorityLoss();
  fixture.beginTrace();
  let result: Awaited<ReturnType<typeof fixture.callQueue>> | undefined;
  let trace: QueueTrace | undefined;
  try {
    result = await fixture.callQueue(path, bearer);
  } finally {
    trace = fixture.endTrace();
  }
  if (!result || !trace) throw new Error('The board report queue operation did not complete');
  verify(result, trace);
}

function expectVisibleReport(actual: Record<string, any>, expected: QueueReport): void {
  expect(actual).toMatchObject({
    id: expected.id,
    target: { kind: expected.targetKind, id: expected.targetId },
    evidence: expected.evidence,
  });
  expect(Date.parse(actual.createdAt)).toBe(Date.parse(expected.createdAt));
}

test('board selected report pages stay bounded across unrelated candidate and retained-history growth', async () => {
  const start = Date.now() + 1000;
  const at = (offset: number) => new Date(start + offset * 1000).toISOString();
  const selected: QueueReport[] = [];
  selected.push(await fixture.createReport('post', fixture.postId, `queue evidence ${randomUUID()}`, at(1)));
  selected.push(await fixture.createReport('board', fixture.boardId, `queue evidence ${randomUUID()}`, at(2)));
  selected.push(await fixture.createReport('thread', fixture.threadId, `queue evidence ${randomUUID()}`, at(3)));
  const resolved = await fixture.createReport(
    'post',
    fixture.postId,
    `queue evidence ${randomUUID()}`,
    at(4),
  );
  selected.push(resolved);
  selected.push(await fixture.createReport('post', fixture.postId, `queue evidence ${randomUUID()}`, at(5)));
  selected.push(await fixture.createReport('thread', fixture.threadId, `queue evidence ${randomUUID()}`, at(6)));
  await fixture.dismiss(resolved.id);

  const allFirstPath = pagePath('');
  const firstSetup = await readPage(allFirstPath);
  expect(next(firstSetup.value)).toBeString();
  const firstCursor = next(firstSetup.value)!;
  const deepPath = pagePath('', firstCursor);
  const deepSetup = await readPage(deepPath);

  const walked = [...reports(firstSetup.value), ...reports(deepSetup.value)];
  let continuation = next(deepSetup.value);
  while (continuation !== null) {
    const page = await readPage(pagePath('', continuation));
    walked.push(...reports(page.value));
    continuation = next(page.value);
  }
  expect(walked.map((entry) => entry.id).sort()).toEqual(selected.map((entry) => entry.id).sort());
  for (const entry of walked) {
    const known = selected.find((candidate) => candidate.id === entry.id)!;
    expectVisibleReport(entry, known);
  }
  expect(walked.some((entry) => entry.id === fixture.foreignReport.id)).toBe(false);
  const createdOrder = [...walked].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  expect(walked.map((entry) => entry.id)).toEqual(createdOrder.map((entry) => entry.id));

  const sparseSelection = 'status=resolved&targetKind=thread&order=newest';
  const sparsePath = pagePath(sparseSelection);
  const sparseSetup = await readPage(sparsePath);
  expect(reports(sparseSetup.value)).toEqual([]);
  expect(next(sparseSetup.value)).toBeString();
  let terminalPath = '';
  let sparseCursor = next(sparseSetup.value)!;
  for (;;) {
    const path = pagePath(sparseSelection, sparseCursor);
    const page = await readPage(path);
    expect(reports(page.value)).toEqual([]);
    if (next(page.value) === null) {
      terminalPath = path;
      break;
    }
    sparseCursor = next(page.value)!;
  }
  expect(terminalPath).not.toBe('');

  const resolvedSelection = 'status=resolved&targetKind=post&order=newest';
  let resolvedPostPath = pagePath(resolvedSelection);
  let resolvedPage = await readPage(resolvedPostPath);
  while (!reports(resolvedPage.value).some((entry) => entry.id === resolved.id)) {
    const cursor = next(resolvedPage.value);
    expect(cursor).toBeString();
    resolvedPostPath = pagePath(resolvedSelection, cursor!);
    resolvedPage = await readPage(resolvedPostPath);
  }
  expect(reports(resolvedPage.value).map((entry) => entry.id)).toEqual([resolved.id]);
  expect(reports(resolvedPage.value)[0]).toMatchObject({ outcome: 'dismissed' });
  expectVisibleReport(reports(resolvedPage.value)[0]!, resolved);

  const pendingThreadIds = selected
    .filter((entry) => entry.targetKind === 'thread')
    .map((entry) => entry.id)
    .sort();
  async function collectSelection(selection: string): Promise<Record<string, any>[]> {
    const results: Record<string, any>[] = [];
    let path = pagePath(selection);
    for (;;) {
      const page = await readPage(path);
      results.push(...reports(page.value));
      const cursor = next(page.value);
      if (cursor === null) return results;
      path = pagePath(selection, cursor);
    }
  }
  const pendingThreadPages = await collectSelection('status=pending&targetKind=thread&order=newest');
  expect(pendingThreadPages.every((entry) => entry.target.kind === 'thread' && entry.outcome === null)).toBe(true);
  expect(pendingThreadPages.map((entry) => entry.id).sort()).toEqual(pendingThreadIds);
  const pendingBoardPages = await collectSelection('status=pending&targetKind=board&order=newest');
  expect(pendingBoardPages.every((entry) => entry.target.kind === 'board' && entry.outcome === null)).toBe(true);
  expect(pendingBoardPages.map((entry) => entry.id)).toEqual(
    selected.filter((entry) => entry.targetKind === 'board').map((entry) => entry.id),
  );
  expect(pendingThreadIds).toHaveLength(2);

  const invalidSelection = await fixture.callQueue(
    pagePath('status=pending', firstCursor),
  );
  expect(invalidSelection.response.status).toBe(400);
  const invalidOrder = await fixture.callQueue(pagePath('order=oldest', firstCursor));
  expect(invalidOrder.response.status).toBe(400);
  const invalidScope = await fixture.callQueue(
    `/v1/threads/${fixture.threadId}/reports?limit=${fixture.pageLimit}&cursor=${encodeURIComponent(firstCursor)}`,
  );
  expect(invalidScope.response.status).toBe(400);
  const limitedCredential = await fixture.base.system.auth.issue({
    accountId: fixture.base.other.accountId,
    clientId: fixture.base.system.auth.ordinaryClient.id,
    scopes: ['moderation:read_reports'],
  });
  const invalidCredential = await fixture.callQueue(pagePath('', firstCursor), limitedCredential.bearer);
  expect(invalidCredential.response.status).toBe(400);

  const foreignPage = await fixture.callQueue(`/v1/boards/${fixture.foreign.boardId}/reports?limit=${fixture.pageLimit}`);
  expect(foreignPage.response.status).toBe(200);
  expect(reports(foreignPage.value).map((entry) => entry.id)).toContain(fixture.foreignReport.id);

  const replayed = selected[0]!;
  await fixture.replay(replayed.id);
  expect(fixture.runnerCaptures.some((item) => item.reportId === replayed.id && item.phase === 'projection')).toBe(true);
  expect(fixture.runnerCaptures.some((item) => item.reportId === replayed.id && item.phase === 'replay')).toBe(true);
  console.info(JSON.stringify({ name: 'Board report candidate setup and registered replay', captures: fixture.runnerCaptures }));

  const branches: QueueBranch[] = [
    {
      name: 'first',
      path: allFirstPath,
      before: () => fixture.ensureBoardPermission(),
      verify: (result: Awaited<ReturnType<typeof fixture.callQueue>>, trace: QueueTrace) => {
        expectPageTrace(trace, { candidateReads: 1 });
        expect(reports(result.value).map((entry) => entry.id)).toEqual(reports(firstSetup.value).map((entry) => entry.id));
        expect(reports(result.value)).toHaveLength(fixture.pageLimit);
        expect(reports(result.value).every((entry) => entry.evidence)).toBe(true);
        expect(next(result.value)).toBeString();
      },
    },
    {
      name: 'deep',
      path: deepPath,
      before: () => fixture.ensureBoardPermission(),
      verify: (result: Awaited<ReturnType<typeof fixture.callQueue>>, trace: QueueTrace) => {
        expectPageTrace(trace, { candidateReads: 1 });
        expect(reports(result.value).map((entry) => entry.id)).toEqual(reports(deepSetup.value).map((entry) => entry.id));
        expect(reports(result.value)).toHaveLength(fixture.pageLimit);
        expect(next(result.value)).toBeString();
      },
    },
    {
      name: 'resolved-post-selection',
      path: resolvedPostPath,
      before: () => fixture.ensureBoardPermission(),
      verify: (result: Awaited<ReturnType<typeof fixture.callQueue>>, trace: QueueTrace) => {
        expectPageTrace(trace, { candidateReads: 1 });
        expect(reports(result.value).map((entry) => entry.id)).toEqual([resolved.id]);
        expect(reports(result.value)[0]).toMatchObject({ target: { kind: 'post', id: fixture.postId }, outcome: 'dismissed' });
      },
    },
    {
      name: 'sparse',
      path: sparsePath,
      before: () => fixture.ensureBoardPermission(),
      verify: (result: Awaited<ReturnType<typeof fixture.callQueue>>, trace: QueueTrace) => {
        expectPageTrace(trace, { candidateReads: 1 });
        expect(reports(result.value)).toEqual([]);
        expect(next(result.value)).toBeString();
      },
    },
    {
      name: 'terminal-empty',
      path: terminalPath,
      before: () => fixture.ensureBoardPermission(),
      verify: (result: Awaited<ReturnType<typeof fixture.callQueue>>, trace: QueueTrace) => {
        expectPageTrace(trace, { candidateReads: 1 });
        expect(reports(result.value)).toEqual([]);
        expect(next(result.value)).toBeNull();
      },
    },
    {
      name: 'initial-authority-denied',
      path: allFirstPath,
      before: async () => fixture.revokeBoardPermission(),
      verify: (result: Awaited<ReturnType<typeof fixture.callQueue>>, trace: QueueTrace) => {
        expect(result.response.status).toBe(200);
        expectPageTrace(trace, { candidateReads: 0 });
        expect(reports(result.value)).toEqual([]);
        expect(next(result.value)).toBeNull();
        for (const item of selected) {
          expect(result.text).not.toContain(item.id);
          expect(result.text).not.toContain(item.evidence);
        }
      },
    },
    {
      name: 'final-authority-lost',
      path: allFirstPath,
      before: async () => fixture.ensureBoardPermission(),
      finalAuthorityLoss: true,
      verify: (result: Awaited<ReturnType<typeof fixture.callQueue>>, trace: QueueTrace) => {
        expect(result.response.status).toBe(200);
        expectPageTrace(trace, { candidateReads: 1, finalRevoked: true });
        expect(reports(result.value)).toEqual([]);
        expect(next(result.value)).toBeNull();
        for (const item of selected) {
          expect(result.text).not.toContain(item.id);
          expect(result.text).not.toContain(item.evidence);
        }
      },
    },
  ] as const;

  for (const axis of ['unrelated candidates', 'retained report and command history'] as const) {
    for (const branch of branches) {
      const check = await checkGrowth(fixture.growth, {
        name: `Board report selected queue ${branch.name} with ${axis} growth`,
        scales,
        repetitions,
        warmups,
        rule: 'series',
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        async grow(database, scale, previous) {
          if (axis === 'unrelated candidates') await fixture.growCandidates(database.admin, scale, previous);
          else await fixture.growHistories(database.admin, scale, previous);
        },
        async warmup() {
          if (branch.before) await branch.before();
          await observePage(branch.path, branch.verify, undefined, branch.finalAuthorityLoss ?? false);
        },
        async prepare() {
          if (branch.before) await branch.before();
        },
        async operation() {
          await observePage(branch.path, branch.verify, undefined, branch.finalAuthorityLoss ?? false);
        },
      });
      expect(check.rule).toBe('series');
      expect(check.samples.map(({ scale }) => scale)).toEqual([...scales]);
      for (const sample of check.samples) {
        expect(sample.cost.statements).toBeGreaterThan(0);
        expect(Number.isFinite(sample.cost.rows)).toBe(true);
        expect(Number.isFinite(sample.cost.sharedHit)).toBe(true);
        expect(Number.isFinite(sample.cost.sharedRead)).toBe(true);
      }
      console.info(JSON.stringify(check));
    }
  }
}, 600_000);
