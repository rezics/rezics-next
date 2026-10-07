import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryRoot } from '../../scripts/ops/migrate.ts';
import type { ReleaseManifest } from '../../scripts/dev/release-manifest.ts';
import { checkProductionEnv } from '../../scripts/ops/production-env.ts';
import { prepareImageContext, runtimeRoles } from '../../scripts/ops/release-images.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph } from '../../services/main/src/modules/work/activate.ts';

/** Values qualify only an isolated container startup, never production opening. */
function smokeEnvironment(postgres: string, secret: string): Record<string, string> {
  return {
    ACCOUNT_DATABASE_URL: `postgres://account:${secret}@${postgres}/account`,
    ACCESS_DATABASE_URL: `postgres://access:${secret}@${postgres}/access`,
    CONTENT_DATABASE_URL: `postgres://content:${secret}@${postgres}/content`,
    MAIN_RELAY_DATABASE_URL: `postgres://relay:${secret}@${postgres}/relay`,
    ACCOUNT_ACCESS_DATABASE_URL: `postgres://access:${secret}@${postgres}/access`,
    ACCOUNT_RELAY_DATABASE_URL: `postgres://relay:${secret}@${postgres}/relay`,
    ACCOUNT_BASE_URL: 'https://accounts.rezics.com',
    ACCOUNT_ISSUER: 'https://accounts.rezics.com/api/auth',
    ACCOUNT_MAIN_RESOURCE: 'https://main.rezics.com',
    ACCOUNT_SECRET: secret,
    ACCOUNT_MAIN_CLIENT_SECRET: secret,
    FUSEKI_TITLE_ADMISSION_KEY: '5db75dc8f93220c9a68776fc8b1f3c3c5db75dc8f93220c9a68776fc8b1f3c3c',
    ACCOUNT_TURNSTILE_MODE: 'cloudflare',
    ACCOUNT_TURNSTILE_SECRET_KEY: secret,
    ACCOUNT_SMTP_HOST: 'smtp.rezics.com',
    ACCOUNT_SMTP_PORT: '587',
    ACCOUNT_SMTP_REQUIRE_TLS: 'true',
    ACCOUNT_EMAIL_FROM: 'REZICS <accounts@rezics.com>',
    SAFETY_PRIMARY_ACCOUNT: 'isolated-primary-subject',
    SAFETY_BACKUP_ACCOUNT: 'isolated-backup-subject',
    MAIN_REQUIRED_MEDIA_MATCHER: 'none',
  };
}

