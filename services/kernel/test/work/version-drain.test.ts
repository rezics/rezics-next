import { expect, test } from 'bun:test';
import { workerTestEnv } from '../support/worker-env.ts';

test('a superseded worker recovers its original parent and locator child while the active version owns new work and schedules', async () => {
  const prefix = 'version-drain-' + crypto.randomUUID();
  let oldVersion = '';
  for (const phase of ['seed', 'current', 'reject-active', 'reject-unknown', 'drain']) {
    const child = Bun.spawn(
      [process.execPath, import.meta.dir + '/support/version-drain.ts', phase, prefix, oldVersion],
      {
        env: {
          ...process.env,
          ...workerTestEnv(),
          KERNEL_WORKER_MODE: phase === 'seed' || phase === 'current' ? 'active' : 'drain-originals',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    try {
      const [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (phase.startsWith('reject-')) {
        expect(code).not.toBe(0);
        expect(errors).toContain('Historical drain requires an existing, superseded application version');
        continue;
      }
      expect(code, errors).toBe(0);
      const version = /^version ([a-f0-9]{32})$/m.exec(output)?.[1];
      expect(version).toBeDefined();
      if (phase === 'seed') oldVersion = version!;
    } finally {
      child.kill();
    }
  }
}, 100_000);
