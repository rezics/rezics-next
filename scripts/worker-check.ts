#!/usr/bin/env bun
// Control-plane branches do not carry dev's check runner. Keep the asynchronous entry point available here using
// this checkout's slot-aware remote runner; the launch smoke itself deliberately exercises the runner from dev.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireStackSlot } from './stack-lease.ts';

export type CheckRecord = {
  id: string;
  cwd: string;
  argv: string[];
  status: 'running' | 'finished';
  log: string;
  runnerPid?: number;
  runnerHost: string;
  exitCode?: number;
  reruns: number;
  infrastructureFailure?: string;
  infrastructureFailureFinal?: boolean;
};

function recordFile(root: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`Invalid check id: ${id}`);
  return join(root, '.temp/goal/checks/results', `${id}.json`);
}

function save(record: CheckRecord): void {
  const path = recordFile(record.cwd, record.id);
  mkdirSync(join(record.cwd, '.temp/goal/checks/results'), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function startWorkerCheck(argv: string[], cwd = process.cwd()): string {
  if (argv[0] === '--') argv = argv.slice(1);
  if (argv.length === 0) throw new Error('Usage: worker-check.ts -- <command...>');
  const root = resolve(cwd);
  const id = randomUUID();
  const record: CheckRecord = {
    id, cwd: root, argv, status: 'running', log: `.temp/goal/checks/${id}.log`, runnerHost: hostname(), reruns: 0,
  };
  save(record);
  const descriptor = openSync(join(root, record.log), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [import.meta.path, '--run', id], {
      cwd: root, detached: true, stdio: ['ignore', descriptor, descriptor], env: process.env,
    });
    if (child.pid !== undefined) record.runnerPid = child.pid;
    save(record);
    child.once('error', (error) => {
      record.status = 'finished';
      record.exitCode = 1;
      record.infrastructureFailure = `worker-check: infrastructure failure (${error.message})`;
      record.infrastructureFailureFinal = true;
      save(record);
    });
    child.unref();
  } finally {
    closeSync(descriptor);
  }
  return id;
}

async function execute(argv: string[], cwd: string, remote: boolean): Promise<number> {
  const lease = remote ? undefined : await acquireStackSlot('worker-check', process.env);
  try {
    const command = remote
      ? [process.execPath, join(import.meta.dir, 'remote-check.ts'), cwd, '--', ...argv]
      : argv;
    const child = spawn(command[0]!, command.slice(1), {
      cwd, env: { ...process.env, ...lease?.env }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    return await new Promise<number>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code) => done(code ?? 1));
    });
  } finally {
    await lease?.release();
  }
}

export async function runRecordedCheck(id: string, cwd = process.cwd()): Promise<number> {
  const record = JSON.parse(readFileSync(recordFile(cwd, id), 'utf8')) as CheckRecord;
  record.runnerPid = process.pid;
  save(record);
  const local = record.argv[0] === '--local';
  const argv = local ? record.argv.slice(1) : record.argv;
  const command = argv[0] === '--' ? argv.slice(1) : argv;
  const remote = !local && !!process.env.KERNEL_CHECK_REMOTE && process.env.KERNEL_CHECK_ON_REMOTE !== '1';
  let code = 1;
  for (let run = 0; run < 2; run++) {
    let infrastructure: string | undefined;
    try {
      code = await execute(command, record.cwd, remote);
      if (code !== 0 && remote) {
        infrastructure = readFileSync(join(record.cwd, record.log), 'utf8').split('\n').find((line) =>
          /Permission denied|Connection refused|Connection timed out|No route to host|Could not resolve hostname|rsync.*failed|ssh.*failed|No space left on device|out of memory/i.test(line),
        );
      }
    } catch (error) {
      infrastructure = error instanceof Error ? error.message : String(error);
    }
    if (!infrastructure) break;
    record.infrastructureFailure = `worker-check: infrastructure failure (${infrastructure})`;
    if (run === 1) record.infrastructureFailureFinal = true;
    else record.reruns = 1;
    console.error(`${record.infrastructureFailure}; ${run === 0 ? 'rerunning once' : 'second runner failed'}`);
    save(record);
  }
  record.status = 'finished';
  record.exitCode = code;
  save(record);
  console.log(`check: exit status ${code}`);
  if (code !== 0) console.log(`check: failure summary\n${readFileSync(join(record.cwd, record.log), 'utf8').slice(-4000)}`);
  console.log(`check: log ${record.log}`);
  return code;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--run' && args[1]) process.exitCode = await runRecordedCheck(args[1]);
    else console.log(`check: id ${startWorkerCheck(args)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
