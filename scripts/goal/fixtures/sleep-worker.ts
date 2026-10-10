// A sleeping launcher and detached child exercise cleanup without running an engine or dev server.
// GOAL_WORKER_SCRIPT, when set, replaces that sleep with one recorded exit per launch so wait can
// observe a dropped connection. Absent, the process sleeps as every other lifecycle test expects.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface ScriptedStep { stdout?: string; stderr?: string; release?: string }

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function scriptedStep(): ScriptedStep | undefined {
  const script = process.env.GOAL_WORKER_SCRIPT;
  if (!script) return undefined;
  const steps = JSON.parse(readFileSync(script, 'utf8')) as ScriptedStep[];
  const indexPath = `${script}.index`;
  let index = 0;
  try {
    const parsed = Number(readFileSync(indexPath, 'utf8'));
    if (Number.isInteger(parsed) && parsed >= 0) index = parsed;
  } catch { /* first launch */ }
  writeFileSync(indexPath, String(index + 1));
  const step = steps[index];
  if (!step) {
    process.stderr.write(`no scripted step ${index}\n`);
    process.exit(1);
  }
  return step;
}

if (!process.argv.includes('--child')) {
  const step = scriptedStep();
  if (step) {
    const log = process.env.GOAL_WORKER_LOG;
    if (log) appendFileSync(log, `${JSON.stringify({ argv: process.argv })}\n`);
    const readyDir = process.env.GOAL_SLEEP_READY_DIR;
    const taskId = process.env.GOAL_TASK_ID;
    if (readyDir && taskId) writeFileSync(join(readyDir, taskId), JSON.stringify({ worker: process.pid }));
    if (step.release) {
      const deadline = Date.now() + 60_000;
      while (!existsSync(step.release)) {
        if (Date.now() > deadline) {
          process.stderr.write(`timed out waiting for ${step.release}\n`);
          process.exit(1);
        }
        pause(20);
      }
    }
    if (step.stdout) process.stdout.write(step.stdout);
    if (step.stderr) process.stderr.write(step.stderr);
    process.exit(0);
  }
  const child = spawn(process.execPath, [import.meta.filename, '--child'], {
    cwd: '/tmp', detached: true, stdio: 'ignore', env: process.env,
  });
  child.unref();
  writeFileSync(join(process.env.GOAL_SLEEP_READY_DIR!, process.env.GOAL_TASK_ID!),
    JSON.stringify({ worker: process.pid, child: child.pid }));
}
setInterval(() => {}, 1000);
