import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { startWorkerCheck } from './worker-check.ts';

const root = resolve(import.meta.dir, '..');

test('check entry point returns a durable id before the detached check exits, retaining its exit status and log', async () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp/worker-check-test-'));
  const saved = process.env.REZICS_STACK_LEASE;
  process.env.REZICS_STACK_LEASE = 'off';
  try {
    for (const code of [0, 7]) {
      const id = startWorkerCheck(['--local', process.execPath, '-e', `await Bun.sleep(100); console.log('command marker'); process.exit(${code})`], directory);
      const file = join(directory, '.temp/goal/checks/results', `${id}.json`);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(readFileSync(file, 'utf8')).status).toBe('running');
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => { watcher.close(); reject(new Error('detached check did not finish')); }, 5000);
        const inspect = () => {
          const record = JSON.parse(readFileSync(file, 'utf8'));
          if (record.status !== 'finished') return;
          clearTimeout(timer);
          watcher.close();
          try {
            expect(record.exitCode).toBe(code);
            expect(record.runnerPid).toBeGreaterThan(0);
            expect(readFileSync(join(directory, record.log), 'utf8')).toContain('command marker');
            done();
          } catch (error) { reject(error); }
        };
        const watcher = watch(join(file, '..'), inspect);
        inspect();
      });
    }
  } finally {
    if (saved === undefined) delete process.env.REZICS_STACK_LEASE;
    else process.env.REZICS_STACK_LEASE = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});
