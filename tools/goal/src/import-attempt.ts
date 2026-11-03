import { agentAdapter, isAgentCli } from './agents.ts';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AttemptRecord, Profile, Tokens } from './types.ts';
import type { WorkerTasks } from './tasks.ts';
import { makeRecord, measureLog } from './records.ts';
import { defaultPolicy } from './policy.ts';
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
export type StageImportLog = (source: string, destination: string) => void;

function fail(operation: string, path: string, error: unknown): never {
  throw new Error(`${operation} ${path}: ${error instanceof Error ? error.message : String(error)}`);
}

function readImportCapture(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    fail('failed to read import capture', path, error);
  }
}

function readImportCaptureJson(path: string) {
  try {
    return JSON.parse(readImportCapture(path));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('failed to read import capture ')) throw error;
    fail('failed to read import capture', path, error);
  }
}

/** Copy a capture into its durable run path through a sibling temp file, leaving the original in place. */
export function stageImportLog(source: string, destination: string): void {
  const temporary = `${destination}.${process.pid}.staging`;
  try {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, temporary);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    fail('failed to stage import log', destination, error);
  }
}

function invokeStage(stageLog: StageImportLog, source: string, destination: string): void {
  try {
    stageLog(source, destination);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('failed to stage import log ')) throw error;
    fail('failed to stage import log', destination, error);
  }
}

function importLogPath(stateDirectory: string, taskId: string, attempt: number): string {
  return join(stateDirectory, 'runs', taskId, `${attempt}.jsonl`);
}

/** Import recorded work without launching a model or pretending it was routed by today's table. */
export function importAttempt(
  tasks: WorkerTasks,
  log: string,
  options: ImportOptions,
  stageLog: StageImportLog = stageImportLog,
): AttemptRecord {
  const store = tasks.store,
    task = store.task(options.taskId);
  if (
    task.currentAttempt &&
    ['running', 'waiting'].includes(store.attempt({ taskId: task.id, attempt: task.currentAttempt }).state)
  )
    throw new Error('cannot import over a running or waiting attempt');
  const measured = measureLog(readImportCapture(log), {
    policy: tasks.settings.policy ?? defaultPolicy,
    adapter: agentAdapter(options.profile.cli),
    startedAt: options.startedAt,
    endedAt: options.endedAt,
    ...(options.baseline ? { baseline: options.baseline } : {}),
  });
  const table = readRouting(tasks.settings.routingFile, tasks.settings.policy?.routing);
  const previous = task.currentAttempt ? store.attempt({ taskId: task.id, attempt: task.currentAttempt }) : null;
  const previousConfigDirectory = previous
    ? tasks.settings.pools.find((pool) => pool.name === previous.pool)?.configDirectory
    : undefined;
  const attemptNumber = task.currentAttempt + 1;
  const logPath = importLogPath(tasks.settings.stateDirectory, task.id, attemptNumber);
  invokeStage(stageLog, log, logPath);
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
      logPath,
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
export function importRunDirectory(
  tasks: WorkerTasks,
  directory: string,
  stageLog: StageImportLog = stageImportLog,
): AttemptRecord {
  const start = readImportCaptureJson(join(directory, 'meta.start.json'));
  const end = readImportCaptureJson(join(directory, 'meta.end.json'));
  if (
    !isAgentCli(start.cli) ||
    agentAdapter(start.cli).canImport === false ||
    !['low', 'medium', 'high', 'xhigh', 'max'].includes(start.effort) ||
    typeof start.pool !== 'string' ||
    typeof start.task !== 'string' ||
    typeof start.model !== 'string' ||
    typeof start.start !== 'string' ||
    typeof end.end !== 'string' ||
    !Number.isFinite(Date.parse(start.start)) ||
    !Number.isFinite(Date.parse(end.end)) ||
    Date.parse(end.end) < Date.parse(start.start)
  )
    throw new Error('invalid capture metadata');
  const log = join(directory, 'events.jsonl');
  readImportCapture(log);
  const id = crypto.randomUUID();
  const destination = importLogPath(tasks.settings.stateDirectory, id, 1);
  invokeStage(stageLog, log, destination);
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
    id,
  );
  const record = importAttempt(
    tasks,
    log,
    {
      taskId: task.id,
      startedAt: start.start,
      endedAt: end.end,
      profile: { cli: start.cli, model: start.model, effort: start.effort, poolClass: start.cli },
      pool: start.pool,
      outcome: 'stopped',
      tableVersion: 'pre-control-plane',
    },
    (_source, dest) => {
      if (dest !== destination) invokeStage(stageLog, log, dest);
    },
  );
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
