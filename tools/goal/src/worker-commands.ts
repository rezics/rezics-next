import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadSettings, createRuntime, type Runtime } from './config.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { WorkerTasks } from './tasks.ts';
import { WorkerJob } from './job.ts';
import { importAttempt, importRunDirectory } from './import-attempt.ts';
import type { LandingQueue, ManagerInbox } from './contracts.ts';
import type { AttemptRecord, Effort, Settings, Tokens } from './types.ts';

export type WorkerCommandOptions = {
  runtime?: Runtime; settings?: Settings; store?: WorkerStore; tasks?: WorkerTasks; landing?: LandingQueue; inbox?: ManagerInbox;
  print?: (value: string) => void; env?: NodeJS.ProcessEnv;
};
/** Tests may inject individual services. Production commands always use the shared runtime. */
export async function runWorkerCommand(command: string, argv: string[], options: WorkerCommandOptions = {}): Promise<number> {
  const settings = options.runtime?.settings ?? options.settings ?? options.tasks?.settings ?? loadSettings({ ...(options.env ? { env: options.env } : {}) });
  mkdirSync(dirname(settings.databasePath), { recursive: true });
  const runtime = options.runtime ?? (!options.store && !options.tasks && !options.landing && !options.inbox ? createRuntime({ settings }) : undefined);
  const store = runtime?.store ?? options.store ?? options.tasks?.store ?? new WorkerStore(openDb(settings.databasePath));
  const tasks = runtime?.tasks ?? options.tasks ?? new WorkerTasks(settings, store);
  const print = options.print ?? console.log;
  const job = runtime?.job ?? new WorkerJob(tasks, options.landing ?? { enqueue() {} }, options.inbox ?? { deliver() {} });
  const env = options.env ?? process.env;
  try {
    // A worker's inherited sequence fences every mutating command before it can dispatch another task or retry itself.
    if (!['status', 'attempts'].includes(command) && env.GOAL_TASK_ID && env.GOAL_ATTEMPT) {
      store.assertCurrent({ taskId: env.GOAL_TASK_ID, attempt: Number(env.GOAL_ATTEMPT) });
    }
    const [arg] = argv;
    if (command === 'dispatch') {
      if (!arg || argv.length !== 1) throw new Error('usage: dispatch <brief>');
      const task = tasks.dispatch(arg); print(task.id); await job.start(task.id);
    } else if (command === 'status') {
      if (argv.length > 1) throw new Error('usage: status [task]');
      print(JSON.stringify(arg ? store.task(arg) : store.tasks(), null, 2));
    } else if (command === 'attempts') {
      if (argv.some(a => a !== '--json')) throw new Error('usage: attempts [--json]');
      print(argv.includes('--json') ? JSON.stringify(store.records(), null, 2) : store.attempts().map(a => `${a.taskId} ${a.attempt} ${a.state} ${a.profile.model}/${a.profile.effort} ${a.pool}`).join('\n'));
    } else if (command === 'retry' || command === 'stop' || command === 'consult') {
      if (!arg || argv.length !== 1) throw new Error(`usage: ${command} <task>`);
      if (command === 'retry') await job.start(arg);
      else if (command === 'stop') await tasks.stop(arg);
      else await job.consultTask(arg);
    } else if (command === 'event') {
      const [taskId, n, kind, body = '{}'] = argv;
      if (!taskId || !n || !kind || argv.length > 4 || !Number.isSafeInteger(Number(n))) throw new Error('usage: event <task> <attempt> <kind> [json]');
      store.event({ taskId, attempt: Number(n) }, kind, JSON.parse(body));
    } else if (command === 'import-attempt') {
      if (!arg) throw new Error('usage: import-attempt <log> (--task <task> | --brief <brief>) --start <ISO> --end <ISO> --pool <pool> --model <model> --effort <effort>');
      if (statSync(arg).isDirectory()) {
        if (argv.length !== 1) throw new Error('capture directories take their metadata from meta.start.json and meta.end.json');
        print(JSON.stringify(importRunDirectory(tasks, arg), null, 2));
        return 0;
      }
      const flags: Record<string, string> = {};
      for (let i = 1; i < argv.length; i += 2) {
        const name = argv[i], value = argv[i + 1];
        if (!name?.startsWith('--') || value === undefined || !['task', 'brief', 'start', 'end', 'pool', 'model', 'effort', 'baseline', 'table-version', 'outcome'].includes(name.slice(2))) throw new Error('invalid import option');
        flags[name.slice(2)] = value;
      }
      for (const name of ['start', 'end', 'pool', 'model', 'effort']) if (!flags[name]) throw new Error(`import requires --${name}`);
      if ((!flags.task && !flags.brief) || (flags.task && flags.brief)) throw new Error('import requires exactly one of --task or --brief');
      if (flags.outcome && !['passed', 'gate-failed', 'stopped', 'cancelled', 'pending-gate'].includes(flags.outcome)) throw new Error('invalid import outcome');
      const pool = settings.pools.find(p => p.name === flags.pool);
      if (!pool || pool.cli === 'claude') throw new Error('unknown worker import pool');
      const profile = { cli: pool.cli, model: flags.model!, effort: flags.effort! as Effort, poolClass: pool.classes[0]! };
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(profile.effort)) throw new Error('invalid effort');
      const taskId = flags.task ?? tasks.dispatch(flags.brief!).id;
      print(JSON.stringify(importAttempt(tasks, arg, { taskId, startedAt: flags.start!, endedAt: flags.end!, profile, pool: pool.name,
        ...(flags.outcome ? { outcome: flags.outcome as AttemptRecord['outcome'] } : {}),
        ...(flags.baseline ? { baseline: JSON.parse(flags.baseline) as Tokens } : {}), ...(flags['table-version'] ? { tableVersion: flags['table-version'] } : {}) }), null, 2));
    } else throw new Error(`unknown worker command: ${command}`);
    await job.drain();
    if (runtime && ['dispatch', 'retry', 'consult'].includes(command)) await runtime.drain();
    return 0;
  } finally { if (!options.runtime && runtime) runtime.close(); else if (!options.store && !options.tasks && !runtime) store.db.close(); }
}
