import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
const requests = [
  ['subject', (id: string) => `/v1/subjects/${id}`],
  ['missing-subject', () => '/v1/subjects/00000000-0000-4000-8000-000000000000'],
] as const;
const accountId = Bun.randomUUIDv7();
const kernelRouteKey = randomBytes(32).toString('base64url');
const sessionKey = randomBytes(32).toString('base64url');
const issuer = `http://127.0.0.1:${await freePort()}`;
const audience = 'https://api.rezics.test';
const signing = await generateKeyPair('ES256', { extractable: true });
const publicJwk = { ...(await exportJWK(signing.publicKey)), kid: 'web-recorder', alg: 'ES256', use: 'sig' };
const privateJwk = { ...(await exportJWK(signing.privateKey)), kid: 'web-recorder', alg: 'ES256' };
let container = '';
let kernel: ReturnType<typeof spawn> | undefined;
let jwks: ReturnType<typeof Bun.serve> | undefined;
let pool: Pool | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

function docker(args: string[]): string {
  const result = Bun.spawnSync(['docker', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`docker ${args.join(' ')} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function waitForDatabase(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const probe = new Pool({ connectionString: url, connectionTimeoutMillis: 1500 });
    try {
      await probe.query('SELECT 1');
      return;
    } catch {
      await Bun.sleep(500);
    } finally {
      await probe.end();
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready.');
}

async function waitForKernel(origin: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 90_000;
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-5000)));
  child.stderr?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-5000)));
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Kernel exited with ${child.exitCode}:\n${output}`);
    try {
      const response = await fetch(`${origin}/v1/subjects/00000000-0000-4000-8000-000000000000`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.status === 404) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error(`Kernel did not become ready:\n${output}`);
}

async function stopKernel(): Promise<void> {
  if (!kernel?.pid) return;
  kernel.kill('SIGTERM');
  await Promise.race([new Promise<void>((resolve) => kernel!.once('exit', () => resolve())), Bun.sleep(10_000)]);
  if (kernel.exitCode === null) kernel.kill('SIGKILL');
  kernel = undefined;
}

async function main(): Promise<void> {
  const kernelBase = '../../../services/kernel';
  const { startPostgresContainer } = await import(`${kernelBase}/scripts/check.ts`);
  const { migrate } = await import(`${kernelBase}/scripts/database.ts`);
  const id = fileURLToPath(new URL('../../../services/kernel/src/server.ts', import.meta.url));
  const containerId = startPostgresContainer();
  container = containerId;
  const port = Number(docker(['port', containerId, '5432/tcp']).split(':').at(-1));
  if (!Number.isInteger(port) || port <= 0) throw new Error('Could not find the disposable PostgreSQL port.');
  const databaseUrl = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
  await waitForDatabase(databaseUrl);
  process.env.DATABASE_URL = databaseUrl;
  migrate(databaseUrl);
  pool = new Pool({ connectionString: databaseUrl });
  await import(new URL('../../../services/kernel/node_modules/reylo/src/register.js', import.meta.url).href);
  const { setupSemantic } = await import(`${kernelBase}/src/semantic/setup.ts`);
  const { bundledRelease } = await import('@rezics/definitions/bundled');
  await setupSemantic(pool, bundledRelease);
  const { routeOf } = await import(`${kernelBase}/src/route/route.ts`);
  const accountRoute = routeOf(accountId);
  if (accountRoute === null) throw new Error('The recording account id is not routable.');
  await pool.query(
    `INSERT INTO access.account (route, account_id, kind, state, content_preferences, minimum_authn_epoch, transaction_id)
     VALUES ($1, $2, 'actor', 'active', '{}', 1, $2)`,
    [accountRoute, accountId],
  );
  const { bootstrapGovernance } = await import(`${kernelBase}/src/access/bootstrap-governance.ts`);
  await bootstrapGovernance(pool, accountId);

  jwks = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(new URL(issuer).port),
    fetch(request) {
      if (new URL(request.url).pathname !== '/jwks') return new Response(null, { status: 404 });
      return Response.json({ keys: [publicJwk] }, { headers: { 'cache-control': 'public, max-age=300' } });
    },
  });
  const kernelPort = await freePort();
  const origin = `http://127.0.0.1:${kernelPort}`;
  kernel = spawn('bun', [id], {
    cwd: resolve(root, 'services/kernel'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      KERNEL_HOSTNAME: '127.0.0.1',
      KERNEL_PORT: String(kernelPort),
      KERNEL_ROUTE_KEY: kernelRouteKey,
      KERNEL_SESSION_KEYS: `1:${sessionKey}`,
      KERNEL_WRITE_RATE_SECRET: randomBytes(32).toString('base64url'),
      AUTH_ISSUER: issuer,
      AUTH_AUDIENCE: audience,
      AUTH_JWKS_URL: `${issuer}/jwks`,
      STRIPE_SECRET_KEY: 'sk_test_recorder',
      STRIPE_WEBHOOK_SECRETS: 'whsec_recorder',
      STRIPE_MANAGED_PAYMENTS: 'false',
      CHECKOUT_SUCCESS_URL: 'https://example.test/success/{ORDER_ID}',
      CHECKOUT_CANCEL_URL: 'https://example.test/cancel/{ORDER_ID}',
      NODE_ENV: 'development',
    },
  });
  await waitForKernel(origin, kernel);
  const token = await new SignJWT({
    client_id: 'web-recorder',
    scope: 'subject:create subject:read',
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'web-recorder', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateJwk);
  const labels = {
    en: 'The Little Prince',
    'zh-Hant': '小王子',
    'zh-Hans': '小王子',
    ja: '星の王子さま',
    ko: '어린 왕자',
    de: 'Der kleine Prinz',
    fr: 'Le Petit Prince',
    es: 'El Principito',
  };
  const created = await fetch(`${origin}/v1/subjects`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
    },
    body: JSON.stringify({ type: 'schema:Book', labels }),
  });
  const creation = (await created.json()) as { subject?: { id?: string } };
  if (created.status !== 201 || !creation.subject?.id)
    throw new Error(`Creating the recording subject returned ${created.status}: ${JSON.stringify(creation)}`);
  const output = join(app, 'src/kernel/recorded');
  await mkdir(output, { recursive: true });
  for (const [name, path] of requests) {
    const response = await fetch(new URL(path(creation.subject.id), origin));
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error(`${path(creation.subject.id)} returned a non-object JSON response (${response.status}).`);
    if (name === 'subject' && !response.ok) throw new Error(`Subject read returned ${response.status}.`);
    if (name === 'missing-subject' && response.status !== 404)
      throw new Error(`Missing subject should return 404, received ${response.status}.`);
    await writeFile(join(output, `${name}.json`), JSON.stringify({ ...body, status: response.status }));
  }
}

try {
  await main();
} finally {
  await stopKernel();
  await pool?.end();
  jwks?.stop(true);
  if (container) docker(['rm', '-f', container]);
}
