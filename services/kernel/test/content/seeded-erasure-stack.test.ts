import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { walkSeededAuthorErasure } from '../../../../apps/web/tests/seeded-content-erasure-browser.ts';
import { developmentEnv } from '../../scripts/database.ts';

const root = resolve(import.meta.dir, '../../../..');
const review = resolve(root, '.temp/content-erasure-review');

function port() {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const value = server.port!;
  server.stop(true);
  return value;
}

async function ready(origin: string, child: Bun.Subprocess) {
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Development stack exited with status ${child.exitCode}`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    await Bun.sleep(200);
  }
  throw new Error(`Development stack did not serve ${new URL(origin).pathname}`);
}

test('seeded product erases author content through its served control and default worker', async () => {
  const web = `http://127.0.0.1:${port()}`;
  const issuer = `http://127.0.0.1:${port()}`;
  const kernel = `http://127.0.0.1:${port()}`;
  const searchPort = port();
  const search = `rezics-content-erasure-${crypto.randomUUID()}`;
  const env = {
    ...process.env,
    REZICS_LOCAL_STACK_WEB_ORIGIN: web,
    REZICS_LOCAL_STACK_ISSUER_ORIGIN: issuer,
    REZICS_LOCAL_STACK_NATIVE_ORIGIN: `http://127.0.0.1:${port()}`,
    REZICS_LOCAL_STACK_KERNEL_ORIGIN: kernel,
    KERNEL_SEARCH_CONTAINER: search,
    KERNEL_SEARCH_VOLUME: search,
    KERNEL_SEARCH_PORT: String(searchPort),
  };
  const run = async (args: string[]) => {
    // The persona command prints a password. Keep its stdout out of logs and artifacts.
    const child = Bun.spawn([process.execPath, ...args], { cwd: root, env, stdout: 'ignore', stderr: 'inherit' });
    expect(await child.exited).toBe(0);
  };
  const configuration = developmentEnv('', process.env.DATABASE_URL!)
    .replace(/^AUTH_ISSUER=.*$/m, `AUTH_ISSUER=${issuer}`)
    .replace(/^AUTH_JWKS_URL=.*$/m, `AUTH_JWKS_URL=${issuer}/.well-known/jwks.json`);
  await writeFile(resolve(root, 'services/kernel/.env'), configuration, { mode: 0o600 });
  await run(['run', '--cwd', 'services/kernel', 'search', 'up']);
  let stack: Bun.Subprocess | undefined;
  const database = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await run(['services/auth/scripts/dev-stack.ts', 'setup']);
    await run(['services/auth/scripts/dev-stack.ts', 'persona']);
    stack = Bun.spawn([process.execPath, 'services/auth/scripts/dev-stack.ts', 'start'], {
      cwd: root, env, stdout: 'ignore', stderr: 'inherit',
    });
    await ready(`${issuer}/.well-known/openid-configuration`, stack);
    await ready(`${kernel}/v1/definitions/active`, stack);
    await ready(`${web}/en`, stack);
    const seedEnv = Object.fromEntries(
      (await readFile(resolve(root, '.temp/local-stack/seed.env'), 'utf8'))
        .trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    const { runDevelopmentSeed } = await import('../../../../scripts/datasets/cross-media-seed.ts');
    const seeded = await runDevelopmentSeed({ env: { ...env, ...seedEnv }, root: resolve(root, '.temp/erasure-seed') });
    expect(seeded.state).toBe('complete');
    if (seeded.state !== 'complete') throw new Error(`Development seed stopped at ${seeded.failure.operation}`);
    const threadId = seeded.community.thread.threadId;
    const postId = seeded.community.thread.postId;
    const before = await fetch(`${kernel}/v1/threads/${threadId}`);
    expect(before.status).toBe(200);
    await mkdir(review, { recursive: true });
    await writeFile(resolve(review, 'routes.json'), JSON.stringify({ web, kernel, issuer, threadId, postId,
      source: seeded.community.source, seed: '.temp/erasure-seed/.temp/cross-media-seed/result.json',
      author: 'developer@rezics.test',
    }, null, 2));
    const keys = JSON.parse(await readFile(resolve(root, '.temp/local-stack/keys.json'), 'utf8'));
    await walkSeededAuthorErasure({ web, threadId, password: keys.password, review });
    const rows = await database.query('SELECT body FROM content.revision WHERE post_id=$1', [postId]);
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((row) => row.body === null)).toBe(true);
    const current = await fetch(`${kernel}/v1/posts/${postId}`);
    expect(current.status).toBe(200);
    expect((await current.json()).post).toMatchObject({ availability: 'erased', body: null });
  } finally {
    if (stack) { stack.kill('SIGTERM'); await stack.exited; }
    await database.end();
    await run(['run', '--cwd', 'services/kernel', 'search', 'down']);
  }
}, 1_800_000);
