import type { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  architectureRepairBrief,
  architectureRepairStatus,
  dispatchArchitectureRepairs,
  recordArchitectureViolations,
  settleArchitectureObservations,
  storeArchitectureObservation,
} from './architecture-repair.ts';
import { parseBrief, productBriefSizeViolation, readBriefSizeSnapshot, readRiskOwnership } from './briefs.ts';
import { openDb } from './db.ts';
import type { Task } from './types.ts';

const ownership = readRiskOwnership(join(import.meta.dir, '../risk-areas.json'));
const line = (file: string) => `rule 4: ${file}: value import "node:fs"`;
const violation = (goal: string, file: string) => ({ goal, manager: goal, line: line(file), paths: [file] });
const fakeTask = (id: string) => ({ id }) as unknown as Task;

function openLines(db: Database): string[] {
  return (
    db.query('SELECT line FROM architecture_violations WHERE resolved_at IS NULL ORDER BY seq').all() as {
      line: string;
    }[]
  ).map((row) => row.line);
}

function observationCount(db: Database): number {
  return (db.query('SELECT COUNT(*) AS n FROM architecture_observations').get() as { n: number }).n;
}

test('a Goal gets one urgent repair per UTC day and none while its repair is open; unpublished lines are not dispatched', () => {
  const db = openDb(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'architecture-repair-'));
  try {
    const onDev = new Set(['dev-1', 'kernel-1']);
    recordArchitectureViolations(db, 'dev-1', [violation('web', 'packages/fixture/a.ts')]);
    recordArchitectureViolations(db, 'kernel-1', [violation('kernel', 'packages/fixture/b.ts')]);
    recordArchitectureViolations(db, 'never-published', [violation('web', 'packages/fixture/c.ts')]);
    const briefs: string[] = [];
    const tick = (day: string, unsettled: string[] = []) =>
      dispatchArchitectureRepairs({
        db,
        unsettled: unsettled.map(fakeTask),
        published: (commit) => onDev.has(commit),
        dispatch: (briefFile) => {
          briefs.push(briefFile);
          const goal = /"goal": "([^"]+)"/.exec(readFileSync(briefFile, 'utf8'))![1];
          return fakeTask(`${goal}-${briefs.length}`);
        },
        notify: () => {},
        reportFailure: (summary) => {
          throw new Error(summary);
        },
        stateDirectory: directory,
        now: new Date(`${day}T09:00:00Z`),
      });

    expect(tick('2026-11-06').map((task) => task.id)).toEqual(['kernel-1', 'web-2']);
    const webBrief = readFileSync(briefs[1]!, 'utf8');
    expect(webBrief).toContain(`- ${line('packages/fixture/a.ts')}`);
    expect(webBrief).not.toContain('packages/fixture/c.ts');
    expect(tick('2026-11-06')).toEqual([]);
    expect(tick('2026-11-07', ['kernel-1', 'web-2'])).toEqual([]);
    // The web repair has settled while its line is still open, so the next day's repair lists that line again.
    expect(tick('2026-11-07', ['kernel-1']).map((task) => task.id)).toEqual(['web-3']);
    expect(tick('2026-11-07', ['kernel-1', 'web-3'])).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the repair brief lists every recorded line, is urgent, carries an honest estimate and is exempt from the size floor', () => {
  const markdown = architectureRepairBrief({
    goal: 'web',
    manager: 'web',
    day: '2026-11-06',
    violations: [
      { line: line('packages/fixture/a.ts'), paths: ['packages/fixture/a.ts'] },
      { line: line('packages/fixture/b.ts'), paths: ['packages/fixture/b.ts'] },
    ],
  });
  expect(markdown).toContain(`- ${line('packages/fixture/a.ts')}`);
  expect(markdown).toContain(`- ${line('packages/fixture/b.ts')}`);
  // Five lines per edge plus ten per file: two edges in two files.
  expect(parseBrief(markdown, ownership)).toMatchObject({
    goal: 'web',
    manager: 'web',
    urgent: true,
    estimate: { lines: 30, files: 2 },
  });
  expect(readBriefSizeSnapshot(markdown)).toMatchObject({ urgent: true, estimateLines: 30 });
  // Urgent briefs are exempt from the 1,200-line floor that ordinary product briefs must meet.
  expect(productBriefSizeViolation(markdown)).toBeUndefined();
});

test('an open line resolves only from a complete audit of a candidate on dev, never from one taken before it was recorded', () => {
  const db = openDb(':memory:');
  const A = line('packages/fixture/a.ts');
  const B = line('packages/fixture/b.ts');
  const LATE = line('packages/fixture/late.ts');
  const onDev = new Set(['c1', 'c2', 'c5']);
  const published = (commit: string) => onDev.has(commit);
  recordArchitectureViolations(db, 'c1', [
    violation('web', 'packages/fixture/a.ts'),
    violation('web', 'packages/fixture/b.ts'),
  ]);
  storeArchitectureObservation(db, 'pending', []);
  storeArchitectureObservation(db, 'c2', [A]);
  settleArchitectureObservations(db, published, false);
  // B is absent from the audit of c2, which is on dev, so it resolves. The audit of an unpublished candidate is kept.
  expect(openLines(db)).toEqual([A]);
  expect(observationCount(db)).toBe(1);
  // This audit of c5 is taken before LATE is recorded, so it cannot judge LATE.
  storeArchitectureObservation(db, 'c5', []);
  recordArchitectureViolations(db, 'unpublished-candidate', [violation('web', 'packages/fixture/late.ts')]);
  settleArchitectureObservations(db, published, true);
  expect(openLines(db)).toEqual([LATE]);
  expect(observationCount(db)).toBe(0);
});

test('status shows each Goal’s open lines and its open repair task until that task settles', () => {
  const db = openDb(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'architecture-repair-'));
  try {
    recordArchitectureViolations(db, 'dev-1', [violation('web', 'packages/fixture/a.ts')]);
    dispatchArchitectureRepairs({
      db,
      unsettled: [],
      published: () => true,
      dispatch: () => fakeTask('web-repair'),
      notify: () => {},
      reportFailure: (summary) => {
        throw new Error(summary);
      },
      stateDirectory: directory,
      now: new Date('2026-11-06T09:00:00Z'),
    });
    const states = new Map([['web-repair', 'running']]);
    const stateOf = (id: string) => states.get(id);
    expect(architectureRepairStatus(db, stateOf)).toEqual([
      {
        goal: 'web',
        manager: 'web',
        openViolations: 1,
        violations: [line('packages/fixture/a.ts')],
        repair: { taskId: 'web-repair', day: '2026-11-06', state: 'running' },
      },
    ]);
    // Settled but still open: the line stays open, and no repair is open any longer.
    states.set('web-repair', 'integrated');
    expect(architectureRepairStatus(db, stateOf)[0]).toMatchObject({ openViolations: 1, repair: null });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
