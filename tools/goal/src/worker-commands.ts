import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadSettings, createRuntime, type Runtime } from './config.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { WorkerTasks } from './tasks.ts';
import { WorkerJob } from './job.ts';
import { importAttempt, importRunDirectory } from './import-attempt.ts';
import { formatUsageReport, report } from './report.ts';
import type { LandingQueue, ManagerInbox } from './contracts.ts';
import type { AttemptRecord, Effort, Settings, Task, Tokens } from './types.ts';

export type WorkerCommandOptions = {
  runtime?: Runtime;
  settings?: Settings;
  store?: WorkerStore;
  tasks?: WorkerTasks;
  landing?: LandingQueue;
  inbox?: ManagerInbox;
  print?: (value: string) => void;
  env?: NodeJS.ProcessEnv;
};
/** Tests may inject individual services. Production commands always use the shared runtime. */
export async function runWorkerCommand(
  command: string,
  argv: string[],
  options: WorkerCommandOptions = {},
): Promise<number> {
  const settings =
    options.runtime?.settings ??
    options.settings ??
    options.tasks?.settings ??
    loadSettings({ ...(options.env ? { env: options.env } : {}) });
  const databasePath = join(settings.stateDirectory, 'goal.sqlite');
  mkdirSync(settings.stateDirectory, { recursive: true });
  const runtime =
    options.runtime ??
    (!options.store && !options.tasks && !options.landing && !options.inbox ? createRuntime({ settings }) : undefined);
  const store = runtime?.store ?? options.store ?? options.tasks?.store ?? new WorkerStore(openDb(databasePath));
  const tasks = runtime?.tasks ?? options.tasks ?? new WorkerTasks(settings, store);
  const print = options.print ?? console.log;
  const job =
    runtime?.job ?? new WorkerJob(tasks, options.landing ?? { enqueue() {} }, options.inbox ?? { deliver() {} });
  const env = options.env ?? process.env;
  try {
    // A worker's inherited sequence fences every mutating command before it can dispatch another task or retry itself.
    if (!['status', 'attempts', 'report'].includes(command) && env.GOAL_TASK_ID && env.GOAL_ATTEMPT) {
      store.assertCurrent({ taskId: env.GOAL_TASK_ID, attempt: Number(env.GOAL_ATTEMPT) });
    }
    const [arg] = argv;
    if (command === 'dispatch') {
      if (!arg || argv.length !== 1) throw new Error('usage: dispatch <brief>');
      const task = tasks.dispatch(arg);
      print(task.id);
      if (task.state === 'held') return 0;
      // The first start only: if the host already started the task, this command leaves it alone.
      await job.start(task.id, { expectedAttempt: 0 });
    } else if (command === 'status') {
      if (argv.length > 1) throw new Error('usage: status [task]');
      const show = (task: Task) =>
        task.state === 'held'
          ? { ...task, waitingFor: (task.brief.after ?? []).filter((id) => store.task(id).state !== 'merged') }
          : task;
      print(JSON.stringify(arg ? show(store.task(arg)) : store.tasks().map(show), null, 2));
    } else if (command === 'attempts') {
      if (argv.some((a) => a !== '--json')) throw new Error('usage: attempts [--json]');
      print(
        argv.includes('--json')
          ? JSON.stringify(store.records(), null, 2)
          : store
              .attempts()
              .map((a) => `${a.taskId} ${a.attempt} ${a.state} ${a.profile.model}/${a.profile.effort} ${a.pool}`)
              .join('\n'),
      );
    } else if (command === 'report') {
      if (argv.some((a) => a !== '--json')) throw new Error('usage: report [--json]');
      const result = report(store.records());
      if (argv.includes('--json')) print(JSON.stringify(result, null, 2));
      else {
        const rate = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
        const duration = (value: number | null) => (value === null ? 'n/a' : `${(value / 60_000).toFixed(1)} min`);
        print(
          [
            `Attempts: ${result.attempts}; tasks: ${result.tasks}; passed: ${result.passedTasks}.`,
            `Attempts per passed task: ${result.attemptsPerPassedTask?.toFixed(2) ?? 'n/a'}; first-attempt pass rate: ${rate(result.firstAttemptPassRate)}.`,
            `Consult hit rate: ${rate(result.consultHitRate)}; early-stop rate: ${rate(result.earlyStopRate)}.`,
            `Wall clock to pass p50/p90: critical path ${duration(result.wallClockToPassMs.criticalPath.p50)}/${duration(result.wallClockToPassMs.criticalPath.p90)}; other ${duration(result.wallClockToPassMs.other.p50)}/${duration(result.wallClockToPassMs.other.p90)}.`,
            ...formatUsageReport(result),
          ].join('\n'),
        );
      }
    } else if (command === 'retry') {
      if (!arg || (argv.length !== 1 && !(argv.length === 3 && argv[1] === '--brief' && argv[2])))
        throw new Error('usage: retry <task> [--brief <file>]');
      await job.start(arg, argv.length === 3 ? { brief: argv[2]! } : {});
    } else if (command === 'stop' || command === 'cancel' || command === 'consult') {
      if (!arg || argv.length !== 1) throw new Error(`usage: ${command} <task>`);
      if (command === 'stop') await tasks.stop(arg);
      else if (command === 'cancel') await tasks.cancel(arg);
      else await job.consultTask(arg);
    } else if (command === 'event') {
      const [taskId, n, kind, body = '{}'] = argv;
      if (!taskId || !n || !kind || argv.length > 4 || !Number.isSafeInteger(Number(n)))
        throw new Error('usage: event <task> <attempt> <kind> [json]');
      store.event({ taskId, attempt: Number(n) }, kind, JSON.parse(body));
    } else if (command === 'import-attempt') {
      if (!arg)
        throw new Error(
          'usage: import-attempt <log> (--task <task> | --brief <brief>) --start <ISO> --end <ISO> --pool <pool> --model <model> --effort <effort>',
        );
      if (statSync(arg).isDirectory()) {
        if (argv.length !== 1)
          throw new Error('capture directories take their metadata from meta.start.json and meta.end.json');
        print(JSON.stringify(importRunDirectory(tasks, arg), null, 2));
        return 0;
      }
      const flags: Record<string, string> = {};
      for (let i = 1; i < argv.length; i += 2) {
        const name = argv[i],
          value = argv[i + 1];
        if (
          !name?.startsWith('--') ||
          value === undefined ||
          ![
            'task',
            'brief',
            'start',
            'end',
            'pool',
            'model',
            'effort',
            'baseline',
            'table-version',
            'outcome',
          ].includes(name.slice(2))
        )
          throw new Error('invalid import option');
        flags[name.slice(2)] = value;
      }
      for (const name of ['start', 'end', 'pool', 'model', 'effort'])
        if (!flags[name]) throw new Error(`import requires --${name}`);
      if ((!flags.task && !flags.brief) || (flags.task && flags.brief))
        throw new Error('import requires exactly one of --task or --brief');
      if (flags.outcome && !['passed', 'gate-failed', 'stopped', 'cancelled', 'pending-gate'].includes(flags.outcome))
        throw new Error('invalid import outcome');
      const pool = settings.pools.find((p) => p.name === flags.pool);
      if (!pool || pool.cli === 'claude') throw new Error('unknown worker import pool');
      const profile = {
        cli: pool.cli,
        model: flags.model!,
        effort: flags.effort! as Effort,
        poolClass: pool.classes[0]!,
      };
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(profile.effort)) throw new Error('invalid effort');
      const taskId = flags.task ?? tasks.dispatch(flags.brief!).id;
      print(
        JSON.stringify(
          importAttempt(tasks, arg, {
            taskId,
            startedAt: flags.start!,
            endedAt: flags.end!,
            profile,
            pool: pool.name,
            ...(flags.outcome ? { outcome: flags.outcome as AttemptRecord['outcome'] } : {}),
            ...(flags.baseline ? { baseline: JSON.parse(flags.baseline) as Tokens } : {}),
            ...(flags['table-version'] ? { tableVersion: flags['table-version'] } : {}),
          }),
          null,
          2,
        ),
      );
    } else throw new Error(`unknown worker command: ${command}`);
    await job.drain();
    if (runtime && ['dispatch', 'retry', 'consult'].includes(command)) await runtime.drain();
    return 0;
  } finally {
    if (!options.runtime && runtime) runtime.close();
    else if (!options.store && !options.tasks && !runtime) store.db.close();
  }
}
