import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectedSchemaHead, repositoryRoot } from '../migrate.ts';
import { prepareImageContext, runtimeRoles } from '../release-images.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';

test('G-722 image context excludes development data and credentials', () => {
  const directory = join(repositoryRoot, '.temp/g722-context-test');
  try {
    prepareImageContext(directory);
    for (const path of ['.temp', 'node_modules', 'services/main/.env.example', 'tests/fixtures']) {
      expect(Bun.file(join(directory, path)).size).toBe(0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G-722 pinned runtime builds reproduce identities and resolve every runtime import', async () => {
  const logDirectory = join(repositoryRoot, '.temp/g722-image-check');
  mkdirSync(logDirectory, { recursive: true });
  async function build(number: number) {
    writeFileSync(join(logDirectory, `build-${number}.stdout`), '');
    writeFileSync(join(logDirectory, `build-${number}.stderr`), '');
    const stdout = Bun.file(join(logDirectory, `build-${number}.stdout`));
    const stderr = Bun.file(join(logDirectory, `build-${number}.stderr`));
    const child = Bun.spawn([process.execPath, 'scripts/ops/release-images.ts'], {
      cwd: repositoryRoot,
      stdout,
      stderr,
      env: process.env,
    });
    if ((await child.exited) !== 0) throw new Error(await stderr.text());
    const path = (await stdout.text()).trim();
    return JSON.parse(readFileSync(path, 'utf8')) as {
      images: Record<string, { reference: string; digest: string }>;
    };
  }
  const first = await build(1);
  const second = await build(2);
  expect(second).toEqual(first);
  for (const role of runtimeRoles) {
    const image = first.images[role]!;
    expect(image.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Build's resolver walks runtime imports without starting a writer/service.
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'bun',
        image.digest,
        '-e',
        "const r = await Bun.build({ entrypoints: ['infra/release/entrypoint.ts', 'services/main/src/index.ts', 'services/account/src/index.ts', 'services/main/src/relay.ts', 'services/main/src/relay-init.ts', 'scripts/ops/migrate.ts'], target: 'bun' }); if (!r.success) { console.error(r.logs); process.exit(1); }",
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (result.status !== 0) throw new Error(`${role} runtime imports: ${result.stderr}`);
  }
  await accountSmoke(first.images);
}, 1_200_000);

function docker(args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0)
    throw new Error(`Docker ${args[0]} failed: ${result.stderr}`);
  if (args[0] === 'logs') return result.stdout + result.stderr;
  return result.stdout.trim();
}

async function accountSmoke(images: Record<string, { reference: string; digest: string }>) {
  const name = `g722-smoke-${randomUUID()}`;
  const account = `${name}-account`;
  const main = `${name}-main`;
  const relay = `${name}-relay`;
  const graph = `${name}-graph`;
  const objects = `${name}-objects`;
  const network = `${name}-network`;
  const secret = '8d4cb67658b2d230c437b8a97c2757e18d4cb67658b2d230c437b8a97c2757e1';
  const env = {
    ACCOUNT_DATABASE_URL: `postgres://postgres:${secret}@${name}/account`,
    ACCESS_DATABASE_URL: `postgres://postgres:${secret}@${name}/access`,
    CONTENT_DATABASE_URL: `postgres://postgres:${secret}@${name}/content`,
    MAIN_RELAY_DATABASE_URL: `postgres://postgres:${secret}@${name}/relay`,
    ACCOUNT_BASE_URL: 'https://accounts.rezics.com',
    ACCOUNT_MAIN_RESOURCE: 'https://main.rezics.com',
    ACCOUNT_SECRET: secret,
    ACCOUNT_MAIN_CLIENT_SECRET: secret,
    ACCOUNT_SMTP_HOST: 'smtp.rezics.com',
    ACCOUNT_SMTP_REQUIRE_TLS: 'true',
    ACCOUNT_EMAIL_FROM: 'REZICS <accounts@rezics.com>',
  };
  const variables = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  try {
    docker(['network', 'create', network]);
    docker([
      'run',
      '--detach',
      '--name',
      name,
      '--network',
      network,
      '-e',
      `POSTGRES_PASSWORD=${secret}`,
      'postgres:18.6-trixie@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722',
    ]);
    const deadline = Date.now() + 60_000;
    while (true) {
      const result = spawnSync(
        'docker',
        ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
        { encoding: 'utf8', timeout: 5_000 },
      );
      if (result.status === 0) break;
      if (Date.now() > deadline) throw new Error('Smoke PostgreSQL readiness timed out');
      await Bun.sleep(250);
    }
    for (const database of ['access', 'relay', 'content', 'account'])
      docker([
        'exec',
        name,
        'psql',
        '-h',
        '127.0.0.1',
        '-U',
        'postgres',
        '-c',
        `CREATE DATABASE ${database}`,
      ]);
    const migrate = () =>
      JSON.parse(
        docker(['run', '--rm', '--network', network, ...variables, images.migrate!.digest])
          .split('\n')
          .at(-1)!,
      ) as { applied: string[] };
    expect(migrate().applied.length).toBeGreaterThan(10);
    expect(migrate().applied).toEqual([]);
    // Relay initialization is a successful finite job; a repeated run is safe.
    for (let i = 0; i < 2; i++)
      docker([
        'run',
        '--rm',
        '--network',
        network,
        ...variables,
        '-e',
        'MAIN_RELAY_CONSUMER=main-graph-v1',
        '-e',
        'MAIN_DATA_EPOCH=1',
        images['relay-init']!.digest,
      ]);
    docker([
      'run',
      '--detach',
      '--name',
      account,
      '--network',
      network,
      ...variables,
      '-p',
      '127.0.0.1::3002',
      images.account!.digest,
    ]);
    const port = docker(['port', account, '3002/tcp']).split(':').at(-1)!;
    const origin = `http://127.0.0.1:${port}`;
    const healthDeadline = Date.now() + 60_000;
    while (true) {
      try {
        if ((await fetch(`${origin}/health/ready`)).ok) break;
      } catch {
        /* still starting */
      }
      if (Date.now() > healthDeadline)
        throw new Error(`Account startup failed: ${docker(['logs', account]).slice(-1000)}`);
      await Bun.sleep(250);
    }
    expect((await fetch(`${origin}/health/live`)).status).toBe(200);
    expect(await (await fetch(`${origin}/health/ready`)).json()).toEqual({
      status: 'ready',
      storage: 'ready',
      schemaHead: expectedSchemaHead(repositoryRoot, 'account'),
    });
    docker([
      'exec',
      name,
      'psql',
      '-U',
      'postgres',
      '-d',
      'account',
      '-c',
      "UPDATE public.rezics_release_schema SET head = 'stale' WHERE owner = 'account'",
    ]);
    expect((await fetch(`${origin}/health/ready`)).status).toBe(503);
    expect((await fetch(`${origin}/health/live`)).status).toBe(200);
    await mainSmoke(images, { name, main, relay, graph, objects, network, secret, env });
  } finally {
    // These names belong only to this test; no shared stack is touched.
    spawnSync(
      'docker',
      ['rm', '--force', '--volumes', main, relay, account, graph, objects, name],
      {
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    spawnSync('docker', ['network', 'rm', network], { encoding: 'utf8', timeout: 30_000 });
  }
}

async function mainSmoke(
  images: Record<string, { reference: string; digest: string }>,
  input: {
    name: string;
    main: string;
    relay: string;
    graph: string;
    objects: string;
    network: string;
    secret: string;
    env: Record<string, string>;
  },
) {
  const { name, main, relay, graph, objects, network, secret, env } = input;
  const titleKey = '5db75dc8f93220c9a68776fc8b1f3c3c5db75dc8f93220c9a68776fc8b1f3c3c';
  const capabilities = [
    'FUSEKI_MAINTENANCE_TOKEN',
    'FUSEKI_COMMAND_TOKEN',
    'FUSEKI_TITLE_ADMISSION_KEY',
  ].flatMap((key) => ['-e', `${key}=${key === 'FUSEKI_TITLE_ADMISSION_KEY' ? titleKey : secret}`]);
  docker([
    'run',
    '--detach',
    '--name',
    graph,
    '--network',
    network,
    ...capabilities,
    '-e',
    'JVM_ARGS=-Xms128m -Xmx512m -XX:MaxDirectMemorySize=128m',
    '--tmpfs',
    '/fuseki/databases:mode=0777',
    '-p',
    '127.0.0.1::3030',
    images.fuseki!.digest,
  ]);
  docker([
    'run',
    '--detach',
    '--name',
    objects,
    '--network',
    network,
    '-e',
    `RUSTFS_ACCESS_KEY=${secret}`,
    '-e',
    `RUSTFS_SECRET_KEY=${secret}`,
    '--tmpfs',
    '/data:mode=0777',
    '-p',
    '127.0.0.1::9000',
    'rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff',
  ]);
  const graphPort = docker(['port', graph, '3030/tcp']).split(':').at(-1)!;
  const fuseki = new FusekiClient(`http://127.0.0.1:${graphPort}/rezics/`, secret, secret);
  const storagePort = docker(['port', objects, '9000/tcp']).split(':').at(-1)!;
  const deadline = Date.now() + 60_000;
  let storageError = '';
  while (true) {
    try {
      if (
        (await fuseki.query('ASK {}')).boolean === true &&
        (
          await fetch(`http://127.0.0.1:${storagePort}/health`, {
            signal: AbortSignal.timeout(1_000),
          })
        ).ok
      )
        break;
    } catch (error) {
      storageError = String(error);
    }
    if (Date.now() > deadline)
      throw new Error(
        `Main smoke storage did not start: ${storageError}\nGraph: ${docker(['logs', graph]).slice(-2000)}\nObjects: ${docker(['logs', objects]).slice(-2000)}`,
      );
    await Bun.sleep(250);
  }
  await initializeFreshGraph(fuseki, { dataEpoch: '1', routingEpoch: '1' });
  const mainEnv = {
    ...env,
    FUSEKI_URL: `http://${graph}:3030/rezics/`,
    FUSEKI_MAINTENANCE_TOKEN: secret,
    FUSEKI_COMMAND_TOKEN: secret,
    FUSEKI_TITLE_ADMISSION_KEY: titleKey,
    MAIN_DATA_EPOCH: '1',
    MAIN_ROUTING_EPOCH: '1',
    MAIN_RELAY_CONSUMER: 'main-graph-v1',
    MAIN_OBJECT_DIRECTORY: '/tmp/rezics-objects',
    MAIN_S3_ENDPOINT: `http://${objects}:9000`,
    MAIN_S3_BUCKET: 'rezics-release-test',
    MAIN_S3_REGION: 'us-east-1',
    MAIN_S3_ACCESS_KEY: secret,
    MAIN_S3_SECRET_KEY: secret,
    ACCOUNT_ISSUER: 'https://accounts.rezics.com/api/auth',
    ACCOUNT_JWKS_URL: 'https://accounts.rezics.com/api/auth/jwks',
    ACCOUNT_INTROSPECT_URL: 'https://accounts.rezics.com/api/auth/oauth2/introspect',
    ACCOUNT_MAIN_CLIENT_ID: 'release-main',
  };
  const variables = Object.entries(mainEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const envCheck = () =>
    spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        network,
        ...variables,
        '--entrypoint',
        'bun',
        images.main!.digest,
        '-e',
        "await Bun.write('/tmp/production.env', Object.entries(process.env).map(([key, value]) => `${key}=${value}`).join('\\n') + '\\n'); const child = Bun.spawn([process.execPath, 'scripts/ops/production-env.ts', '/tmp/production.env'], { stdout: 'inherit', stderr: 'inherit' }); process.exit(await child.exited);",
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
  expect(envCheck().status).toBe(0);
  docker([
    'run',
    '--detach',
    '--name',
    relay,
    '--network',
    network,
    ...variables,
    images.relay!.digest,
  ]);
  docker([
    'run',
    '--detach',
    '--name',
    main,
    '--network',
    network,
    ...variables,
    '-p',
    '127.0.0.1::3001',
    images.main!.digest,
  ]);
  const mainPort = docker(['port', main, '3001/tcp']).split(':').at(-1)!;
  const origin = `http://127.0.0.1:${mainPort}`;
  const readyDeadline = Date.now() + 60_000;
  while (true) {
    try {
      if ((await fetch(`${origin}/health/ready`)).ok) break;
    } catch {
      /* still starting */
    }
    if (Date.now() > readyDeadline)
      throw new Error(`Main startup failed: ${docker(['logs', main]).slice(-2000)}`);
    await Bun.sleep(250);
  }
  expect((await fetch(`${origin}/health/live`)).status).toBe(200);
  const ready = (await (await fetch(`${origin}/health/ready`)).json()) as {
    dataEpoch: string;
    indexGeneration: string;
    schemaHeads: Record<string, string>;
  };
  expect(ready.dataEpoch).toBe('1');
  expect(ready.indexGeneration).toMatch(/^urn:rezics:text-index-generation:/);
  expect(Object.keys(ready.schemaHeads).sort()).toEqual(['access', 'content', 'relay']);
  expect(docker(['inspect', relay, '--format', '{{.State.Running}}'])).toBe('true');
  docker([
    'exec',
    name,
    'psql',
    '-U',
    'postgres',
    '-d',
    'access',
    '-c',
    "INSERT INTO commerce.payment_provider(id, kind, callback_key_reference, enabled) VALUES ('blocked', 'fake', 'custody-key', false)",
  ]);
  expect((await fetch(`${origin}/health/ready`)).status).toBe(503);
  expect((await fetch(`${origin}/health/live`)).status).toBe(200);
  const rejected = envCheck();
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain('Production forbids payment provider rows');
}
