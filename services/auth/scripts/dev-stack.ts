/** Explicit loopback-only development composition. Never imported by production entrypoints. */
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { migrate } from './database.ts';

export const root = resolve(import.meta.dir, '../../..');
const state = resolve(root, '.temp/local-stack');
const LOCAL_MEDIA_SOURCE_HOST = 'lain.bgm.tv';
const CONTENT_R2_VARIABLES = [
  'CONTENT_R2_ENDPOINT',
  'CONTENT_R2_BUCKET',
  'CONTENT_R2_ACCESS_KEY_ID',
  'CONTENT_R2_SECRET_ACCESS_KEY',
] as const;
export const origins = {
  web: 'http://127.0.0.1:3000',
  issuer: 'http://127.0.0.1:4200',
  native: 'http://127.0.0.1:3100',
  kernel: 'http://127.0.0.1:4100',
  audience: 'https://api.rezics.test',
};
export const websiteScopes = [
  'openid',
  'offline_access',
  'media:create',
  'media:read_reservation',
  'media:read',
  'media:complete',
  'media:erase',
  'thread:create',
  'post:create',
  'reaction:set',
  'presentation:publish',
  'presentation:activate',
  'order:create',
  'order:read',
  'order:reconcile',
  'account:read',
  'account:update',
  'organization:create',
  'account:manage',
  'account:delete',
];
export const importerScopes = [
  'subject:create',
  'subject:batch_write',
  'statement:propose',
  'source_fence:read',
  'media:import_from_url',
  'media:read_reservation',
  'source_statistic:write',
  'subject:read',
  'context:accept',
  'context:adopt',
];
const personaClient = 'rezics-dev-importer';
export type DevelopmentKeys = {
  secret: string;
  staging: string;
  signing: JWK;
  website: JWK;
  importer: JWK;
  password: string;
  /** Original immutable registration input after an authorized local password rotation. */
  bootstrapPassword?: string;
};

export function developmentRegistrationPassword(keys: DevelopmentKeys): string {
  return keys.bootstrapPassword ?? keys.password;
}

