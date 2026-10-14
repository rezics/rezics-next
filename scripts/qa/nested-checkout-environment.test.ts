import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { appEnvironment } from '../dev/config.ts';
import { qaStackEnvironment } from './stack-environment.ts';
import { testLogEnvironment } from './core.ts';

const root = resolve(import.meta.dir, '../..');

test('every QA stack profile saves throw mode in its service environment', () => {
  for (const storage of ['tmpfs', 'persistent', 'scale']) {
    const apps = appEnvironment({ REZICS_STACK_PROFILE: 'qa', REZICS_STACK_STORAGE: storage,
      REZICS_NESTED_POOL_CHECKOUT: 'log' }, resolve(root, '.temp/nonexistent-qa-stack'));
    expect(apps.REZICS_NESTED_POOL_CHECKOUT).toBe('throw');
    const env = qaStackEnvironment({ REZICS_NESTED_POOL_CHECKOUT: 'log' });
    expect(env.REZICS_NESTED_POOL_CHECKOUT).toBe('throw');
  }
  expect(appEnvironment({ REZICS_STACK_PROFILE: 'dev' }, '.temp/nonexistent-dev-stack')
    .REZICS_NESTED_POOL_CHECKOUT).toBeUndefined();
});

test('QA service and owner process environments actually reject a nested checkout', async () => {
  const service = appEnvironment({ REZICS_STACK_PROFILE: 'qa' }, resolve(root, '.temp/nonexistent-qa-stack'));
  // Use only the detector setting from apps.env: its other values are runtime
  // URLs and credentials, unnecessary for this process-start proof.
  for (const env of [{ ...process.env, REZICS_NESTED_POOL_CHECKOUT: service.REZICS_NESTED_POOL_CHECKOUT },
    testLogEnvironment({ ...process.env, REZICS_NESTED_POOL_CHECKOUT: 'log' })]) {
    const child = Bun.spawn(['bun', '-e', `
      import { boundedPool, nestedPoolCheckoutMode, NestedPoolCheckoutError } from './services/main/src/infrastructure/pg-pool.ts';
      if (nestedPoolCheckoutMode() !== 'throw') throw new Error('QA did not enable throw mode');
      const pool = boundedPool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 100 });
      const first = pool.connect().catch(() => undefined);
      try {
        await pool.query('SELECT 1');
        throw new Error('QA accepted a nested checkout');
      } catch (error) {
        if (!(error instanceof NestedPoolCheckoutError)) throw error;
      } finally { await first; await pool.end(); }
    `], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
  }
});
