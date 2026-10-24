import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AttemptRecord, Profile, Tokens } from './types.ts';
import type { WorkerTasks } from './tasks.ts';
import { makeRecord, measureLog } from './records.ts';
import { readRouting } from './routing.ts';

export type ImportOptions = {
  taskId: string; startedAt: string; endedAt: string; profile: Profile; pool: string;
  outcome?: AttemptRecord['outcome']; baseline?: Tokens; tableVersion?: string;
  diffLines?: number; changedFiles?: string[]; hostMs?: number;
};
/** Import recorded work without launching a model or pretending it was routed by today's table. */
export function importAttempt(tasks: WorkerTasks, log: string, options: ImportOptions): AttemptRecord {
  const store = tasks.store, task = store.task(options.taskId);
  if (task.currentAttempt && store.attempt({ taskId: task.id, attempt: task.currentAttempt }).state === 'running') throw new Error('cannot import over a running attempt');
  const measured = measureLog(readFileSync(log, 'utf8'), { startedAt: options.startedAt, endedAt: options.endedAt,
    ...(options.baseline ? { baseline: options.baseline } : {}) });
  const table = readRouting(tasks.settings.routingFile);
  const attempt = store.nextAttempt({ taskId: task.id, attempt: task.currentAttempt }, n => ({
    taskId: task.id, attempt: n, state: 'exited', profile: options.profile, pool: options.pool,
    tableVersion: options.tableVersion ?? `imported-before-${table.version}`, experiment: null,
    startedAt: options.startedAt, endedAt: options.endedAt, process: null, auxiliaryProcesses: [],
    logPath: join(tasks.settings.stateDirectory, 'runs', task.id, `${n}.jsonl`), evidencePath: join(tasks.settings.stateDirectory, 'evidence', task.id, String(n)),
    session: measured.session, fixRound: 0, consulted: false, previousFailure: null, failure: null, escalation: 'import',
    before: null, after: null, exitCode: null, result: measured.result, blocker: measured.blocker, approaches: [],
  }));
  mkdirSync(dirname(attempt.logPath), { recursive: true }); copyFileSync(log, attempt.logPath);
  const record = makeRecord(task, attempt, measured, options.outcome ?? 'pending-gate');
  record.diffLines = options.diffLines ?? null; record.changedFiles = options.changedFiles ?? null; record.hostMs = options.hostMs ?? null;
  store.putRecord(record);
  store.event(attempt, 'attempt-imported', { source: log, measurement: options });
  store.updateTask(attempt, t => { t.state = 'stopped'; });
  return record;
}