async function privateKey(): Promise<JWK> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  return { ...(await exportJWK(pair.privateKey)), kid: randomUUID(), alg: 'ES256', use: 'sig' };
}
export function publicKey(key: JWK): JWK {
  const { d: _private, key_ops: _operations, ...publicPart } = key;
  return publicPart;
}
export async function privateFile(path: string, value: string) {
  try {
    if ((await readFile(path, 'utf8')) === value) {
      if (((await stat(path)).mode & 0o777) !== 0o600) await chmod(path, 0o600);
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Dotenv retains backslash-escaped quotes inside double quotes; JWK JSON must stay literal. */
export function developmentBindings(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .map(([name, value]) => {
        if (/[\r\n']/.test(value)) throw new Error(`Invalid local binding ${name}`);
        return `${name}='${value}'`;
      })
      .join('\n') + '\n'
  );
}

/** Local API and worker defaults for Bangumi source media; explicit R2 stays the selected backend. */
export function developmentContentBindings(
  env: Readonly<Record<string, string | undefined>>,
  repository = root,
): Readonly<Record<string, string>> {
  const configuredR2 = CONTENT_R2_VARIABLES.filter((variable) => env[variable] !== undefined);
  if (configuredR2.length > 0 && configuredR2.length < CONTENT_R2_VARIABLES.length) {
    const missing = CONTENT_R2_VARIABLES.find((variable) => env[variable] === undefined)!;
    throw new Error(`Incomplete content storage configuration: ${missing}`);
  }

  const currentHosts = env.CONTENT_SOURCE_HOSTS;
  if (currentHosts === '') throw new Error('CONTENT_SOURCE_HOSTS');
  const hosts = currentHosts === undefined ? LOCAL_MEDIA_SOURCE_HOST : currentHosts.split(',').includes(LOCAL_MEDIA_SOURCE_HOST)
    ? currentHosts
    : `${currentHosts},${LOCAL_MEDIA_SOURCE_HOST}`;
  if (hosts.split(',').length > 100) throw new Error('CONTENT_SOURCE_HOSTS');
  const bindings: Record<string, string> = { CONTENT_SOURCE_HOSTS: hosts };
  if (configuredR2.length === CONTENT_R2_VARIABLES.length) {
    if (env.CONTENT_LOCAL_MEDIA_ROOT !== undefined) throw new Error('CONTENT_LOCAL_MEDIA_ROOT');
    return Object.freeze(bindings);
  }

  const mediaRoot = resolve(repository, '.temp/local-stack/content-media');
  if (env.NODE_ENV !== undefined && env.NODE_ENV !== 'development') throw new Error('NODE_ENV');
  if (env.CONTENT_LOCAL_MEDIA_ROOT !== undefined && env.CONTENT_LOCAL_MEDIA_ROOT !== mediaRoot)
    throw new Error('CONTENT_LOCAL_MEDIA_ROOT');
  bindings.NODE_ENV = 'development';
  bindings.CONTENT_LOCAL_MEDIA_ROOT = mediaRoot;
  return Object.freeze(bindings);
}

function updateEnvironmentText(contents: string, values: Readonly<Record<string, string>>): string {
  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const [name, value] of Object.entries(values)) {
    const index = lines.findLastIndex((line) => line.startsWith(`${name}=`));
    if (index === -1) lines.push(`${name}=${value}`);
    else lines[index] = `${name}=${value}`;
  }
  return `${lines.join('\n')}\n`;
}

export async function resetLocalContentMedia(
  repository = root,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const environment = env ?? (await kernelEnvironment());
  const expected = resolve(repository, '.temp/local-stack/content-media');
  const bindings = developmentContentBindings(environment, repository);
  if (bindings.CONTENT_LOCAL_MEDIA_ROOT === undefined) return;
  if (bindings.CONTENT_LOCAL_MEDIA_ROOT !== expected) throw new Error('CONTENT_LOCAL_MEDIA_ROOT');
  const parent = resolve(repository, '.temp/local-stack');
  let parentInfo;
  try {
    parentInfo = await lstat(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('CONTENT_LOCAL_MEDIA_ROOT');
  let rootInfo;
  try {
    rootInfo = await lstat(expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('CONTENT_LOCAL_MEDIA_ROOT');
  await rm(expected, { recursive: true });
}
export async function developmentKeys(directory = state): Promise<DevelopmentKeys> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, 'keys.json');
  try {
    return JSON.parse(await readFile(file, 'utf8')) as DevelopmentKeys;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const keys: DevelopmentKeys = {
    secret: randomBytes(48).toString('base64url'),
    staging: randomBytes(32).toString('base64url'),
    signing: await privateKey(),
    website: await privateKey(),
    importer: await privateKey(),
    password: randomBytes(24).toString('base64url'),
  };
  // Exclusive creation makes concurrent first-run commands converge on one key set.
  try {
    await writeFile(file, JSON.stringify(keys), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return JSON.parse(await readFile(file, 'utf8')) as DevelopmentKeys;
  }
  return keys;
}

/** Journals contain native IDs from the deleted database; retain them outside the next seed's active path. */
export async function retireDevelopmentSeedState(repository = root): Promise<string | undefined> {
  const archives = resolve(repository, '.temp/local-stack/seed-archives');
  await mkdir(archives, { recursive: true, mode: 0o700 });
  const archived = resolve(archives, randomUUID());
  try {
    await rename(resolve(repository, '.temp/cross-media-seed'), archived);
    return archived;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

export async function kernelEnvironment(): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await readFile(resolve(root, 'services/kernel/.env'), 'utf8'))
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const equals = line.indexOf('=');
        return [line.slice(0, equals), line.slice(equals + 1)];
      }),
  );
}
export function localDatabase(url: string): URL {
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname !== '127.0.0.1')
    throw new Error('Local stack requires a PostgreSQL database on 127.0.0.1');
  return parsed;
}
async function authDatabaseUrl() {
  const kernel = await kernelEnvironment();
  const url = localDatabase(kernel.DATABASE_URL!);
  url.pathname = '/rezics_auth';
  return url.href;
}

async function setup() {
  if (process.env.NODE_ENV === 'production') throw new Error('Local stack is development only');
  const env = await kernelEnvironment();
  const kernelUrl = localDatabase(env.DATABASE_URL!);
  const pool = new Pool({ connectionString: kernelUrl.href });
  try {
    // The service has its own database even though development shares one PostgreSQL server.
    if (!(await pool.query("SELECT 1 FROM pg_database WHERE datname='rezics_auth'")).rowCount) {
      try {
        await pool.query('CREATE DATABASE rezics_auth');
      } catch (error) {
        if ((error as { code?: string }).code !== '42P04') throw error;
      }
    }
  } finally {
    await pool.end();
  }
  migrate(await authDatabaseUrl());
  const keys = await developmentKeys();
  const contentBindings = developmentContentBindings(env);
  const kernelEnvFile = resolve(root, 'services/kernel/.env');
  await privateFile(
    kernelEnvFile,
    updateEnvironmentText(await readFile(kernelEnvFile, 'utf8'), contentBindings),
  );
  await privateFile(resolve(state, 'importer.jwk'), JSON.stringify(keys.importer));
  await privateFile(
    resolve(root, 'apps/web/.dev.vars'),
    developmentBindings({
      AUTH_ISSUER: origins.issuer,
      API_RESOURCE: origins.audience,
      WEBSITE_CLIENT_ID: 'rezics-website',
      WEBSITE_CLIENT_KEY: JSON.stringify(keys.website),
      WEBSITE_SCOPES: websiteScopes.join(' '),
      SITE_ORIGINS: origins.web,
      KERNEL_ORIGIN: origins.kernel,
    }),
  );
}

export async function assemble(options?: {
  env: Record<string, string>;
  authDatabaseUrl: string;
  keys: DevelopmentKeys;
}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Local stack is development only');
  await import('reylo/register');
  const [
    auth,
    { createKernel },
    { actionCatalogue },
    { createAccess, accessActionCatalogue },
    { createNativeAccountBindings },
    { readConfig },
    { createAccountManagementReadAccess },
  ] = await Promise.all([
    import('../src/index.ts'),
    import('../../kernel/src/http/kernel.ts'),
    import('../../kernel/src/http/request.ts'),
    import('../../kernel/src/access/index.ts'),
    import('../../kernel/src/access/native-account-bindings.ts'),
    import('../../kernel/src/server.ts'),
    import('../../kernel/src/access/management-source.ts'),
  ]);
  const env = options?.env ?? (await kernelEnvironment());
  const config = readConfig(env);
  localDatabase(config.databaseUrl);
  const kernelPool = new Pool({ connectionString: config.databaseUrl });
  const database = new Pool({ connectionString: options?.authDatabaseUrl ?? (await authDatabaseUrl()) });
  const keys = options?.keys ?? (await developmentKeys());
  const kernel = createKernel({
    pool: kernelPool,
    tokens: config.tokens,
    routeKey: config.routeKey,
    ...(config.receiptKeys ? { receiptKeys: config.receiptKeys } : {}),
  });
  const actions = accessActionCatalogue(actionCatalogue(kernel));
  let service: import('../src/index.ts').AuthService;
  const access = createAccess({
    actions,
    auth: {
      issuer: origins.issuer,
      audience: origins.audience,
      jwksUrl: `${origins.issuer}/.well-known/jwks.json`,
      fetch: async () => service.handler(new Request(`${origins.issuer}/.well-known/jwks.json`)),
    },
  });
  const proofs = auth.createNativeWorkflowProofPorts({ database });
  const bindings = createNativeAccountBindings({
    pool: kernelPool,
    access,
    actions,
    routeKey: config.routeKey,
    referenceKeys: config.tokens,
    auth: () => service,
    proofs: {
      workflow: proofs,
      provisioning: auth.createProvisioningEvidenceVerifier({ database }),
      barriers: auth.createBarrierProofVerifier({ database }),
    },
  });
  const host = await auth.createAuthHost({
    database,
    issuer: origins.issuer,
    audience: origins.audience,
    secret: keys.secret,
    signing: { activeKid: keys.signing.kid!, privateKeys: [keys.signing] },
    stagingKey: Buffer.from(keys.staging, 'base64url'),
    trustedAccess: bindings.trustedAccess,
    access: bindings.workflowPorts,
    siteActions: actions,
    accountManagementReads: createAccountManagementReadAccess({ pool: kernelPool, access }),
    // The local widget and verifier never call Cloudflare. Production composition is unchanged.
    turnstile: {
      secret: 'loopback-only',
      fetch: (async (_url, init) =>
        Response.json({
          success: new URLSearchParams(String(init?.body)).get('response') === 'rezics-local-signup',
          action: 'signup',
          hostname: '127.0.0.1',
        })) as typeof fetch,
    },
  });
  service = host.service;
  await service.internal.registerWebsiteClient({
    publicJwks: { keys: [publicKey(keys.website)] } as import('../src/index.ts').PublicJwks,
    redirectUris: [`${origins.web}/auth/callback`],
    postLogoutRedirectUris: [`${origins.web}/`],
    scopes: websiteScopes,
  });
  await service.internal.registerClient({
    clientId: personaClient,
    firstParty: true,
    scopes: [...new Set([...importerScopes, 'account:manage', 'exposure:open'])],
  });
  await host.start();
  const stop = async () => {
    try {
      await host.stop();
    } finally {
      await kernelPool.end();
    }
  };
  return { host, kernel, access, kernelPool, database, keys, stop };
}

const widgetScript = `window.turnstile={ready:function(callback){callback();},render:function(el,o){const box=document.createElement('span');box.textContent='Local development verification';el.appendChild(box);queueMicrotask(()=>o.callback('rezics-local-signup'));return 'local';},remove:function(){},reset:function(){}};`;

// Explicit M1 additions supplement anonymous GETs; never discover all anonymous POST gates.
const showcaseOpenings = [
  'search', // M1 path 9: mixed works, characters and people.
  'search_advanced', // M1 path 10: filters and POST /v1/subjects:facets.
  'personal_library', // M1 paths 2/20: native VN source-statistic writes and the personal Library.
] as const;

export async function openLocalShowcase(
  routes: Iterable<{ method: string; hooks?: { detail?: unknown } }>,
  open: (input: { group: string; key: string }) => Promise<unknown>,
): Promise<void> {
  const groups = new Set<string>(showcaseOpenings);
  for (const route of routes) {
    const detail = route.hooks?.detail as { 'x-exposure'?: string; security?: Record<string, unknown>[] } | undefined;
    if (
      route.method === 'GET' &&
      detail?.security?.some((item) => Object.keys(item).length === 0) &&
      detail['x-exposure']?.startsWith('gate:')
    )
      groups.add(detail['x-exposure'].slice(5));
  }
  for (const group of groups) {
    try {
      // Retain the ordinary command key on retries, including groups discovered by both paths.
      await open({ group, key: `local-public-read:${group}` });
    } catch (cause) {
      throw new Error(
        `Local showcase opening ${group} failed: ${cause instanceof Error ? cause.message : String(cause)}. ` +
          'Resolve the native command failure, then rerun task dev:persona (or task seed:dev).',
        { cause },
      );
    }
  }
}

export async function provisionPersona(composition: Awaited<ReturnType<typeof assemble>>, directory = state) {
  const { host, access, kernelPool, keys, kernel } = composition;
  const { bootstrapGovernance, PLATFORM_RESOURCE } = await import('../../kernel/src/access/bootstrap-governance.ts');
  const { accessCommandAuthorization } = await import('../../kernel/src/request/access.ts');
  const { createExposureCommands } = await import('../../kernel/src/access/gates/catalogue.ts');
  const person = await host.workflows.register({
    key: 'local-developer',
    handle: 'developer',
    email: 'developer@rezics.test',
    password: developmentRegistrationPassword(keys),
  });
  await bootstrapGovernance(kernelPool, person.accountId);
  const signIn = () =>
    host.handler(
      new Request(`${origins.issuer}/signin`, {
        method: 'POST',
        headers: { origin: origins.issuer, 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'developer@rezics.test',
          password: keys.password,
          client_id: personaClient,
          scope: [...new Set([...importerScopes, 'account:manage', 'exposure:open'])],
        }),
      }),
    );
  let signin = await signIn();
  if (!signin.ok) throw new Error(`Local persona sign-in failed: ${signin.status} ${await signin.text()}`);
  let headers = new Headers({
    origin: origins.issuer,
    'content-type': 'application/json',
    cookie: signin.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; '),
  });
  // Install the importer's public key through the ordinary fresh-human credential protocol.
  const key = `local-importer:${keys.importer.kid}`;
  if (
    !(
      await composition.database.query('SELECT 1 FROM auth_public_key WHERE account_id=$1 AND kid=$2', [
        person.accountId,
        keys.importer.kid,
      ])
    ).rowCount
  ) {
    const stage = await host.service.internal.stageCredentialEffect({
      key,
      subjectAccountId: person.accountId,
      headers,
      credential: { kind: 'key', kid: keys.importer.kid!, publicJwk: publicKey(keys.importer) },
    });
    const approved = await host.service.internal.approveCredentialEffect({
      key,
      subjectAccountId: person.accountId,
      headers,
      effectRef: stage.effectRef,
    });
    await host.service.internal.applyCredentialEffect({
      key,
      subjectAccountId: person.accountId,
      headers,
      effectRef: stage.effectRef,
      authorization: approved.reference,
    });
    // Credential installation raises the epoch; acquire a current session before issuing API credentials.
    signin = await signIn();
    if (!signin.ok) throw new Error(`Local persona sign-in failed: ${signin.status}`);
    headers = new Headers({
      origin: origins.issuer,
      'content-type': 'application/json',
      cookie: signin.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; '),
    });
  }
  const token = await host.handler(new Request(`${origins.issuer}/token`, { method: 'POST', headers, body: '{}' }));
  if (!token.ok) throw new Error(`Local persona token failed: ${token.status}`);
  const bearer = ((await token.json()) as { access_token: string }).access_token;
  const context = { pool: kernelPool, deadline: Date.now() + 30_000 };
  const actor = await access.authenticate(bearer, context);
  if (actor.kind !== 'account') throw new Error('Local persona is not an account');
  const exposure = createExposureCommands({ pool: kernelPool, clock: () => new Date() });
  await openLocalShowcase(kernel.routes, async (input) => {
    const authorization = await accessCommandAuthorization(
      access,
      actor,
      'exposure:open',
      PLATFORM_RESOURCE,
      context,
      () => new Error('Local public-read grant denied'),
    );
    await exposure.open({ ...context, actor }, { ...input, authorization });
  });
  await privateFile(
    resolve(directory, 'seed.env'),
    Object.entries({
      REZICS_DEV_PERSONA_ACCOUNT_KEY: resolve(directory, 'importer.jwk'),
      REZICS_DEV_PERSONA_ACCOUNT: person.accountId,
      REZICS_DEV_PERSONA_CLIENT: personaClient,
      AUTH_ORIGIN: origins.issuer,
      KERNEL_ORIGIN: origins.kernel,
    })
      .map(([name, value]) => `${name}=${value}`)
      .join('\n') + '\n',
  );
  return person;
}

function printPersona(keys: DevelopmentKeys, accountId: string) {
  console.log(`Local persona: developer@rezics.test\nPassword: ${keys.password}\nAccount: ${accountId}`);
}

/** Native transport is private; Auth still validates requests at its public issuer. */
export function issuerRequest(request: Request): Request {
  const url = new URL(request.url);
  url.host = new URL(origins.issuer).host;
  return new Request(url, request);
}

async function serveHost() {
  const composition = await assemble();
  try {
    const person = await provisionPersona(composition);
    printPersona(composition.keys, person.accountId);
  } catch (error) {
    await composition.stop();
    throw error;
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 3100,
    fetch: async (request) => {
      if (new URL(request.url).hostname !== '127.0.0.1') return new Response('Loopback only', { status: 403 });
      if (new URL(request.url).pathname === '/local-turnstile.js')
        return new Response(widgetScript, { headers: { 'content-type': 'text/javascript' } });
      return composition.host.handler(issuerRequest(request));
    },
  });
  const stop = async () => {
    await server.stop(true);
    await composition.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  console.log(`Native Auth: ${origins.native} (issuer ${origins.issuer})`);
}

async function launch(action: 'pages' | 'web', args: string[]) {
  const pages = action === 'pages';
  const child = Bun.spawn(
    [
      'bun',
      'run',
      '--cwd',
      pages ? 'apps/auth' : 'apps/web',
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      pages ? '4200' : '3000',
      '--strictPort',
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        AUTH_ORIGIN: origins.native,
        KERNEL_ORIGIN: origins.kernel,
        AUTH_ISSUER: origins.issuer,
        API_RESOURCE: origins.audience,
        PUBLIC_ORIGIN: origins.web,
        SITE_ORIGINS: origins.web,
        WEBSITE_CLIENT_ID: 'rezics-website',
        WEBSITE_SCOPES: websiteScopes.join(' '),
        WEBSITE_CLIENT_KEY: JSON.stringify((await developmentKeys()).website),
        TURNSTILE_SITE_KEY: 'local',
        TURNSTILE_SCRIPT_URL: `${origins.issuer}/local-turnstile.js`,
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    process.exitCode = await child.exited;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function start() {
  const env = { ...process.env, ...(await kernelEnvironment()), KERNEL_HOSTNAME: '127.0.0.1', KERNEL_PORT: '4100' };
  const children = [
    ['bun', 'services/auth/scripts/dev-stack.ts', 'host'],
    ['bun', 'services/auth/scripts/dev-stack.ts', 'pages'],
    ['bun', 'services/auth/scripts/dev-stack.ts', 'web'],
    ['bun', 'run', '--cwd', 'services/kernel', 'dev'],
    ['bun', 'run', '--cwd', 'services/kernel', 'worker'],
  ].map((command) => Bun.spawn(command, { cwd: root, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }));
  let stopping = false;
  const stop = () => {
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const first = await Promise.race(children.map(async (child) => await child.exited));
    const interrupted = stopping;
    stop();
    await Promise.all(children.map((child) => child.exited));
    process.exitCode = interrupted ? 0 : first || 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
if (import.meta.main) {
  try {
    const action = process.argv[2];
    if (action === 'setup') await setup();
    else if (action === 'reset') {
      await resetLocalContentMedia();
      await retireDevelopmentSeedState();
      const keys = await developmentKeys();
      if (keys.bootstrapPassword) {
        delete keys.bootstrapPassword;
        await privateFile(resolve(state, 'keys.json'), JSON.stringify(keys));
      }
      await setup();
    } else if (action === 'host') await serveHost();
    else if (action === 'persona') {
      const composition = await assemble();
      try {
        const person = await provisionPersona(composition);
        printPersona(composition.keys, person.accountId);
      } finally {
        await composition.stop();
      }
    } else if (action === 'pages' || action === 'web') await launch(action, process.argv.slice(3));
    else if (action === 'start') await start();
    else throw new Error('Use setup, start, host, pages, web or persona');
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
