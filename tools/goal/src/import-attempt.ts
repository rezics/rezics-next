import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AttemptRecord, Profile, Tokens } from './types.ts';
import type { WorkerTasks } from './tasks.ts';
import { makeRecord, measureLog } from './records.ts';
import { readRouting } from './routing.ts';

export type ImportOptions = {
  taskId: string;
  startedAt: string;
  endedAt: string;
  profile: Profile;
  pool: string;
  outcome?: AttemptRecord['outcome'];
  baseline?: Tokens;
  tableVersion?: string;
  diffLines?: number;
  changedFiles?: string[];
  hostMs?: number;
};
/** Import recorded work without launching a model or pretending it was routed by today's table. */
export function importAttempt(tasks: WorkerTasks, log: string, options: ImportOptions): AttemptRecord {
  const store = tasks.store,
    task = store.task(options.taskId);
  if (
    task.currentAttempt &&
    ['running', 'waiting'].includes(store.attempt({ taskId: task.id, attempt: task.currentAttempt }).state)
  )
    throw new Error('cannot import over a running or waiting attempt');
  const measured = measureLog(readFileSync(log, 'utf8'), {
    startedAt: options.startedAt,
    endedAt: options.endedAt,
    ...(options.baseline ? { baseline: options.baseline } : {}),
  });
  const table = readRouting(tasks.settings.routingFile);
  const previous = task.currentAttempt ? store.attempt({ taskId: task.id, attempt: task.currentAttempt }) : null;
  const previousConfigDirectory = previous
    ? tasks.settings.pools.find((pool) => pool.name === previous.pool)?.configDirectory
    : undefined;
  const attempt = store.nextAttempt(
    { taskId: task.id, attempt: task.currentAttempt },
    (n) => ({
      taskId: task.id,
      attempt: n,
      state: 'exited',
      profile: options.profile,
      pool: options.pool,
      tableVersion: options.tableVersion ?? `imported-before-${table.version}`,
      experiment: null,
      startedAt: options.startedAt,
      endedAt: options.endedAt,
      process: null,
      driver: null,
      auxiliaryProcesses: [],
      logPath: join(tasks.settings.stateDirectory, 'runs', task.id, `${n}.jsonl`),
      evidencePath: join(tasks.settings.stateDirectory, 'evidence', task.id, String(n)),
      session: measured.session,
      fixRound: 0,
      consulted: false,
      previousFailure: null,
      failure: null,
      escalation: 'import',
      before: null,
      after: null,
      exitCode: null,
      result: measured.result,
      blocker: measured.blocker,
      approaches: [],
    }),
    previousConfigDirectory,
  );
  mkdirSync(dirname(attempt.logPath), { recursive: true });
  copyFileSync(log, attempt.logPath);
  const record = makeRecord(task, attempt, measured, options.outcome ?? 'pending-gate');
  record.diffLines = options.diffLines ?? null;
  record.changedFiles = options.changedFiles ?? null;
  record.hostMs = options.hostMs ?? null;
  store.putRecord(record);
  store.event(attempt, 'attempt-imported', { source: log, measurement: options });
  store.updateTask(attempt, (t) => {
    t.state = 'stopped';
  });
  return record;
}

/** Import a pre-control-plane capture without modifying its original checkout or requiring a local account mapping. */
export function importRunDirectory(tasks: WorkerTasks, directory: string): AttemptRecord {
  const start = JSON.parse(readFileSync(join(directory, 'meta.start.json'), 'utf8'));
  const end = JSON.parse(readFileSync(join(directory, 'meta.end.json'), 'utf8'));
  if (
    !['codex', 'grok', 'cursor'].includes(start.cli) ||
    !['low', 'medium', 'high', 'xhigh', 'max'].includes(start.effort) ||
    typeof start.pool !== 'string' ||
    typeof start.task !== 'string' ||
    typeof start.model !== 'string' ||
    !Number.isFinite(Date.parse(start.start)) ||
    !Number.isFinite(Date.parse(end.end)) ||
    Date.parse(end.end) < Date.parse(start.start)
  )
    throw new Error('invalid capture metadata');
  const brief: import('./types.ts').Brief = {
    goal: start.task,
    manager: start.task,
    kind: 'implementation',
    paths: [],
    riskAreas: [],
    acceptance: { command: [], tests: [], failing: false },
    estimate: { lines: 0, files: 0 },
    criticalPath: start.criticalPath === true,
    waiting: [],
    after: [],
    inseparable: false,
    citesSources: false,
    hostileInput: false,
    markdown:
      '# Imported execution\n\nOnly historical execution metadata is available. Supply a task contract before redispatch.\n',
  };
  const briefPath = join(tasks.settings.stateDirectory, 'briefs', `${crypto.randomUUID()}.md`);
  mkdirSync(dirname(briefPath), { recursive: true });
  writeFileSync(briefPath, brief.markdown);
  const task = tasks.store.createTask(
    brief,
    { briefPath, worktree: String(start.worktree ?? ''), branch: '', base: '' },
    'implementation',
  );
  const record = importAttempt(tasks, join(directory, 'events.jsonl'), {
    taskId: task.id,
    startedAt: start.start,
    endedAt: end.end,
    profile: { cli: start.cli, model: start.model, effort: start.effort, poolClass: start.cli },
    pool: start.pool,
    outcome: 'stopped',
    tableVersion: 'pre-control-plane',
  });
  const percent =
    typeof start.poolReadingBefore === 'string' ? /(\d+(?:\.\d+)?)%\s+weekly/.exec(start.poolReadingBefore) : null;
  if (percent)
    record.before = {
      pool: start.pool,
      allowanceKey: start.pool,
      at: start.start,
      observedAt: start.start,
      windows: [{ usedPercent: Number(percent[1]), minutes: 10080, resetsAt: null }],
      exhausted: Number(percent[1]) >= 100,
      error: null,
    };
  tasks.store.updateAttempt(record, (attempt) => {
    attempt.before = record.before;
    attempt.exitCode = typeof end.exit === 'number' ? end.exit : null;
  });
  tasks.store.putRecord(record);
  tasks.store.event(record, 'capture-metadata', { start, end });
  return record;
}
