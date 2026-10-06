// A sleeping launcher and detached child exercise cleanup without running an engine or dev server.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (!process.argv.includes('--child')) {
  const child = spawn(process.execPath, [import.meta.filename, '--child'], {
    cwd: '/tmp', detached: true, stdio: 'ignore', env: process.env,
  });
  child.unref();
  writeFileSync(join(process.env.GOAL_SLEEP_READY_DIR!, process.env.GOAL_TASK_ID!),
    JSON.stringify({ worker: process.pid, child: child.pid }));
}
setInterval(() => {}, 1000);