function mainSmokeEnvironment(
  env: Record<string, string>,
  graph: string,
  objects: string,
  secret: string,
) {
  return {
    ...env,
    FUSEKI_URL: `http://${graph}:3030/rezics/`,
    FUSEKI_MAINTENANCE_TOKEN: secret,
    FUSEKI_COMMAND_TOKEN: secret,
    FUSEKI_TITLE_ADMISSION_KEY: env.FUSEKI_TITLE_ADMISSION_KEY!,
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
}

function imageScript(image: string, network: string, variables: string[], script: string) {
  return spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      network,
      ...variables,
      '--entrypoint',
      'bun',
      image,
      '-e',
      `await Bun.write('/tmp/production.env', Object.entries(process.env).map(([key, value]) => \`\${key}=\${value}\`).join('\\n') + '\\n');
     const child = Bun.spawn([process.execPath, ${JSON.stringify(script)}, '/tmp/production.env'], { stdout: 'inherit', stderr: 'inherit' });
     process.exit(await child.exited);`,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
}

test('isolated image smoke inputs satisfy every runtime production guard', () => {
  const secret = 'a'.repeat(64);
  const env = mainSmokeEnvironment(
    smokeEnvironment('isolated-postgres', secret),
    'isolated-graph',
    'isolated-objects',
    secret,
  );
  for (const role of runtimeRoles) expect(() => checkProductionEnv(env, [role])).not.toThrow();
});

test('release image context excludes development data and credentials', async () => {
  const directory = join(repositoryRoot, '.temp/image-context-test');
  try {
    await prepareImageContext(directory);
    for (const path of ['.temp', 'node_modules', 'services/main/.env.example', 'tests/fixtures']) {
      expect(Bun.file(join(directory, path)).size).toBe(0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pinned runtime images reproduce identities and satisfy production startup contracts', async () => {
  const logDirectory = join(repositoryRoot, '.temp/image-smoke');
  mkdirSync(logDirectory, { recursive: true });
  const source = spawnSync(
    'git',
    [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${process.env.REZICS_RELEASE_COMMIT ?? 'HEAD'}^{commit}`,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  if (source.error || source.status !== 0)
    throw new Error('Image smoke requires a committed release revision');
  const sourceCommit = source.stdout.trim();
  async function build(number: number) {
    writeFileSync(join(logDirectory, `build-${number}.stdout`), '');
    writeFileSync(join(logDirectory, `build-${number}.stderr`), '');
    const stdout = Bun.file(join(logDirectory, `build-${number}.stdout`));
    const stderr = Bun.file(join(logDirectory, `build-${number}.stderr`));
    const child = Bun.spawn(
      [process.execPath, 'scripts/ops/release-images.ts', '--commit', sourceCommit],
      {
        cwd: repositoryRoot,
        stdout,
        stderr,
        env: process.env,
      },
    );
    if ((await child.exited) !== 0) throw new Error(await stderr.text());
    const path = (await stdout.text()).trim();
    return JSON.parse(readFileSync(path, 'utf8')) as {
      sourceCommit: string;
      images: Record<string, { reference: string; digest: string }>;
    };
  }
  const first = await build(1);
  const second = await build(2);
  expect(first.sourceCommit).toBe(sourceCommit);
  expect(second).toEqual(first);
  const pins = JSON.parse(
    docker([
      'run',
      '--rm',
      '--entrypoint',
      'bun',
      first.images.main!.digest,
      '-e',
      "import { releaseManifest } from './scripts/dev/release-manifest.ts'; console.log(JSON.stringify(releaseManifest));",
    ]),
  ) as ReleaseManifest;
  expect(first.images.fuseki!.reference).toBe(pins.images.fuseki);
  const expectedScopes = JSON.parse(
    docker([
      'run',
      '--rm',
      '--entrypoint',
      'bun',
      first.images.account!.digest,
      '-e',
      "import { resourceScopes } from './services/account/src/oauth-scopes.ts'; console.log(JSON.stringify(resourceScopes));",
    ]),
  ) as string[];
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
        "const r = await Bun.build({ entrypoints: ['infra/release/entrypoint.ts', 'services/main/src/index.ts', 'services/account/src/index.ts', 'services/main/src/relay.ts', 'services/main/src/relay-init.ts', 'scripts/ops/migrate.ts', 'scripts/ops/postgres-preflight.ts', 'services/main/src/telemetry.ts', 'services/main/src/relay-telemetry.ts', 'services/account/src/telemetry.ts', 'services/main/src/modules/media-screen/classifier-process.ts'], target: 'bun' }); if (!r.success) { console.error(r.logs); process.exit(1); }",
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (result.status !== 0) throw new Error(`${role} runtime imports: ${result.stderr}`);
  }
  const native = docker([
    'run',
    '--rm',
    '--entrypoint',
    'bun',
    first.images.main!.digest,
    '-e',
    `const sharp = (await import(Bun.resolveSync('sharp', '/app/services/main/src'))).default;
     const expected = (await Bun.file('/app/services/main/package.json').json()).dependencies.sharp;
     if (sharp.versions.sharp !== expected || !sharp.versions.vips) throw new Error('native image decoder differs from release');
     const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
     const decoded = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
     if (decoded.info.width !== 2 || decoded.info.height !== 2 || decoded.data.length !== 12) throw new Error('native image decode failed');
     console.log(JSON.stringify({ sharp: sharp.versions.sharp, libvips: sharp.versions.vips, decodedBytes: decoded.data.length }));`,
  ]);
  writeFileSync(join(logDirectory, 'native-decoder.json'), native + '\n');
  await accountSmoke(first.images, pins, expectedScopes);
}, 1_200_000);

function docker(args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0)
    throw new Error(`Docker ${args[0]} failed: ${result.stderr || result.error?.message}`);
  if (args[0] === 'logs') return result.stdout + result.stderr;
  return result.stdout.trim();
}

async function accountSmoke(
  images: Record<string, { reference: string; digest: string }>,
  pins: ReleaseManifest,
  expectedScopes: string[],
) {
  const name = `image-smoke-${randomUUID()}`;
  const account = `${name}-account`;
  const main = `${name}-main`;
  const relay = `${name}-relay`;
  const graph = `${name}-graph`;
  const objects = `${name}-objects`;
  const network = `${name}-network`;
  const secret = randomBytes(32).toString('hex');
  const env = smokeEnvironment(name, secret);
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
      pins.images.postgres,
      '-c',
      'max_prepared_transactions=0',
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
    for (const database of ['access', 'relay', 'content', 'account']) {
      docker([
        'exec',
        name,
        'psql',
        '-U',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `CREATE ROLE ${database} LOGIN NOSUPERUSER PASSWORD '${secret}'`,
      ]);
      docker([
        'exec',
        name,
        'psql',
        '-h',
        '127.0.0.1',
        '-U',
        'postgres',
        '-c',
        `CREATE DATABASE ${database} OWNER ${database}`,
      ]);
    }
    docker([
      'exec',
      name,
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'GRANT pg_read_all_stats TO access, content WITH INHERIT TRUE',
    ]);
    const ownerProbe = imageScript(
      images.migrate!.digest,
      network,
      variables,
      'scripts/ops/postgres-preflight.ts',
    );
    expect(ownerProbe.status).toBe(0);
    expect(ownerProbe.stdout).toContain('PostgreSQL owner diagnostics verified');
    writeFileSync(
      join(repositoryRoot, '.temp/image-smoke/postgres-preflight.stdout'),
      ownerProbe.stdout,
    );
    docker([
      'exec',
      name,
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'REVOKE pg_read_all_stats FROM access',
    ]);
    const missingDiagnostics = imageScript(
      images.migrate!.digest,
      network,
      variables,
      'scripts/ops/postgres-preflight.ts',
    );
    expect(missingDiagnostics.status).not.toBe(0);
    expect(missingDiagnostics.stderr).toContain('requires inherited pg_read_all_stats');
    writeFileSync(
      join(repositoryRoot, '.temp/image-smoke/postgres-preflight-denied.stderr'),
      missingDiagnostics.stderr,
    );
    docker([
      'exec',
      name,
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'GRANT pg_read_all_stats TO access WITH INHERIT TRUE',
    ]);
    expect(
      imageScript(images.migrate!.digest, network, variables, 'scripts/ops/postgres-preflight.ts')
        .status,
    ).toBe(0);
    const migrate = () =>
      JSON.parse(
        docker(['run', '--rm', '--network', network, ...variables, images.migrate!.digest])
          .split('\n')
          .at(-1)!,
      ) as { applied: string[] };
    const initialMigration = migrate();
    expect(initialMigration.applied.length).toBeGreaterThan(10);
    writeFileSync(
      join(repositoryRoot, '.temp/image-smoke/migrations.json'),
      JSON.stringify(initialMigration) + '\n',
    );
    expect(migrate().applied).toEqual([]);
    // Existing isolated subjects are not operator appointments or launch qualification.
    for (const subject of [env.SAFETY_PRIMARY_ACCOUNT!, env.SAFETY_BACKUP_ACCOUNT!]) {
      docker([
        'exec',
        name,
        'psql',
        '-U',
        'postgres',
        '-d',
        'account',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES ('${subject}', 'Isolated smoke subject', '${subject}@smoke.rezics.com', true, now(), now())`,
      ]);
      docker([
        'exec',
        name,
        'psql',
        '-U',
        'postgres',
        '-d',
        'access',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `INSERT INTO access.principal (id, account_issuer, account_subject)
         VALUES ('${randomUUID()}', '${env.ACCOUNT_ISSUER}', '${subject}')`,
      ]);
    }
    // An older resource ceiling must gain every installed scope on Account startup.
    docker([
      'exec',
      name,
      'psql',
      '-U',
      'postgres',
      '-d',
      'account',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `INSERT INTO public."oauthResource" (id, identifier, name, "allowedScopes", "createdAt", "updatedAt")
       VALUES ('${randomUUID()}', '${env.ACCOUNT_MAIN_RESOURCE}', 'Main', '["openid"]'::jsonb, now(), now())
       ON CONFLICT (identifier) DO UPDATE SET "allowedScopes" = '["openid"]'::jsonb`,
    ]);
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
    const checkpoint = JSON.parse(
      docker([
        'exec',
        name,
        'psql',
        '-U',
        'postgres',
        '-d',
        'relay',
        '-tAc',
        "SELECT json_build_object('dataEpoch', data_epoch, 'sequence', sequence::text, 'streamScope', stream_scope) FROM relay.checkpoint WHERE consumer = 'main-graph-v1'",
      ]),
    );
    expect(checkpoint).toEqual({
      dataEpoch: '1',
      sequence: '0',
      streamScope: 'urn:rezics:stream:main-rdf',
    });
    writeFileSync(
      join(repositoryRoot, '.temp/image-smoke/relay-init.json'),
      JSON.stringify(checkpoint) + '\n',
    );
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
        if ((await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(2_000) })).ok)
          break;
      } catch {
        /* still starting */
      }
      if (Date.now() > healthDeadline)
        throw new Error(`Account startup failed: ${docker(['logs', account]).slice(-1000)}`);
      await Bun.sleep(250);
    }
    const installedScopes = JSON.parse(
      docker([
        'exec',
        name,
        'psql',
        '-U',
        'postgres',
        '-d',
        'account',
        '-tAc',
        `SELECT "allowedScopes" FROM public."oauthResource" WHERE identifier = '${env.ACCOUNT_MAIN_RESOURCE}'`,
      ]),
    );
    expect(installedScopes).toEqual(expectedScopes);
    writeFileSync(
      join(repositoryRoot, '.temp/image-smoke/account-scopes.json'),
      JSON.stringify(installedScopes) + '\n',
    );
    expect(
      (await fetch(`${origin}/health/live`, { signal: AbortSignal.timeout(2_000) })).status,
    ).toBe(200);
    expect(
      await (await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(2_000) })).json(),
    ).toEqual({
      status: 'ready',
    });
    const missingMigration = docker([
      'exec',
      name,
      'psql',
      '-U',
      'postgres',
      '-d',
      'account',
      '-tAc',
      'WITH removed AS (DELETE FROM public.rezics_local_migration WHERE name = (SELECT name FROM public.rezics_local_migration LIMIT 1) RETURNING name) SELECT name FROM removed',
    ]);
    expect(
      (await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(2_000) })).status,
    ).toBe(503);
    expect(
      (await fetch(`${origin}/health/live`, { signal: AbortSignal.timeout(2_000) })).status,
    ).toBe(200);
    docker([
      'exec',
      name,
      'psql',
      '-U',
      'postgres',
      '-d',
      'account',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `INSERT INTO public.rezics_local_migration(name) VALUES ('${missingMigration}')`,
    ]);
    expect(
      (await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(2_000) })).status,
    ).toBe(200);
    await mainSmoke(images, { name, main, relay, graph, objects, network, secret, env, pins });
  } finally {
    for (const [role, container] of Object.entries({
      main,
      relay,
      account,
      fuseki: graph,
      objects,
      postgres: name,
    })) {
      const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8', timeout: 10_000 });
      writeFileSync(
        join(repositoryRoot, `.temp/image-smoke/${role}.log`),
        `${logs.stdout ?? ''}${logs.stderr ?? ''}`,
      );
    }
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
    pins: ReleaseManifest;
  },
) {
  const { name, main, relay, graph, objects, network, secret, env, pins } = input;
  const titleKey = env.FUSEKI_TITLE_ADMISSION_KEY!;
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
    pins.images.rustfs,
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
  const mainEnv = mainSmokeEnvironment(env, graph, objects, secret);
  const variables = Object.entries(mainEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const envCheck = () =>
    imageScript(images.main!.digest, network, variables, 'scripts/ops/production-env.ts');
  const accepted = envCheck();
  expect(accepted.status).toBe(0);
  writeFileSync(join(repositoryRoot, '.temp/image-smoke/production-env.stdout'), accepted.stdout);
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
      if ((await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(2_000) })).ok) break;
    } catch {
      /* still starting */
    }
    if (Date.now() > readyDeadline)
      throw new Error(`Main startup failed: ${docker(['logs', main]).slice(-2000)}`);
    await Bun.sleep(250);
  }
  expect(
    (await fetch(`${origin}/health/live`, { signal: AbortSignal.timeout(2_000) })).status,
  ).toBe(200);
  expect(
    await (await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(2_000) })).json(),
  ).toMatchObject({ status: 'ready' });
  let searchResponse: Response;
  const searchDeadline = Date.now() + 60_000;
  while (true) {
    searchResponse = await fetch(`${origin}/health/search-ready`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (searchResponse.ok) break;
    if (Date.now() > searchDeadline) throw new Error('Main search readiness timed out');
    await Bun.sleep(250);
  }
  expect(searchResponse.status).toBe(200);
  const searchReady = (await searchResponse.json()) as {
    dataEpoch: string;
    indexGeneration: string;
  };
  writeFileSync(
    join(repositoryRoot, '.temp/image-smoke/main-search-ready.json'),
    JSON.stringify(searchReady) + '\n',
  );
  expect(searchReady.dataEpoch).toBe('1');
  expect(searchReady.indexGeneration).toMatch(/^urn:rezics:text-index-generation:/);
  expect(docker(['inspect', relay, '--format', '{{.State.Running}}'])).toBe('true');
  expect(docker(['logs', relay])).toContain('main_relay_started');
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
  expect(
    (await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(2_000) })).status,
  ).toBe(503);
  expect(
    (await fetch(`${origin}/health/live`, { signal: AbortSignal.timeout(2_000) })).status,
  ).toBe(200);
  const rejected = envCheck();
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain('Production forbids payment provider rows');
  const refusal: Record<string, { exit: number | null; reason: string }> = {};
  for (const role of runtimeRoles) {
    const result = spawnSync(
      'docker',
      ['run', '--rm', '--network', network, ...variables, images[role]!.digest],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Production forbids payment provider rows');
    refusal[role] = { exit: result.status, reason: 'payment provider rows refused' };
  }
  writeFileSync(
    join(repositoryRoot, '.temp/image-smoke/provider-row-refused.json'),
    JSON.stringify(refusal) + '\n',
  );
  docker([
    'exec',
    name,
    'psql',
    '-U',
    'postgres',
    '-d',
    'access',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    "DELETE FROM commerce.payment_provider WHERE id = 'blocked'",
  ]);
  expect(envCheck().status).toBe(0);
  expect(
    (await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(2_000) })).status,
  ).toBe(200);
}
