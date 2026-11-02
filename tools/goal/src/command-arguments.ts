import { statSync } from 'node:fs';
import type { AttemptRecord, Tokens } from './types.ts';

export type ImportAttemptFlags = {
  task?: string;
  brief?: string;
  start: string;
  end: string;
  pool: string;
  model: string;
  effort: string;
  outcome?: AttemptRecord['outcome'];
  baseline?: Tokens;
  tableVersion?: string;
};

export type ParsedWorkerCommandArguments =
  | { command: 'dispatch'; brief: string }
  | { command: 'amend'; taskId: string; expectedAttempt: 0; brief: string }
  | { command: 'status'; taskId?: string }
  | { command: 'attempts'; json: boolean }
  | { command: 'report'; flow: boolean; json: boolean; since?: string }
  | {
      command: 'retry';
      taskId: string;
      brief?: string;
      expectedAttempt?: number;
      removeAfter: string[];
      proofStart: boolean;
      releaseProof: boolean;
      freshSession: boolean;
    }
  | { command: 'priority'; action: 'grant'; taskId: string }
  | { command: 'priority'; action: 'revoke'; taskId: string; grantId: string }
  | { command: 'priority'; action: 'set'; taskId: string; priority: 'critical' | 'normal' }
  | { command: 'stop' | 'cancel' | 'consult'; taskId: string }
  | { command: 'retarget'; taskId: string; target: string }
  | { command: 'event'; taskId: string; attempt: number; kind: string; body: unknown }
  | { command: 'import-attempt'; path: string; captureDirectory: true }
  | { command: 'import-attempt'; path: string; captureDirectory: false; flags: ImportAttemptFlags };

