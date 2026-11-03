import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  assertGrowthAccessPaths, capture, checkGrowth, costOf, growthViolations,
  type GrowthReport, type Cost,
} from '../support/growth.ts';
import { explainPlanEntries, walkPlanTree } from '../support/growth-plan-walk.ts';
import type { StatementOccurrence } from '../support/growth-report.ts';
import {
  axes, scales, openMemberCountFixture, type MemberCountFixture, type Selected,
} from './support/growth-realm-member-count-maintenance-fixture.ts';

let f: MemberCountFixture;
beforeAll(async () => { f = await openMemberCountFixture(); }, 120_000);
afterAll(async () => { await f?.close(); });
const bounds = { rows: 'constant', statements: 'constant', blocks: 'logarithmic' } as const;
const sourceWrite = /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+community\.realm_member\s*(?:\(|m\b)/i;
const countDelta = /UPDATE\s+community\.realm_member_count\s+SET\s+count\s*=\s*count\s*\+\s*delta/i;
const countLock = /(?:PERFORM|SELECT)\s+(?:1|\*)[\s\S]*FROM\s+community\.realm_member_count[\s\S]*FOR\s+UPDATE/i;

/** A nested count statement must belong to the actual native source statement,
 * hence to its backend and transaction, rather than a later count read. */
function countWork(source: StatementOccurrence, changed: boolean): Cost {
  expect(source.backend).toBeDefined();
  const nested = source.planDocuments.flatMap((document) => explainPlanEntries(document));
  const deltas = nested.filter((entry) => countDelta.test(entry.queryText ?? ''));
  expect(deltas).toHaveLength(changed ? 1 : 0);
  const controls = nested.filter((entry) => countLock.test(entry.queryText ?? '') || countDelta.test(entry.queryText ?? ''));
  expect(controls).toHaveLength(changed ? 3 : 0);
  for (const { plan } of controls) {
    for (const { node } of walkPlanTree(plan)) {
      if (node['Relation Name'] !== 'realm_member_count') continue;
      expect(node['Node Type']).not.toBe('Seq Scan');
      expect(Number(node['Actual Rows'] ?? 0) * Number(node['Actual Loops'] ?? 0)).toBeLessThanOrEqual(1);
      expect(Number(node['Rows Removed by Filter'] ?? 0)).toBe(0);
    }
  }
  // Shared accounting handles actual rows, loops and non-overlapping buffers.
  const plans = controls.map(({ queryText, plan }) => ({ 'Query Text': queryText, Plan: plan }));
  return costOf({ statements: controls.map(({ queryText }) => queryText!), plans, planStatements: plans.map((_, index) => index) });
}

async function cycle(s: Selected) {
  const before = await f.state(s);
  expect(before.open).toBe(0);
  const key = crypto.randomUUID();
  const joined = await f.command(s, 'POST', key);
  const live = await f.state(s);
  expect(live).toEqual({ ...before, count: before.count + 1, version: String(BigInt(before.version) + 1n), open: 1 });
  expect(await f.command(s, 'POST', key)).toBe(joined); // HTTP replay and registered result replay.
  expect(await f.state(s)).toEqual(live);
  await f.command(s, 'POST'); // A fresh generation confirms the same reservation without a source change.
  expect(await f.state(s)).toEqual(live);
  expect((await f.request(s, 'POST', crypto.randomUUID(), s.denied)).status).toBe(403);
  expect(await f.state(s)).toEqual(live);
  f.advance();
  const left = await f.command(s, 'DELETE');
  const closed = await f.state(s);
  expect(closed).toEqual({ ...before, version: String(BigInt(before.version) + 2n), retained: before.retained + 1 });
  await f.complete(left);
  expect((await f.request(s, 'DELETE')).status).toBe(404); // Empty selection never invents removal.
  expect(await f.state(s)).toEqual(closed);
  f.advance();
  await f.command(s, 'POST');
  expect(await f.state(s)).toEqual({ ...closed, count: closed.count + 1, version: String(BigInt(before.version) + 3n), open: 1 });
  // The native close producer physically deletes an interval opened at this T.
  // No test SQL impersonates historical cleanup or account erasure.
  await f.command(s, 'DELETE');
  expect(await f.state(s)).toEqual({ ...closed, version: String(BigInt(before.version) + 4n) });
  f.advance();
}

function assertNativeWork(report: GrowthReport) {
  const countSamples = report.samples.map((sample) => {
    const costs = sample.occurrenceRepetitions.map((run) => {
      expect(run.statements.some((item) => /dbos\./i.test(item.statement))).toBe(true);
      const writes = run.statements.filter((item) => sourceWrite.test(item.statement));
      // Join, no-change confirmation, close UPDATE, rejoin, same-T DELETE.
      expect(writes).toHaveLength(5);
      const work = writes.map((write, index) => countWork(write, index !== 1));
      const total = work.reduce((sum, cost) => ({ rows: sum.rows + cost.rows, blocks: sum.blocks + cost.blocks, statements: sum.statements + cost.statements }), { rows: 0, blocks: 0, statements: 0 });
      expect(total.statements).toBe(12); // Two exact locks and one exact delta for each actual row change.
      expect(total.rows).toBeGreaterThan(0);
      expect(total.blocks).toBeGreaterThan(0);
      return total;
    });
    // Pin every repetition rather than hiding a bad trigger in the workflow median.
    expect(new Set(costs.map((cost) => cost.rows)).size).toBe(1);
    return { scale: sample.scale, cost: costs[0]!, repetitions: costs, relationSizes: sample.relationSizes };
  });
  expect(growthViolations(countSamples, bounds)).toEqual([]);
  assertGrowthAccessPaths(report.name, report.samples, ['community.realm_member', 'community.realm_member_count']);
  console.log(JSON.stringify({ operation: report.name, phases: ['selection', 'registered completion', 'replay'], samples: report.samples.map((sample, index) => ({ scale: sample.scale, native: sample.cost, countTriggers: countSamples[index]!.repetitions })) }));
}

for (const axis of axes) {
  test.serial(`native member-count mutations stay bounded as ${axis} grow independently`, async () => {
    const s = await f.selected();
    const grow = await f.population(s, axis);
    const report = await checkGrowth(f.db, {
      name: `Maintain count with native membership / ${axis}`,
      scales, bounds, includeBackends: true,
      async grow(_db, scale, previous) { await grow(scale, previous); },
      async operation() { await cycle(s); },
    });
    assertNativeWork(report);
  }, 1_200_000);
}

test.serial('a failed native publication rolls back both source and count before registered compensation', async () => {
  const s = await f.selected();
  const before = await f.state(s);
  const release = await f.rejectPublication(s);
  try {
    const result = await capture(f.db, async () => {
      const response = await f.request(s, 'POST');
      expect(response.status).toBe(202);
      const failure = await f.complete(response.body.workflowId!).then(() => null, (error: unknown) => error);
      expect(failure).not.toBeNull();
    }, { includeBackends: true });
    expect(await f.state(s)).toEqual(before);
    expect(result.capture.statementErrorMessages?.some((message) => message?.includes('growth count rollback after source and control'))).toBe(true);
    // Successful source SQL preceded the failed COMMIT: the exact nested count
    // work ran, then PostgreSQL discarded both contributions atomically.
    const sourceIndex = result.capture.statements.findIndex((statement) => sourceWrite.test(statement));
    expect(sourceIndex).toBeGreaterThanOrEqual(0);
    const planDocuments = result.capture.plans.filter((_, index) => result.capture.planStatements?.[index] === sourceIndex);
    const nested = planDocuments.flatMap((document) => explainPlanEntries(document));
    expect(nested.filter((entry) => countDelta.test(entry.queryText ?? ''))).toHaveLength(1);
  } finally {
    await release();
  }
}, 120_000);
