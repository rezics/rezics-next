import { expect, test } from 'bun:test';

test('work services start after launch and stop before shutdown, in reverse order', async () => {
  const program = `
    import assert from 'node:assert/strict';
    import { DBOS } from '@dbos-inc/dbos-sdk';
    import pg from 'pg';
    import { createWorkClient } from './src/work/client.ts';
    import { composeWork } from './src/work/registry.ts';

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const client = await createWorkClient(process.env.DATABASE_URL, pool);
    const events = [];
    let context;
    const modules = ['first', 'second'].map((name) => ({
      name,
      register(registration) {
        context = registration;
        registration.addService(async () => {
          events.push(name + ' started ' + DBOS.isInitialized());
          return { async stop() { events.push(name + ' stopped ' + DBOS.isInitialized()); } };
        });
      },
    }));
    const work = await composeWork(modules, { databaseUrl: process.env.DATABASE_URL, pool, client });
    assert.deepEqual(events, []);
    assert.throws(() => context.addService(() => ({ async stop() {} })), /after composition/);
    await work.launch();
    assert.deepEqual(events, ['first started true', 'second started true']);
    await work.shutdown();
    assert.deepEqual(events, ['first started true', 'second started true', 'second stopped true', 'first stopped true']);
    await client.close();
    await pool.end();
    console.log('services-ok');
  `;
  const child = Bun.spawn([process.execPath, '-e', program], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, errors).toBe(0);
  expect(output).toContain('services-ok');
}, 30_000);
