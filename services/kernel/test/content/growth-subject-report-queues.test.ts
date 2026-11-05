import { expect, test } from 'bun:test';
import { checkGrowth, type GrowthReport } from '../support/growth.ts';
import subjectFacts from '../../src/content/read-report-subject.sql';
import readReport from '../../src/content/read-report.sql';
import cataloguePage from '../../src/content/catalogue-report-page.sql';
import targetPage from '../../src/content/page-target-reports.sql';
import {
  createQueueFixture,
  type QueueFixture,
  type QueueScope,
} from './support/growth-subject-report-queues-fixture.ts';

const scales = [32, 256, 2048] as const;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim();
const command = 'bun run --cwd services/kernel check test/content/growth-subject-report-queues.test.ts';
const states = [
  'first',
  'deep',
  'terminal-empty',
  'sparse-status',
  'sparse-current-target',
  'initial-loss',
  'final-loss',
] as const;
type State = (typeof states)[number];

function ids(value: Record<string, any>): string[] {
  return value.reports.map((report: { id: string }) => report.id);
}

/** A barrier failure must fail the test, never leave an unbounded request behind. */
async function entered(barrier: { entered: Promise<unknown> }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      barrier.entered,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native report queue did not reach its SQL barrier')), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function binding(f: QueueFixture, scope: QueueScope) {
  const first = await f.call('GET', f.url(scope));
  expect(first.status, first.text).toBe(200);
  expect(ids(first.value)).toEqual([f.selected[0]!]);
  const cursor = encodeURIComponent(first.value.next);
  const path = `${f.url(scope)}&cursor=${cursor}`;
  const alternate = scope === 'catalogue' ? 'subject' : 'catalogue';
  await expect(f.call('GET', `${f.url(alternate)}&cursor=${cursor}`)).resolves.toMatchObject({ status: 400 });
  for (const [from, to] of [
    ['status=pending', 'status=resolved'],
    ['order=newest', 'order=oldest'],
    ['limit=1', 'limit=2'],
  ])
    await expect(f.call('GET', path.replace(from!, to!))).resolves.toMatchObject({ status: 400 });
  await expect(f.call('GET', `${path}&targetKind=subject`)).resolves.toMatchObject({ status: 400 });
  for (const limit of [0, 51])
    await expect(f.call('GET', `${f.paths[scope]}?limit=${limit}`)).resolves.toMatchObject({ status: 400 });
  await expect(f.call('GET', `${f.paths[scope]}?limit=50`)).resolves.toMatchObject({ status: 200 });
  const other = f.system.actors.other;
  // This persona already holds a subject-local grant, but no Global grant.
  await expect(f.call('GET', f.url(scope), other.bearer)).resolves.toMatchObject({ status: 404 });
  // The same account with a new, narrower real Auth credential cannot reuse the original seal.
  await expect(f.call('GET', path, f.narrower.bearer)).resolves.toMatchObject({ status: 400 });
}

async function operation(f: QueueFixture, scope: QueueScope, state: State) {
  const offset = f.observer.records.length;
  const status = state === 'terminal-empty' || state === 'sparse-status' ? 'resolved' : 'pending';
  const cursor =
    state === 'deep' ? f.cursors[scope].deep : state === 'terminal-empty' ? f.cursors[scope].terminal : undefined;
  const response = await f.call('GET', f.url(scope, status, cursor), undefined, undefined, true);
  const records = f.observer.records.slice(offset);
  const pages = records.filter(
    ({ statement }) => statement === (scope === 'catalogue' ? cataloguePage.sql : targetPage.sql),
  );
  if (state === 'initial-loss') {
    expect(response.status, response.text).toBe(404);
    expect(pages).toHaveLength(0);
    expect(records.filter(({ statement }) => statement === readReport.sql)).toHaveLength(0);
    expect(response.text).not.toContain(f.target);
    return;
  }
  expect(pages).toHaveLength(1);
  const page = scope === 'catalogue' ? cataloguePage : targetPage;
  expect(pages[0]!.parameters[page.params.indexOf('limit')]).toBe(2);
  // Dropped candidates count towards the page; the adapter never discovers a replacement range.
  if (state === 'final-loss') {
    expect(response.status, response.text).toBe(404);
    expect(records.some(({ statement }) => statement === readReport.sql)).toBe(true);
    expect(response.text).not.toContain(f.selected[0]!);
    expect(response.text).not.toContain(f.target);
    return;
  }
  expect(response.status, response.text).toBe(200);
  if (state === 'first' || state === 'deep') {
    expect(ids(response.value)).toEqual([f.selected[state === 'first' ? 0 : 3]!]);
    expect(response.value.reports[0]).toMatchObject({
      target: { kind: 'subject', id: f.target },
      evidence: null,
      revisionId: null,
    });
  } else {
    expect(response.value.reports).toEqual([]);
    expect(response.text).not.toContain(f.target);
    expect(response.text).not.toContain(f.selected[0]!);
  }
  expect(response.value.next).toEqual(state === 'terminal-empty' ? null : expect.any(String));
  expect(response.value).not.toHaveProperty('total');
  if (state === 'sparse-current-target')
    expect(records.filter(({ statement }) => statement === readReport.sql)).toHaveLength(0);
  if (state === 'sparse-status' || state === 'sparse-current-target') {
    // The restored next page proves continuation uses the last examined, dropped identity.
    // This second HTTP read is deliberately inside the operation's physical capture.
    const next = await f.call(
      'GET',
      `${f.url(scope, status)}&cursor=${encodeURIComponent(response.value.next)}`,
      undefined,
      undefined,
      true,
    );
    expect(next.status, next.text).toBe(200);
    if (state === 'sparse-current-target') expect(ids(next.value)).toEqual([f.selected[1]!]);
    else expect(next.value.reports).toEqual([]);
    expect(next.value.next).toBeString();
  }
}