/** Parse supported worker arguments once so the CLI can validate before runtime recovery. */
export function parseWorkerCommandArguments(command: string, argv: string[]): ParsedWorkerCommandArguments {
  const [arg] = argv;
  switch (command) {
    case 'dispatch':
      if (!arg || argv.length !== 1) throw new Error('usage: dispatch <brief>');
      return { command, brief: arg };
    case 'amend': {
      let brief: string | undefined;
      let expectedAttempt: 0 | undefined;
      for (let index = 1; index < argv.length; index += 2) {
        const flag = argv[index],
          value = argv[index + 1];
        if (flag === '--brief' && value && brief === undefined) brief = value;
        else if (flag === '--expected-attempt' && value === '0' && expectedAttempt === undefined) expectedAttempt = 0;
        else throw new Error('usage: amend <task> --expected-attempt 0 --brief <file>');
      }
      if (!arg || expectedAttempt !== 0 || !brief)
        throw new Error('usage: amend <task> --expected-attempt 0 --brief <file>');
      return { command, taskId: arg, expectedAttempt, brief };
    }
    case 'status':
      if (argv.length > 1) throw new Error('usage: status [task]');
      return { command, ...(arg ? { taskId: arg } : {}) };
    case 'attempts':
      if (argv.some((value) => value !== '--json')) throw new Error('usage: attempts [--json]');
      return { command, json: argv.includes('--json') };
    case 'report': {
      let since: string | undefined;
      const accepted = new Set(['--json', '--flow', '--since']);
      for (let index = 0; index < argv.length; index++) {
        const flag = argv[index]!;
        if (!accepted.has(flag)) throw new Error('usage: report [--flow] [--since <time>] [--json]');
        if (flag === '--since') {
          since = argv[++index];
          if (!since || !Number.isFinite(Date.parse(since))) throw new Error('--since requires a valid time');
        }
      }
      return {
        command,
        flow: argv.includes('--flow'),
        json: argv.includes('--json'),
        ...(since ? { since } : {}),
      };
    }
    case 'retry': {
      if (!arg)
        throw new Error(
          'usage: retry <task> [--proof-start | --release-proof] [--expected-attempt <n>] [--brief <file>] [--remove-after <task>] [--fresh-session]',
        );
      let brief: string | undefined;
      let expectedAttempt: number | undefined;
      const removeAfter: string[] = [];
      let proofStart = false;
      let releaseProof = false;
      let freshSession = false;
      for (let index = 1; index < argv.length;) {
        if (argv[index] === '--fresh-session' && !freshSession) {
          freshSession = true;
          index++;
          continue;
        }
        if (argv[index] === '--release-proof' && !releaseProof) {
          releaseProof = true;
          index++;
          continue;
        }
        if (argv[index] === '--proof-start' && !proofStart) {
          proofStart = true;
          index++;
          continue;
        }
        const flag = argv[index],
          value = argv[index + 1];
        if (!value) throw new Error(`missing value for ${flag}`);
        if (flag === '--brief' && brief === undefined) brief = value;
        else if (
          flag === '--expected-attempt' &&
          expectedAttempt === undefined &&
          /^(0|[1-9]\d*)$/.test(value) &&
          Number.isSafeInteger(Number(value))
        )
          expectedAttempt = Number(value);
        else if (flag === '--remove-after') removeAfter.push(value);
        else throw new Error(`invalid retry option: ${flag}`);
        index += 2;
      }
      if (freshSession && (releaseProof || proofStart))
        throw new Error('--fresh-session applies only to an ordinary retry');
      if (releaseProof) {
        if (expectedAttempt === undefined || proofStart || brief || removeAfter.length)
          throw new Error('--release-proof requires only --expected-attempt <current-generation>');
      } else if (proofStart && expectedAttempt === undefined) {
        throw new Error('--proof-start requires --expected-attempt');
      } else if (removeAfter.length && !proofStart && expectedAttempt !== 0) {
        throw new Error('--remove-after requires --proof-start with an expected generation (or --expected-attempt 0)');
      }
      return {
        command,
        taskId: arg,
        ...(brief ? { brief } : {}),
        ...(expectedAttempt === undefined ? {} : { expectedAttempt }),
        removeAfter,
        proofStart,
        releaseProof,
        freshSession,
      };
    }
    case 'priority':
      if (argv[0] === 'grant') {
        if (!argv[1] || argv.length !== 2) throw new Error('usage: priority grant <task>');
        return { command, action: 'grant', taskId: argv[1] };
      }
      if (argv[0] === 'revoke') {
        if (!argv[1] || !argv[2] || argv.length !== 3) throw new Error('usage: priority revoke <task> <grant-id>');
        return { command, action: 'revoke', taskId: argv[1], grantId: argv[2] };
      }
      if (!arg || argv.length !== 2 || !['critical', 'normal'].includes(argv[1]!))
        throw new Error(
          'usage: priority <task> critical|normal | priority grant <task> | priority revoke <task> <grant-id>',
        );
      return { command, action: 'set', taskId: arg, priority: argv[1] as 'critical' | 'normal' };
    case 'stop':
    case 'cancel':
    case 'consult':
      if (!arg || argv.length !== 1) throw new Error(`usage: ${command} <task>`);
      return { command, taskId: arg };
    case 'retarget':
      if (!arg || !argv[1] || argv.length !== 2) throw new Error('usage: retarget <task> stabilize');
      return { command, taskId: arg, target: argv[1] };
    case 'event': {
      const [taskId, attemptValue, kind, bodyText = '{}'] = argv;
      if (!taskId || !attemptValue || !kind || argv.length > 4 || !Number.isSafeInteger(Number(attemptValue)))
        throw new Error('usage: event <task> <attempt> <kind> [json]');
      return { command, taskId, attempt: Number(attemptValue), kind, body: JSON.parse(bodyText) as unknown };
    }
    case 'import-attempt': {
      if (!arg)
        throw new Error(
          'usage: import-attempt <log> (--task <task> | --brief <brief>) --start <ISO> --end <ISO> --pool <pool> --model <model> --effort <effort>',
        );
      const captureDirectory = statSync(arg).isDirectory();
      if (captureDirectory) {
        if (argv.length !== 1)
          throw new Error('capture directories take their metadata from meta.start.json and meta.end.json');
        return { command, path: arg, captureDirectory: true };
      }
      const values: Record<string, string> = {};
      for (let index = 1; index < argv.length; index += 2) {
        const name = argv[index],
          value = argv[index + 1];
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
        values[name.slice(2)] = value;
      }
      for (const name of ['start', 'end', 'pool', 'model', 'effort'])
        if (!values[name]) throw new Error(`import requires --${name}`);
      if ((!values.task && !values.brief) || (values.task && values.brief))
        throw new Error('import requires exactly one of --task or --brief');
      if (values.outcome && !['passed', 'gate-failed', 'stopped', 'cancelled', 'pending-gate'].includes(values.outcome))
        throw new Error('invalid import outcome');
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(values.effort!)) throw new Error('invalid effort');
      return {
        command,
        path: arg,
        captureDirectory: false,
        flags: {
          ...(values.task ? { task: values.task } : {}),
          ...(values.brief ? { brief: values.brief } : {}),
          start: values.start!,
          end: values.end!,
          pool: values.pool!,
          model: values.model!,
          effort: values.effort!,
          ...(values.outcome ? { outcome: values.outcome as AttemptRecord['outcome'] } : {}),
          ...(values.baseline ? { baseline: JSON.parse(values.baseline) as Tokens } : {}),
          ...(values['table-version'] ? { tableVersion: values['table-version'] } : {}),
        },
      };
    }
    default:
      throw new Error(`unknown worker command: ${command}`);
  }
}
