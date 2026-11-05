import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { developmentEnv } from '../../scripts/database.ts';

const root = resolve(import.meta.dir, '../../../..');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Loopback listener has no port');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

/** The owning check supplies one migrated database and search node, never a shared development database. */
test('supported local stack starts the real site and serves media through native admission', async () => {
  const database = process.env.DATABASE_URL;
  if (!database) throw new Error('DATABASE_URL must name the owning check database');
  const [web, issuer, native, kernel] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const origin = (port: number) => `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    REZICS_LOCAL_STACK_WEB_ORIGIN: origin(web),
    REZICS_LOCAL_STACK_ISSUER_ORIGIN: origin(issuer),
    REZICS_LOCAL_STACK_NATIVE_ORIGIN: origin(native),
    REZICS_LOCAL_STACK_KERNEL_ORIGIN: origin(kernel),
  };
  const configuration =
    developmentEnv('', database) +
    `AUTH_ISSUER=${origin(issuer)}\nAUTH_JWKS_URL=${origin(issuer)}/.well-known/jwks.json\n` +
    (process.env.OPENSEARCH_URL ? `OPENSEARCH_URL=${process.env.OPENSEARCH_URL}\n` : '');
  await writeFile(resolve(root, 'services/kernel/.env'), configuration, { mode: 0o600 });
  const run = async (args: string[]) => {
    const child = Bun.spawn(['bun', ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    // Persona output contains credentials. Consume privately and never include stdout in diagnostics.
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    const code = await child.exited;
    await output;
    if (code !== 0) throw new Error(`${args.join(' ')} exited ${code}: ${await errors}`);
    await errors;
  };
  await run(['services/auth/scripts/dev-stack.ts', 'setup']);
  const child = Bun.spawn(['bun', 'services/auth/scripts/dev-stack.ts', 'start'], {
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = new Response(child.stdout).text();
  let diagnostics = '';
  const errors = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr)
      diagnostics = (diagnostics + decoder.decode(chunk, { stream: true })).slice(-16_384);
  })();
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  try {
    const deadline = Date.now() + 240_000;
    let ready = false;
    let lastResponse = 'No HTTP response';
    while (!ready && !exited && Date.now() < deadline) {
      try {
        const response = await fetch(`${origin(web)}/en`, { signal: AbortSignal.timeout(10_000) });
        ready = response.status === 200;
        lastResponse = `${response.status}: ${(await response.text()).slice(0, 4096)}`;
      } catch (error) {
        if (!(error instanceof TypeError || error instanceof DOMException)) throw error;
        lastResponse = error.message;
      }
      if (!ready) await Bun.sleep(1000);
    }
    if (!ready)
      throw new Error(`Local site ${exited ? 'exited' : 'did not become ready'}: ${lastResponse}\n${diagnostics}`);
    const response = await fetch(`${origin(web)}/media/00000000-0000-7000-8000-000000000001/webp-320`);
    expect(response.status).toBe(404);
    const persona = Object.fromEntries(
      (await readFile(resolve(root, '.temp/local-stack/seed.env'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    expect(persona.REZICS_DEV_PERSONA_ACCOUNT).toBeTruthy();
    await mkdir(resolve(root, '.temp/media-site'), { recursive: true });
    await writeFile(resolve(root, '.temp/media-site/visit.json'), JSON.stringify({ origin: origin(web) }));
  } finally {
    if (!exited) child.kill('SIGTERM');
    await child.exited;
    await Promise.all([output, errors]);
  }
}, 360_000);