function observations(name: string, report: Pick<GrowthReport, 'samples'>, reached: string) {
  console.info(
    JSON.stringify({
      revision,
      command,
      fixture: 'createQueueFixture',
      operation: name,
      reached,
      samples: report.samples.map(({ scale, cost, repetitions, statementRepetitions }) => ({
        scale,
        cost,
        repetitions,
        statementRepetitions,
      })),
    }),
  );
}

for (const axis of ['population', 'history'] as const) {
  for (const scope of ['catalogue', 'subject'] as const) {
    test(`Native ${scope} Subject report reads keep separate bounded captures as unrelated ${axis} grows`, async () => {
      const f = await createQueueFixture();
      try {
        await binding(f, scope);
        if (axis === 'history') await f.grow('population', 32, 0);
        // Discover the normal current-target snapshot's transaction ordinal without replacing any query.
        const offset = f.observer.records.length;
        await f.call('GET', f.url(scope), undefined, undefined, true);
        const normal = f.observer.records.slice(offset);
        const subjectReads = normal.flatMap((record, index) => (record.statement === subjectFacts.sql ? [index] : []));
        const candidateIndex = subjectReads[scope === 'subject' ? 1 : 0];
        expect(candidateIndex).toBeNumber();
        const candidateBegins = normal
          .slice(0, candidateIndex! + 1)
          .filter(({ statement }) => statement === begin).length;
        for (const state of states) {
          const name = `Native ${scope} Subject reports / ${state} / unrelated ${axis}`;
          try {
            const report = await checkGrowth(f.db, {
              name,
              scales,
              rule: 'series',
              bounds,
              grow: async (_database, scale, previous) => f.grow(axis, scale, previous),
              async operation() {
                await f.restore();
                if (state === 'initial-loss') {
                  // The governance command is concurrent fixture pressure, outside the read-only capture pool.
                  await f.revoke();
                  try {
                    await operation(f, scope, state);
                  } finally {
                    await f.restore();
                  }
                  return;
                }
                if (state !== 'sparse-current-target' && state !== 'final-loss') {
                  await operation(f, scope, state);
                  return;
                }
                const selectedOccurrence = scope === 'subject' ? 2 : 1;
                const holdOccurrence = state === 'final-loss' ? selectedOccurrence + 3 : selectedOccurrence;
                const loss = f.observer.hold({ statement: subjectFacts.sql, occurrence: holdOccurrence }, 'after');
                // A denied candidate skips hydration. The next target transaction is the final fence.
                const restoration =
                  state === 'sparse-current-target'
                    ? f.observer.hold({ statement: begin, occurrence: candidateBegins + 2 }, 'before')
                    : undefined;
                const pending = operation(f, scope, state);
                // Attach immediately so a failed route never becomes an unhandled rejection while held.
                void pending.catch(() => {});
                try {
                  await entered(loss);
                  await f.revoke();
                  loss.release();
                  if (restoration) {
                    await entered(restoration);
                    await f.restore();
                    restoration.release();
                  }
                  await pending;
                } finally {
                  loss.release();
                  restoration?.release();
                  await pending.catch(() => {});
                  await f.restore();
                }
              },
            });
            expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
            observations(name, report, state);
          } catch (error) {
            const failed = error as { samples?: GrowthReport['samples']; message?: string };
            if (failed.samples) observations(name, { samples: failed.samples }, failed.message ?? 'growth assertion');
            throw error;
          }
        }
      } finally {
        await f.close();
      }
    }, 1_800_000);
  }
}
