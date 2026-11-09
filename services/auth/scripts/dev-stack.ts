/** Explicit loopback-only development composition. Never imported by production entrypoints. */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { securityScopeLimit } from '@rezics/auth-contract';
import { bundledRelease, bundledDigest } from '@rezics/definitions/bundled';
import { migrate } from './database.ts';
import { mountedWebsiteConfiguration } from './website-composition.ts';
import { websiteWorkerScopes } from '../../../apps/web/scripts/website-configuration.ts';
import { createAccountTokenProvider, SHOWCASE_IMPORTER_SCOPES } from '../../importer/src/credentials.ts';
import { DEVELOPMENT_SHOWCASE_SCOPES } from '../../../scripts/datasets/showcase-community.ts';
import { developmentCollectionScopes } from '../../../scripts/datasets/development-showcase.ts';
import { developmentPersonalListScopes } from '../../importer/src/showcase-personal-list.ts';
import type { StackSlot } from '../../../scripts/stack-lease.ts';
import { walkStackRequired } from '../../../scripts/stack-run.ts';
import {
  ownerProcessIdentity,
  runDocker,
  retainOriginalAndCleanupFailure,
} from '../../../scripts/compiler-database.ts';
import {
  admitWalkStack,
  firstRedactedDiagnostic,
  issuerJwksUrl,
  SEED_JOURNAL_IDENTITY_FILE,
  seedJournalDatabaseIdentity,
  seedJournalsNameDifferentDatabase,
  stackPhaseLine,
  stackStartPlan,
  walkCommerceProviderEnvironment,
  walkOriginListening,
  walkProcessEnvironment,
  walkPublishedPortAllocated,
  walkStackLimit,
  SEEDED_WEB_READY_PATH,
  walkStackNames,
  walkStackPorts,
  WALK_DOCKER_REMOVE_MS,
  stopSpawned,
  waitUntilWalkReady,
  walkStackPortsAvailable,
  type WalkNames,
} from '../../../scripts/walk-stack.ts';
import { localJwksTransport } from '../../kernel/src/access/membership-work-config.ts';
import {
  developmentDatabaseUrl,
  developmentNativeWebsite,
  disposeDevelopmentNative,
  nativePhase,
  prepareDevelopmentNative,
  withDevelopmentDatabase,
} from './dev-stack-native.ts';

export const root = resolve(import.meta.dir, '../../..');
const state = resolve(root, '.temp/local-stack');
const LOCAL_MEDIA_SOURCE_HOST = 'lain.bgm.tv';
const CONTENT_R2_VARIABLES = [
  'CONTENT_R2_ENDPOINT',
  'CONTENT_R2_BUCKET',
  'CONTENT_R2_ACCESS_KEY_ID',
  'CONTENT_R2_SECRET_ACCESS_KEY',
] as const;
function localOrigin(variable: string, fallback: string): string {
  const value = process.env[variable];
  if (value === undefined) return fallback;
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new Error(`${variable} must be an unauthenticated loopback HTTP origin`);
  return url.origin;
}

function localPort(origin: string): number {
  const url = new URL(origin);
  return Number(url.port || '80');
}

export const origins = {
  web: localOrigin('REZICS_LOCAL_STACK_WEB_ORIGIN', 'http://127.0.0.1:3000'),
  issuer: localOrigin('REZICS_LOCAL_STACK_ISSUER_ORIGIN', 'http://127.0.0.1:4200'),
  native: localOrigin('REZICS_LOCAL_STACK_NATIVE_ORIGIN', 'http://127.0.0.1:3100'),
  kernel: localOrigin('REZICS_LOCAL_STACK_KERNEL_ORIGIN', 'http://127.0.0.1:4100'),
  audience: 'https://api.rezics.test',
};

/** Public JWKS identity is the issuer origin; native Auth is only the local transport. */
export function issuerPublicJwksUrl(issuer: string): string {
  return `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
}

/** Every process in an isolated stack uses the same issuer identity, including its port. */
export function developmentKernelBindings(
  selected: Pick<typeof origins, 'issuer' | 'audience' | 'kernel' | 'native'> = origins,
) {
  return {
    AUTH_ISSUER: selected.issuer,
    AUTH_AUDIENCE: selected.audience,
    AUTH_JWKS_URL: issuerPublicJwksUrl(selected.issuer),
    REZICS_LOCAL_STACK_NATIVE_ORIGIN: selected.native,
    KERNEL_HOSTNAME: '127.0.0.1',
    KERNEL_PORT: String(localPort(selected.kernel)),
  };
}

/** Trusted local composition: fetch only the configured issuer JWKS from native Auth. */
export function developmentJwksFetch(issuerJwksUrl: string, nativeOrigin: string) {
  const fetch = localJwksTransport(
    { REZICS_LOCAL_STACK_NATIVE_ORIGIN: nativeOrigin },
    {
      issuer: new URL(issuerJwksUrl).origin,
      audience: origins.audience,
      jwksUrl: issuerJwksUrl,
    },
  ).fetch;
  if (!fetch) throw new Error('development JWKS fetch requires a distinct native Auth origin');
  return fetch;
}

export function authSecurityScopeConfiguration(siteActions?: Iterable<string>): string {
  return siteActions === undefined ? 'native-no-catalogue' : `catalogue:${securityScopeLimit(siteActions)}`;
}

export function developmentAuthPageBindings(website: { AUTH_SECURITY_SCOPE_CONFIGURATION: string }) {
  return { AUTH_SECURITY_SCOPE_CONFIGURATION: website.AUTH_SECURITY_SCOPE_CONFIGURATION };
}

/** A supplied deployment artifact remains the registration and request ceiling for this stack. */
export function developmentWebsiteScopeConfiguration(
  mounted: { scopes: string[]; WEBSITE_SCOPES: string },
  environment: NodeJS.ProcessEnv = process.env,
): { scopes: string[]; WEBSITE_SCOPES: string; WEBSITE_CONFIGURATION_FILE?: string } {
  if (!environment.WEBSITE_CONFIGURATION_FILE) return mounted;
  // Web starts in apps/web; retain the selected artifact across that working-directory change.
  const WEBSITE_CONFIGURATION_FILE = resolve(root, environment.WEBSITE_CONFIGURATION_FILE);
  const WEBSITE_SCOPES = websiteWorkerScopes({ ...environment, WEBSITE_CONFIGURATION_FILE });
  return { scopes: WEBSITE_SCOPES.split(' '), WEBSITE_SCOPES, WEBSITE_CONFIGURATION_FILE };
}

/** Build the Web launch bindings from the same mounted website scope composition. */
export function developmentWebsiteBindings(
  keys: Pick<DevelopmentKeys, 'website'>,
  website: { scopes: readonly string[]; WEBSITE_CONFIGURATION_FILE?: string },
  deployment: { AUTH_MANAGEMENT_PAGE_ROUTES?: string | undefined } = {
    AUTH_MANAGEMENT_PAGE_ROUTES: process.env.AUTH_MANAGEMENT_PAGE_ROUTES,
  },
) {
  return {
    AUTH_ISSUER: origins.issuer,
    AUTH_MANAGEMENT_PAGE_ROUTES:
      deployment.AUTH_MANAGEMENT_PAGE_ROUTES ??
      JSON.stringify(['/account/rename', '/organizations/members', '/operators/transfer', '/organizations/delete']),
    API_RESOURCE: origins.audience,
    WEBSITE_CLIENT_ID: 'rezics-website',
    WEBSITE_CLIENT_KEY: JSON.stringify(keys.website),
    WEBSITE_SCOPES: website.scopes.join(' '),
    ...(website.WEBSITE_CONFIGURATION_FILE ? { WEBSITE_CONFIGURATION_FILE: website.WEBSITE_CONFIGURATION_FILE } : {}),
    SITE_ORIGINS: origins.web,
    KERNEL_ORIGIN: origins.kernel,
  };
}

/** A purpose-bound server credential connects the site to the same local objects used by native workers. */
export function developmentMediaBindings(
  env: Readonly<Record<string, string | undefined>>,
  keys: Pick<DevelopmentKeys, 'secret'>,
): Readonly<Record<string, string>> {
  if (env.CONTENT_LOCAL_MEDIA_ROOT === undefined) return {};
  return {
    LOCAL_MEDIA_ORIGIN: origins.native,
    LOCAL_MEDIA_TOKEN: createHmac('sha256', keys.secret).update('local-content-media-transport').digest('hex'),
  };
}

/** Build the same mounted Kernel declarations used by the host; no request-time discovery. */
export async function developmentWebsiteConfiguration(env?: Record<string, string>) {
  const environment = env ?? (await kernelEnvironment());
  return await developmentNativeWebsite(environment, async () => {
    const [{ createKernelActionCatalogue }, { readConfig }, { accessActionCatalogue }] = await phase(
      'native-imports',
      () =>
        Promise.all([
          import('../../kernel/src/http/kernel.ts'),
          import('../../kernel/src/server.ts'),
          import('../../kernel/src/access/index.ts'),
        ]),
    );
    const config = await phase('catalogue-configuration', () => readConfig(environment));
    const pool = new Pool({ connectionString: config.databaseUrl });
    try {
      // The reusable projection is produced only by this real native mount, without compiling HTTP handlers.
      const catalogue = await phase('catalogue-native-mount', () =>
        createKernelActionCatalogue({
          pool,
          tokens: config.tokens,
          routeKey: config.routeKey,
          ...(config.receiptKeys ? { receiptKeys: config.receiptKeys } : {}),
        }),
      );
      return await phase('catalogue-website-scopes', () => {
        const siteActions = accessActionCatalogue(catalogue);
        return {
          ...developmentWebsiteScopeConfiguration(mountedWebsiteConfiguration(catalogue)),
          AUTH_SECURITY_SCOPE_CONFIGURATION: authSecurityScopeConfiguration(siteActions.keys()),
        };
      });
    } finally {
      await phase('catalogue-pool-settlement', () => pool.end());
    }
  });
}

export const importerScopes = [...SHOWCASE_IMPORTER_SCOPES];
export const localClientIds = {
  importer: 'rezics-dev-importer',
  showcase: 'rezics-dev-showcase',
  semanticWalk: 'rezics-dev-semantic-walk',
} as const;
/** Exact native scopes for the first-public catalogue and static Zone walk. Grants remain ordinary Access. */
export function semanticWalkClientRegistration() {
  return {
    clientId: localClientIds.semanticWalk,
    firstParty: true,
    scopes: [
      'definitions:read',
      'subject:create',
      'subject:read',
      'statement:propose',
      'statement:delete',
      'statement:restore',
      'context:create',
      'context:read',
      'context:accept',
      'context:adopt',
      'zone:create',
      'zone:read',
      'zone:configure',
      'zone:publish',
      'zone:delete',
      'zone:restore',
      'moderation:takedown',
    ],
  };
}
const personaClient = localClientIds.importer;
const showcaseClient = localClientIds.showcase;
export function localShowcaseClientRegistration() {
  return {
    clientId: showcaseClient,
    firstParty: true,
    scopes: [
      ...new Set([...DEVELOPMENT_SHOWCASE_SCOPES, ...developmentCollectionScopes, ...developmentPersonalListScopes]),
    ],
  };
}
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

export function reusableCompletedExpiredPersonaId(
  row:
    | {
        account_id: string;
        handle: string;
        completed_at: Date | null;
        expired_at: Date | null;
        expires_at: Date;
      }
    | undefined,
  seededAccountId: string | undefined,
  now = Date.now(),
): string | undefined {
  if (
    !seededAccountId ||
    !row ||
    row.account_id !== seededAccountId ||
    row.handle !== 'developer' ||
    row.completed_at === null ||
    (row.expired_at === null && row.expires_at.getTime() > now)
  )
    return undefined;
  return row.account_id;
}

export async function readLocalDeveloperAccountId(directory = state): Promise<string | undefined> {
  let contents: string;
  try {
    contents = await readFile(resolve(directory, 'seed.env'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const prefix = 'REZICS_DEV_PERSONA_ACCOUNT=';
  const line = contents.split(/\r?\n/).find((value) => value.startsWith(prefix));
  const accountId = line?.slice(prefix.length).trim();
  return accountId || undefined;
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

async function snapshotPrivateFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Walk setup rewrites Kernel/Web local files onto slot ports; restore the caller's copies when the slot ends. */
async function restorePrivateFile(path: string, snapshot: string | undefined) {
  if (snapshot === undefined) await rm(path, { force: true });
  else await privateFile(path, snapshot);
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
  const hosts =
    currentHosts === undefined
      ? LOCAL_MEDIA_SOURCE_HOST
      : currentHosts.split(',').includes(LOCAL_MEDIA_SOURCE_HOST)
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

/** A leftover journal that names another PostgreSQL identity cannot replay into this stack's database. */
export async function retireStaleSeedJournals(repository: string, databaseUrl: string): Promise<string | undefined> {
  const seedDirectory = resolve(repository, '.temp/cross-media-seed');
  const identityPath = resolve(seedDirectory, SEED_JOURNAL_IDENTITY_FILE);
  const current = seedJournalDatabaseIdentity(databaseUrl);
  let recorded: string | undefined;
  try {
    recorded = (await readFile(identityPath, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!seedJournalsNameDifferentDatabase(recorded, current)) {
    await mkdir(seedDirectory, { recursive: true, mode: 0o700 });
    await writeFile(identityPath, `${current}\n`, { mode: 0o600 });
    return undefined;
  }
  const archived = await retireDevelopmentSeedState(repository);
  await mkdir(seedDirectory, { recursive: true, mode: 0o700 });
  await writeFile(identityPath, `${current}\n`, { mode: 0o600 });
  return archived;
}

/** Each walk receives a fresh database, even when a reused slot has the same PostgreSQL identity string. */
export async function resetWalkSeedJournals(repository: string, databaseUrl: string): Promise<string | undefined> {
  const archived = await retireDevelopmentSeedState(repository);
  const seedDirectory = resolve(repository, '.temp/cross-media-seed');
  await mkdir(seedDirectory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(seedDirectory, SEED_JOURNAL_IDENTITY_FILE), `${seedJournalDatabaseIdentity(databaseUrl)}\n`, {
    mode: 0o600,
  });
  return archived;
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

/** Topology remaining for the walk seed gate. Unfinished 4096-home close cannot admit import writes. */
export async function identityEpochBootstrapRemaining(databaseUrl: string): Promise<number> {
  localDatabase(databaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });
  try {
    const { rows } = await pool.query<{ remaining: unknown }>(
      'SELECT semantic.identity_epoch_bootstrap_remaining() AS remaining',
    );
    const value = rows[0]?.remaining;
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
    throw new Error(`identity epoch remaining ${String(value)}`);
  } finally {
    await pool.end();
  }
}
export function localDatabase(url: string): URL {
  return new URL(developmentDatabaseUrl(url));
}

async function authDatabaseUrl() {
  const kernel = await kernelEnvironment();
  const url = localDatabase(kernel.DATABASE_URL!);
  url.pathname = '/rezics_auth';
  return url.href;
}

async function setup() {
  if (process.env.NODE_ENV === 'production') throw new Error('Local stack is development only');
  const env = await phase('setup-environment', kernelEnvironment);
  const kernelUrl = localDatabase(env.DATABASE_URL!);
  await phase('setup-auth-database', async () => {
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
  });
  await phase('setup-auth-migrations', async () => migrate(await authDatabaseUrl()));
  const keys = await phase('setup-keys', developmentKeys);
  const contentBindings = developmentContentBindings(env);
  Object.assign(env, contentBindings, developmentKernelBindings());
  const kernelEnvFile = resolve(root, 'services/kernel/.env');
  await phase('setup-kernel-bindings', async () => {
    await privateFile(
      kernelEnvFile,
      updateEnvironmentText(await readFile(kernelEnvFile, 'utf8'), {
        ...contentBindings,
        ...developmentKernelBindings(),
      }),
    );
    await privateFile(resolve(state, 'importer.jwk'), JSON.stringify(keys.importer));
  });
  const website = await phase('setup-catalogue', () => developmentWebsiteConfiguration(env));
  await phase('setup-web-bindings', () =>
    privateFile(
      resolve(root, 'apps/web/.dev.vars'),
      developmentBindings({
        ...developmentWebsiteBindings(keys, website),
        ...developmentMediaBindings({ ...env, ...contentBindings }, keys),
      }),
    ),
  );
}

/** Development-only recovery output stays private; HTTP recovery never returns the token. */
export function localStackRecoveryDelivery(
  directory = resolve(state, 'recovery'),
): NonNullable<import('../src/index.ts').AuthServiceOptions['recoveryDelivery']> {
  return {
    async deliver({ accountId, email, token, url }) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await privateFile(resolve(directory, `${email}.json`), `${JSON.stringify({ accountId, token, url })}\n`);
    },
  };
}

export async function assemble(options?: {
  env: Record<string, string>;
  authDatabaseUrl: string;
  keys: DevelopmentKeys;
  recoveryDelivery?: import('../src/index.ts').AuthServiceOptions['recoveryDelivery'];
}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Local stack is development only');
  const env = options?.env ?? (await kernelEnvironment());
  const [
    auth,
    { createKernel },
    { actionCatalogue },
    { createAccess, accessActionCatalogue },
    { createNativeAccountBindings },
    { readConfig },
  ] = await withDevelopmentDatabase(env, () =>
    phase('native-imports', () =>
      Promise.all([
        import('../src/index.ts'),
        import('../../kernel/src/http/kernel.ts'),
        import('../../kernel/src/http/request.ts'),
        import('../../kernel/src/access/index.ts'),
        import('../../kernel/src/access/native-account-bindings.ts'),
        import('../../kernel/src/server.ts'),
      ]),
    ),
  );
  const config = readConfig(env);
  const kernelPool = new Pool({ connectionString: config.databaseUrl });
  const database = new Pool({ connectionString: options?.authDatabaseUrl ?? (await authDatabaseUrl()) });
  const keys = options?.keys ?? (await developmentKeys());
  let service: import('../src/index.ts').AuthService;
  const jwksUrl = issuerPublicJwksUrl(origins.issuer);
  const kernelAuth = {
    issuer: origins.issuer,
    audience: origins.audience,
    jwksUrl,
    fetch: async (url: string | URL, init?: RequestInit) => {
      const requested = typeof url === 'string' ? url : url.href;
      if (requested !== jwksUrl) throw new TypeError('Local JWKS transport serves only the configured issuer JWKS URL');
      return service.handler(new Request(jwksUrl, init));
    },
  };
  const kernel = createKernel({
    pool: kernelPool,
    tokens: config.tokens,
    routeKey: config.routeKey,
    ...(config.receiptKeys ? { receiptKeys: config.receiptKeys } : {}),
    access: (mounted) => createAccess({ ...mounted, auth: kernelAuth }),
  });
  const actions = accessActionCatalogue(actionCatalogue(kernel));
  const website = developmentWebsiteScopeConfiguration(mountedWebsiteConfiguration(actionCatalogue(kernel)));
  const access = createAccess({
    actions,
    auth: kernelAuth,
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
  const host = await phase(
    'auth-host',
    auth.createAuthHost({
      database,
      issuer: origins.issuer,
      audience: origins.audience,
      secret: keys.secret,
      signing: { activeKid: keys.signing.kid!, privateKeys: [keys.signing] },
      stagingKey: Buffer.from(keys.staging, 'base64url'),
      trustedAccess: bindings.trustedAccess,
      access: bindings.workflowPorts,
      siteActions: actions,
      recoveryDelivery: options?.recoveryDelivery ?? localStackRecoveryDelivery(),
      accountOperations: bindings.accountOperations,
      accountManagementReads: bindings.accountManagementReads,
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
    }),
  );
  service = host.service;
  await phase(
    'auth-registration',
    (async () => {
      await service.internal.registerWebsiteClient({
        publicJwks: { keys: [publicKey(keys.website)] } as import('../src/index.ts').PublicJwks,
        redirectUris: [`${origins.web}/auth/callback`],
        postLogoutRedirectUris: [`${origins.web}/`],
        scopes: website.scopes,
      });
      await service.internal.registerClient({
        clientId: personaClient,
        firstParty: true,
        scopes: [...new Set([...importerScopes, 'account:manage', 'exposure:open', 'access:grant'])],
      });
      await service.internal.registerClient(localShowcaseClientRegistration());
      await service.internal.registerClient(semanticWalkClientRegistration());
    })(),
  );
  await phase('auth-worker', host.start());
  const stop = async () => {
    try {
      await host.stop();
    } finally {
      await kernelPool.end();
    }
  };
  return { host, kernel, access, kernelPool, database, keys, website, stop };
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
  const { bootstrapGovernance, bootstrapLocalShowcaseBoardCreation, PLATFORM_RESOURCE } =
    await import('../../kernel/src/access/bootstrap-governance.ts');
  const { accessCommandAuthorization } = await import('../../kernel/src/request/access.ts');
  const { createExposureCommands } = await import('../../kernel/src/access/gates/catalogue.ts');
  const seededAccountId = await readLocalDeveloperAccountId(directory);
  const registration = seededAccountId
    ? (
        await composition.database.query<{
          account_id: string;
          handle: string;
          completed_at: Date | null;
          expired_at: Date | null;
          expires_at: Date;
        }>(
          `SELECT account_id,handle,completed_at,expired_at,expires_at
           FROM auth_registration_stage WHERE request_key=$1`,
          ['local-developer'],
        )
      ).rows[0]
    : undefined;
  const reusableAccountId = reusableCompletedExpiredPersonaId(registration, seededAccountId);
  let person: { accountId: string };
  let bearer: string;
  const bootstrap = async (accountId: string) => {
    await bootstrapGovernance(kernelPool, accountId);
    await bootstrapLocalShowcaseBoardCreation(kernelPool, accountId);
  };
  if (reusableAccountId) {
    // A completed local registration may outlive its staging TTL. Reuse only the exact
    // seeded account after its existing importer key proves the live identity to Access.
    person = { accountId: reusableAccountId };
    const tokenProvider = await createAccountTokenProvider({
      accountKeyPath: resolve(directory, 'importer.jwk'),
      account: reusableAccountId,
      client: personaClient,
      authOrigin: origins.issuer,
      issuerOrigin: origins.issuer,
      scopes: [...new Set([...importerScopes, 'account:manage', 'exposure:open', 'access:grant'])],
      fetch: Object.assign(
        (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          host.handler(new Request(input, init)),
        { preconnect: fetch.preconnect },
      ),
    });
    bearer = await tokenProvider(true);
    const actor = await access.authenticate(bearer, { pool: kernelPool, deadline: Date.now() + 30_000 });
    if (actor.kind !== 'account' || actor.accountId !== reusableAccountId)
      throw new Error('Existing local developer key did not authenticate its completed persona');
    await bootstrap(person.accountId);
  } else {
    person = await host.workflows.register({
      key: 'local-developer',
      handle: 'developer',
      email: 'developer@rezics.test',
      password: developmentRegistrationPassword(keys),
    });
    await bootstrap(person.accountId);
    const signIn = () =>
      host.handler(
        new Request(`${origins.issuer}/signin`, {
          method: 'POST',
          headers: { origin: origins.issuer, 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'developer@rezics.test',
            password: keys.password,
            client_id: personaClient,
            scope: [...new Set([...importerScopes, 'account:manage', 'exposure:open', 'access:grant'])],
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
    bearer = ((await token.json()) as { access_token: string }).access_token;
  }
  const context = { pool: kernelPool, deadline: Date.now() + 30_000 };
  const actor = await access.authenticate(bearer, context);
  if (actor.kind !== 'account' || actor.accountId !== person.accountId)
    throw new Error('Local persona authentication did not match its account');
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
      REZICS_DEV_SHOWCASE_ACCOUNT_KEY: resolve(directory, 'importer.jwk'),
      REZICS_DEV_SHOWCASE_CLIENT: showcaseClient,
      AUTH_ORIGIN: process.env.REZICS_WALK_STACK_SLOT ? origins.native : origins.issuer,
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

/** Refuse a concrete misbinding before the local operator can obtain a publication credential. */
export function pageDataDefinitionsEnvironment(env: NodeJS.ProcessEnv, databaseUrl: string): void {
  const database = localDatabase(databaseUrl);
  if (
    env.NODE_ENV !== 'development' ||
    !/^rezics-pagecheck-[0-9a-f]{10}$/.test(env.KERNEL_DATABASE_CONTAINER ?? '') ||
    env.REZICS_PAGE_DATA_STACK !== env.KERNEL_DATABASE_CONTAINER ||
    database.port !== env.KERNEL_DATABASE_PORT
  )
    throw new Error('Definitions reconciliation requires the dedicated development page-data database');
}

/** Use only the native Definitions HTTP owner; the current-pointer path issues no writes or credentials. */
export async function reconcilePageDataDefinitions(options: {
  handle: (request: Request) => Promise<Response>;
  activate: boolean;
  bearer: () => Promise<string>;
}): Promise<{ digest: string; head: number }> {
  const request = async (path: string, init?: RequestInit) => {
    const response = await options.handle(new Request(`${origins.kernel}/v1/definitions${path}`, init));
    if (!response.ok)
      throw new Error(`Page-data Definitions ${init?.method ?? 'GET'} ${path}: HTTP ${response.status}`);
    return response;
  };
  // These responses come from the mounted native owner, whose declared types are authoritative.
  const current = (await (await request('/active')).json()) as { digest: string; head: number };
  if (current.digest === bundledDigest) return current;
  if (!options.activate)
    throw new Error(
      `Page-data Definitions mismatch: active head=${current.head} digest=${current.digest}; intended=${bundledDigest}. ` +
        'Run bun tools/goal/src/page-data.ts reconcile-definitions before resuming seed.',
    );
  const bearer = await options.bearer();
  const headers = (key: string) => ({
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
    'idempotency-key': JSON.stringify(key),
  });
  await request('/releases', {
    method: 'POST',
    headers: headers(`page-data:publish:${bundledDigest}`),
    body: JSON.stringify({ release: bundledRelease }),
  });
  await request(`/releases/${bundledDigest}:activate`, {
    method: 'POST',
    headers: headers(`page-data:activate:${bundledDigest}:${current.head}`),
    body: JSON.stringify({ expected_head: current.head }),
  });
  const active = (await (await request('/active')).json()) as { digest: string; head: number };
  if (active.digest !== bundledDigest)
    throw new Error(`Page-data Definitions changed after activation: head=${active.head} digest=${active.digest}`);
  return active;
}

async function pageDataDefinitions(activate: boolean) {
  const env = await kernelEnvironment();
  pageDataDefinitionsEnvironment(process.env, env.DATABASE_URL!);
  const composition = await assemble();
  try {
    const active = await reconcilePageDataDefinitions({
      handle: (request) => composition.kernel.fetch(request),
      activate,
      async bearer() {
        const account = await readLocalDeveloperAccountId(state);
        if (!account) throw new Error('Provision the dedicated page-data persona before reconciling Definitions');
        // A separate local operator client requests existing owner scopes. Importer clients and grants are unchanged.
        const client = 'rezics-page-data-definitions';
        const scopes = ['definitions:publish', 'definitions:activate'];
        await composition.host.service.internal.registerClient({ clientId: client, firstParty: true, scopes });
        const provider = await createAccountTokenProvider({
          accountKeyPath: resolve(state, 'importer.jwk'),
          account,
          client,
          authOrigin: origins.issuer,
          issuerOrigin: origins.issuer,
          scopes,
          fetch: Object.assign(
            (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
              composition.host.handler(new Request(input, init)),
            { preconnect: fetch.preconnect },
          ),
        });
        return provider(true);
      },
    });
    console.log(`Page-data Definitions current: head=${active.head} digest=${active.digest}`);
  } finally {
    await composition.stop();
  }
}

/** Native transport is private; Auth still validates requests at its public issuer. */
export function issuerRequest(request: Request): Request {
  const url = new URL(request.url);
  url.host = new URL(origins.issuer).host;
  return new Request(url, request);
}

function loopbackServe(
  port: number,
  fetch: (request: Request) => Response | Promise<Response>,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: async (request) => {
      if (new URL(request.url).hostname !== '127.0.0.1') return new Response('Loopback only', { status: 403 });
      return fetch(request);
    },
  });
}

async function serveHost() {
  const composition = await assemble();
  try {
    const person = await phase('auth-persona', provisionPersona(composition));
    printPersona(composition.keys, person.accountId);
  } catch (error) {
    await composition.stop();
    throw error;
  }
  const mediaBindings = developmentMediaBindings(await kernelEnvironment(), composition.keys);
  const media = mediaBindings.LOCAL_MEDIA_TOKEN
    ? (await import('../../kernel/src/content/index.ts')).developmentMediaHandler(mediaBindings.LOCAL_MEDIA_TOKEN)
    : undefined;
  const composeKernel = process.env.REZICS_WALK_DEFER_FRONTENDS === '1';
  const native = loopbackServe(localPort(origins.native), async (request) => {
    if (new URL(request.url).pathname.startsWith('/_local/media/') && media) return media(request);
    if (new URL(request.url).pathname === '/local-turnstile.js')
      return new Response(widgetScript, { headers: { 'content-type': 'text/javascript' } });
    return composition.host.handler(issuerRequest(request));
  });
  // Account journeys do not need a second Kernel process, worker, or OpenSearch: the host already assembled Kernel.
  const kernel = composeKernel
    ? loopbackServe(localPort(origins.kernel), (request) => composition.kernel.fetch(request))
    : undefined;
  const stop = async () => {
    await native.stop(true);
    await kernel?.stop(true);
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
  if (kernel) console.log(`Kernel: ${origins.kernel}`);
}

export function webLaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {
    ...env,
    CLOUDFLARE_VITE_FORCE_LOCAL: 'true',
    CLOUDFLARE_CF_FETCH_ENABLED: 'false',
  };
  delete child.REZICS_TEST_RUNTIME;
  return child;
}

/** Trusted launch inputs captured before runtime DDL changes the native analysis schema. */
export function developmentFrontendProcess(
  action: 'pages' | 'web',
  args: readonly string[],
  inputs: {
    environment: NodeJS.ProcessEnv;
    kernelEnvironment: Readonly<Record<string, string | undefined>>;
    website: Awaited<ReturnType<typeof developmentWebsiteConfiguration>>;
    keys: DevelopmentKeys;
  },
): { command: string[]; environment: NodeJS.ProcessEnv } {
  const pages = action === 'pages';
  const { environment, website, keys } = inputs;
  return {
    command: [
      'bun',
      'run',
      '--cwd',
      pages ? 'apps/auth' : 'apps/web',
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(localPort(pages ? origins.issuer : origins.web)),
      '--strictPort',
      ...args,
    ],
    environment: {
      ...(pages ? environment : webLaunchEnvironment(environment)),
      AUTH_ORIGIN: origins.native,
      ...developmentWebsiteBindings(keys, website, {
        AUTH_MANAGEMENT_PAGE_ROUTES: environment.AUTH_MANAGEMENT_PAGE_ROUTES,
      }),
      ...developmentMediaBindings(inputs.kernelEnvironment, keys),
      ...(pages ? developmentAuthPageBindings(website) : {}),
      PUBLIC_ORIGIN: origins.web,
      TURNSTILE_SITE_KEY: 'local',
      TURNSTILE_SCRIPT_URL: `${origins.issuer}/local-turnstile.js`,
    },
  };
}

async function launch(action: 'pages' | 'web', args: string[]) {
  const kernel = await kernelEnvironment();
  const launch = developmentFrontendProcess(action, args, {
    environment: process.env,
    kernelEnvironment: kernel,
    website: await developmentWebsiteConfiguration(kernel),
    keys: await developmentKeys(),
  });
  const child = Bun.spawn(launch.command, {
    cwd: root,
    env: launch.environment,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
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

/** Walk stacks skip `--watch` and can omit Vite until the child starts mounted pages. */
export function stackProcessCommands(env: Record<string, string | undefined> = process.env): string[][] {
  const walk = env.REZICS_WALK_STACK_SLOT !== undefined;
  const frontends = !stackStartPlan(env, origins).deferPages && env.REZICS_WALK_DEFER_FRONTENDS !== '1';
  const composedKernel = env.REZICS_WALK_DEFER_FRONTENDS === '1';
  return [
    ['bun', 'services/auth/scripts/dev-stack.ts', 'host'],
    ...(frontends
      ? [
          ['bun', 'services/auth/scripts/dev-stack.ts', 'pages'],
          ['bun', 'services/auth/scripts/dev-stack.ts', 'web'],
        ]
      : []),
    ...(composedKernel
      ? []
      : [
          ['bun', 'run', '--cwd', 'services/kernel', walk ? 'start' : 'dev'],
          ['bun', 'run', '--cwd', 'services/kernel', 'worker'],
        ]),
  ];
}

/** Deferred walks skip OpenSearch: account HTTP does not use catalogue search. */
export function walkSetupScripts(env: Record<string, string | undefined> = process.env): string[][] {
  return [
    ['services/kernel/scripts/database.ts', 'up'],
    ...(env.REZICS_WALK_DEFER_FRONTENDS === '1' ? [] : [['services/kernel/scripts/search.ts', 'up']]),
    ['services/auth/scripts/dev-stack.ts', 'setup'],
  ];
}

type DevelopmentService = 'identity' | 'kernel' | 'worker' | 'pages' | 'web';

/** Web compiles independently; readiness still requires the original native dependency order. */
export async function startDevelopmentServices<Child>(
  mode: 'complete' | 'walk' | 'native',
  host: {
    launch(service: DevelopmentService): Child;
    ready(service: DevelopmentService, children: Child[]): Promise<void>;
    stopping(): boolean;
  },
): Promise<void> {
  const children: Child[] = [];
  const launch = (service: DevelopmentService) => {
    const child = host.launch(service);
    children.push(child);
    return child;
  };
  // Each gate monitors every started child, including Web while native services are still booting.
  const ready = (service: DevelopmentService, child: Child) =>
    host.ready(service, [child, ...children.filter((other) => other !== child)]);
  const identity = launch('identity');
  // The mounted bindings have already been captured. Web does no native discovery during its cold compilation.
  const web = mode === 'complete' ? launch('web') : undefined;
  await ready('identity', identity);
  if (host.stopping() || mode === 'native') return;
  if (mode === 'walk') {
    const pages = launch('pages');
    await ready('pages', pages);
    if (host.stopping()) return;
  }
  const kernel = launch('kernel');
  await ready('kernel', kernel);
  if (host.stopping()) return;
  const worker = launch('worker');
  await ready('worker', worker);
  if (host.stopping()) return;
  if (mode === 'complete') {
    const pages = launch('pages');
    await ready('pages', pages);
    if (host.stopping()) return;
    await ready('web', web!);
  }
}

/** Starts and owns the documented stack; deferred walks keep their existing smaller service set. */
async function start() {
  const kernelEnvironmentValues = await kernelEnvironment();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...kernelEnvironmentValues,
    ...developmentKernelBindings(),
  };
  // Walk fixture keys survive kernel .env, which can contain a developer's Stripe bindings.
  if (process.env.STRIPE_SECRET_KEY === 'sk_test_walk_commerce') {
    Object.assign(env, {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      STRIPE_API_HOST: process.env.STRIPE_API_HOST,
      STRIPE_WEBHOOK_SECRETS: process.env.STRIPE_WEBHOOK_SECRETS,
      STRIPE_MANAGED_PAYMENTS: process.env.STRIPE_MANAGED_PAYMENTS,
      CHECKOUT_SUCCESS_URL: process.env.CHECKOUT_SUCCESS_URL,
      CHECKOUT_CANCEL_URL: process.env.CHECKOUT_CANCEL_URL,
    });
  }
  const plan = stackStartPlan(env, origins);
  const identityLine = ownerProcessIdentity();
  console.info(stackPhaseLine('owner', identityLine));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const commands: string[][] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  const spawnChild = (command: string[], environment: NodeJS.ProcessEnv, stdout: 'inherit' | 'pipe' = 'inherit') =>
    Bun.spawn(command, { cwd: root, env: environment, stdin: 'inherit', stdout, stderr: 'inherit' });
  const launch = (command: string[], stdout: 'inherit' | 'pipe' = 'inherit', environment = env) => {
    const child = spawnChild(command, environment, stdout);
    children.push(child);
    commands.push(command);
    environments.push(environment);
    return child;
  };
  let stopping = false;
  let resolveStop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const supervise = async (index: number) => {
    for (;;) {
      await children[index]!.exited;
      if (stopping) return;
      await Bun.sleep(1_000);
      if (stopping) return;
      console.error(`walk: ${commands[index]!.slice(-2).join(' ')} exited; restarting`);
      const child = spawnChild(commands[index]!, environments[index]!);
      children[index] = child;
      if (stopping) {
        await stopSpawned(child);
        return;
      }
    }
  };
  const stop = () => {
    stopping = true;
    resolveStop?.();
    void stopChildren(children);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    Object.assign(env, await phase('runtime-native-preparation', () => prepareDevelopmentNative(env)));
    if (stopping) return;
    // Native runtime startup creates physical schema objects. Capture the mounted declarations before that DDL;
    // pages and Web use these bindings throughout this owned run, including supervised restarts.
    const frontendInputs =
      env.REZICS_WALK_DEFER_FRONTENDS === '1'
        ? undefined
        : await phase('frontend-bindings', async () => ({
            environment: env,
            kernelEnvironment: kernelEnvironmentValues,
            website: await developmentWebsiteConfiguration(kernelEnvironmentValues),
            keys: await developmentKeys(),
          }));
    const launchFrontend = (action: 'pages' | 'web') => {
      const prepared = developmentFrontendProcess(action, [], frontendInputs!);
      return launch(prepared.command, 'inherit', prepared.environment);
    };
    if (stopping) return;
    const nativeOnly = env.REZICS_WALK_DEFER_FRONTENDS === '1';
    await startDevelopmentServices(nativeOnly ? 'native' : plan.deferPages ? 'walk' : 'complete', {
      stopping: () => stopping,
      launch(service) {
        switch (service) {
          case 'identity':
            return launch(['bun', 'services/auth/scripts/dev-stack.ts', 'host']);
          case 'kernel':
            return launch(plan.kernel);
          case 'worker':
            return launch(['bun', 'run', '--cwd', 'services/kernel', 'worker'], 'pipe');
          case 'pages':
            return launchFrontend('pages');
          case 'web': {
            const child = launchFrontend('web');
            console.info(stackPhaseLine('web-launched', `pid=${child.pid}`));
            return child;
          }
        }
      },
      async ready(service, children) {
        if (service === 'worker') {
          await phase(
            'worker',
            Promise.race([
              untilOutput(children[0]!, 'Worker ready'),
              ...children.slice(1).map(async (child) => {
                const code = await child.exited;
                throw new Error(`walk: process exited (${code}) before Worker readiness`);
              }),
            ]),
          );
          return;
        }
        const urls = {
          identity: nativeOnly ? [...plan.nativeReady, `${origins.kernel}/health`] : plan.nativeReady,
          kernel: plan.kernelReady,
          pages: [
            plan.deferPages ? issuerJwksUrl(origins.issuer) : `${origins.issuer}/.well-known/openid-configuration`,
          ],
          web: [`${origins.web}${SEEDED_WEB_READY_PATH}`],
        };
        await phase(service, untilReady(urls[service], children));
      },
    });
    if (stopping) return;
    await Promise.race([stopped, ...children.map((_, index) => supervise(index))]);
    process.exitCode = 0;
  } finally {
    stopping = true;
    await stopChildren(children);
    disposeDevelopmentNative();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

/** Names the startup phase that failed, so the stack output says which dependency was missing. */
async function phase<T>(name: string, work: Promise<T> | (() => T | Promise<T>)): Promise<T> {
  return await nativePhase(name, () => (typeof work === 'function' ? work() : work));
}

/** Search the whole arriving chunk; retain only enough text to recognize a split marker. */
export function outputMarker(marker: string): (chunk: string) => boolean {
  let suffix = '';
  let seen = false;
  return (chunk) => {
    if (!seen) {
      const text = suffix + chunk;
      seen = text.includes(marker);
      suffix = text.slice(text.length - marker.length + 1);
    }
    return seen;
  };
}

/** Resolves once `child` prints `marker`; its output keeps flowing to this process's stdout for the child's lifetime. */
async function untilOutput(child: ReturnType<typeof Bun.spawn>, marker: string): Promise<void> {
  const decoder = new TextDecoder();
  const containsMarker = outputMarker(marker);
  let seen = false;
  const pump = (async () => {
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      const text = decoder.decode(chunk, { stream: true });
      process.stdout.write(text);
      seen = containsMarker(text);
    }
  })();
  pump.catch(() => {});
  const deadline = Date.now() + 600_000;
  while (!seen) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`walk: "${marker}" was not printed; the process exited (${child.exitCode ?? child.signalCode})`);
    if (Date.now() > deadline) throw new Error(`walk: "${marker}" was not printed within ten minutes`);
    await Bun.sleep(250);
  }
}

/** SIGTERM every running child, then SIGKILL any that outlive the grace period, so a stuck child cannot hold teardown. */
async function stopChildren(children: ReturnType<typeof Bun.spawn>[], graceMs = 30_000): Promise<void> {
  const running = () => children.filter((child) => child.exitCode === null && child.signalCode === null);
  for (const child of running()) child.kill('SIGTERM');
  const exits = Promise.all(children.map((child) => child.exited));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outlived = await Promise.race([
    exits.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), graceMs);
    }),
  ]);
  clearTimeout(timer);
  if (outlived) for (const child of running()) child.kill('SIGKILL');
  await exits;
}
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

/** Cleanup passes its own bound: a probe timeout is too short to remove a busy container or volume. */
function dockerOutput(args: string[], timeoutMs?: number): string {
  return runDocker(args, timeoutMs === undefined ? {} : { timeout: timeoutMs });
}

/** Removes the task's containers and volumes that exist, so a partial start tears down completely. */
function removeWalkStack(names: WalkNames, required = true): void {
  try {
    for (const container of [names.database, names.search]) {
      if (!dockerOutput(['ps', '-aq', '--filter', `name=^${container}$`])) continue;
      try {
        dockerOutput(['kill', container], 15_000);
      } catch {
        // Already stopped, Created, or removing.
      }
      try {
        dockerOutput(['rm', '-f', '-v', container], WALK_DOCKER_REMOVE_MS);
      } catch (error) {
        if (required) throw error;
        console.error(`walk: docker rm ${container} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const volume of [names.database, names.search]) {
      if (!dockerOutput(['volume', 'ls', '-q', '--filter', `name=^${volume}$`])) continue;
      try {
        dockerOutput(['volume', 'rm', volume], WALK_DOCKER_REMOVE_MS);
      } catch (error) {
        if (required) throw error;
        console.error(
          `walk: docker volume rm ${volume} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    if (required) throw error;
    console.error(error);
  }
}

/** Resolves when every URL answers; fails when the stack exits first or the compile window elapses. */
async function untilReady(
  urls: string[],
  starting: ReturnType<typeof Bun.spawn> | readonly ReturnType<typeof Bun.spawn>[],
): Promise<void> {
  const processes = Array.isArray(starting) ? starting : [starting as ReturnType<typeof Bun.spawn>];
  await waitUntilWalkReady({ urls, children: processes });
}

/** Vite can answer /en before /auth/sign-in exists; keep waiting through 404, then let the walk record the status. */
async function untilWebSignInRedirect(children: readonly ReturnType<typeof Bun.spawn>[]): Promise<void> {
  const url = `${origins.web}/auth/sign-in?return_to=${encodeURIComponent('/en/settings')}`;
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const exited = children.find((child) => child.exitCode !== null || child.signalCode !== null);
    if (exited) throw new Error(`walk: web exited (${exited.exitCode ?? exited.signalCode}) before sign-in redirected`);
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      if (response.status !== 404) return;
    } catch {
      // Compile or bind can refuse the first fetches; keep waiting inside the window.
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`walk: web sign-in stayed HTTP 404 after compiling (${url})`);
}

/**
 * Starts Auth pages and Web for a journey that has already seeded its admitted stack. An admitted `start` leaves them
 * out, so Vite never compiles while the seed runs. Children are killed on exit, so a failed journey cannot leave the
 * slot's ports listening; `stop` is the normal teardown.
 */
export async function startSeededFrontends(): Promise<{ stop(): Promise<void> }> {
  const pagesUp = await walkOriginListening(origins.issuer);
  const actions = pagesUp ? (['web'] as const) : (['pages', 'web'] as const);
  const children = actions.map((action) =>
    Bun.spawn(['bun', 'services/auth/scripts/dev-stack.ts', action], {
      cwd: root,
      env: process.env,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    }),
  );
  const killOnExit = () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  process.once('exit', killOnExit);
  try {
    await untilReady(
      [
        ...(pagesUp ? [] : [`${origins.issuer}/.well-known/openid-configuration`]),
        `${origins.web}${SEEDED_WEB_READY_PATH}`,
      ],
      children,
    );
    await untilWebSignInRedirect(children);
  } catch (error) {
    await Promise.all(children.map((child) => stopSpawned(child)));
    process.off('exit', killOnExit);
    throw error;
  }
  return {
    stop: async () => {
      process.off('exit', killOnExit);
      await Promise.all(children.map((child) => stopSpawned(child)));
    },
  };
}

/**
 * Runs `command` against one walk stack: admission, the stack `dev:infra` and `dev` start, then teardown when the
 * command ends or the attempt is signalled. Only a worker whose brief lists native or browser acceptance may start one.
 */
export async function runWalk(
  command: string[],
  portsAvailable: typeof walkStackPortsAvailable = walkStackPortsAvailable,
): Promise<number> {
  const task = process.env.GOAL_TASK_ID;
  if (!task || !walkStackRequired(process.env))
    throw new Error('walk stacks are for a worker whose brief lists acceptance.requires native or browser');
  if (command.length === 0) throw new Error('Usage: bun services/auth/scripts/dev-stack.ts walk -- <command...>');
  const controller = new AbortController();
  let current: ReturnType<typeof Bun.spawn> | undefined;
  let interrupted: keyof typeof SIGNAL_NUMBERS | undefined;
  const handlers = (Object.keys(SIGNAL_NUMBERS) as (keyof typeof SIGNAL_NUMBERS)[]).map((signal) => {
    const handler = () => {
      interrupted ??= signal;
      controller.abort();
      current?.kill(signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  let slot: StackSlot | undefined;
  let code = 0;
  const blocked = new Set<number>();
  const recordSetup = async (script: string[], env: Record<string, string>) => {
    const child = Bun.spawn([process.execPath, ...script], {
      cwd: root,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    current = child;
    let stdout = '';
    let stderr = '';
    const pump = async (stream: ReadableStream<Uint8Array> | number | undefined, write: (text: string) => void) => {
      if (stream === undefined || typeof stream === 'number') return;
      for await (const chunk of stream) {
        const text = Buffer.from(chunk).toString();
        write(text);
      }
    };
    const [, , status] = await Promise.all([
      pump(child.stdout, (text) => {
        stdout += text;
        process.stdout.write(text);
      }),
      pump(child.stderr, (text) => {
        stderr += text;
        process.stderr.write(text);
      }),
      child.exited,
    ]);
    return { status, recorded: `${stdout}${stderr}` };
  };
  const kernelEnvFile = resolve(root, 'services/kernel/.env');
  const webVarsFile = resolve(root, 'apps/web/.dev.vars');
  const kernelEnvSnapshot = await snapshotPrivateFile(kernelEnvFile);
  const webVarsSnapshot = await snapshotPrivateFile(webVarsFile);
  try {
    while (true) {
      slot = await admitWalkStack(task, process.env, root, controller.signal, blocked, portsAvailable);
      const names = walkStackNames(task, slot.index!);
      const env = walkProcessEnvironment(task, slot.index!);
      const ports = walkStackPorts(slot.index!);
      let starting: ReturnType<typeof Bun.spawn> | undefined;
      let walkFailure: unknown;
      let occupiedSlot: number | undefined;
      let stripe: { port: number; webhookSecret: string; stop(): void } | undefined;
      try {
        try {
          const { startFakeStripe } = await import('../../kernel/test/commerce/support/fake-stripe.ts');
          stripe = startFakeStripe();
          Object.assign(env, walkCommerceProviderEnvironment(stripe.port, stripe.webhookSecret));
          removeWalkStack(names); // an interrupted attempt of this slot may have left its stack behind
          for (const script of walkSetupScripts(env)) {
            // A setup step that fails once is retried: a busy host can time out a container start.
            let status = 1;
            for (let attempt = 0; attempt < 2 && status !== 0; attempt++) {
              const result = await recordSetup(script, env);
              status = result.status;
              const allocated = walkPublishedPortAllocated(status, result.recorded, slot.index!);
              if (allocated) {
                occupiedSlot = allocated.index;
                throw allocated;
              }
              if (status !== 0 && attempt === 0 && script[1] === 'up' && script[0]?.endsWith('database.ts'))
                removeWalkStack(names);
            }
            if (status !== 0) throw new Error(`walk: ${script.join(' ')} failed`);
          }
          const log = join(root, '.temp', 'walk', task, 'stack.log');
          await mkdir(dirname(log), { recursive: true });
          await writeFile(log, '');
          // Every walk creates a new database, so retire old native identifiers even when slot URLs are reused.
          const kernelEnv = await kernelEnvironment();
          if (kernelEnv.DATABASE_URL) await resetWalkSeedJournals(root, kernelEnv.DATABASE_URL);
          starting = current = Bun.spawn([process.execPath, 'services/auth/scripts/dev-stack.ts', 'start'], {
            cwd: root,
            env,
            stdin: 'ignore',
            stdout: Bun.file(log),
            stderr: Bun.file(log),
          });
          // An admitted stack's frontends start after its journey seeds, so readiness is Auth JWKS and Kernel only.
          const plan = stackStartPlan(env, {
            web: `http://127.0.0.1:${ports.web}`,
            issuer: `http://127.0.0.1:${ports.issuer}`,
            native: `http://127.0.0.1:${ports.native}`,
            kernel: `http://127.0.0.1:${ports.kernel}`,
          });
          await untilReady(
            [
              ...plan.nativeReady,
              ...(env.REZICS_WALK_DEFER_FRONTENDS === '1'
                ? [`http://127.0.0.1:${ports.kernel}/health`]
                : plan.kernelReady),
            ],
            starting,
          );
          current = Bun.spawn(command, { env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
          code = await current.exited;
        } catch (error) {
          walkFailure = error;
          throw error;
        } finally {
          stripe?.stop();
          if (starting) await stopSpawned(starting);
          try {
            removeWalkStack(names);
          } catch (cleanupError) {
            if (walkFailure) throw retainOriginalAndCleanupFailure(walkFailure, cleanupError, 'walk failed');
            throw cleanupError;
          }
        }
        break;
      } catch (error) {
        if (occupiedSlot !== undefined && interrupted === undefined) {
          blocked.add(occupiedSlot);
          await slot.release();
          slot = undefined;
          if (blocked.size < walkStackLimit(process.env)) {
            console.error(`walk: slot ${occupiedSlot} published port is already allocated; admitting another`);
            continue;
          }
        }
        throw error;
      }
    }
  } catch (error) {
    if (interrupted === undefined) throw error;
    console.error(firstRedactedDiagnostic(error instanceof Error ? error.message : String(error)));
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    const cleanup = await Promise.allSettled([
      restorePrivateFile(kernelEnvFile, kernelEnvSnapshot),
      restorePrivateFile(webVarsFile, webVarsSnapshot),
      slot?.release(),
    ]);
    const failures = cleanup.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (failures.length) throw new AggregateError(failures, 'walk binding and slot cleanup failed');
  }
  return interrupted === undefined ? code : 128 + SIGNAL_NUMBERS[interrupted];
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
    } else if (action === 'page-data-definitions') {
      const mode = process.argv[3];
      if (mode !== '--check' && mode !== '--activate') throw new Error('Use page-data-definitions --check|--activate');
      await pageDataDefinitions(mode === '--activate');
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
    else if (action === 'walk') {
      const rest = process.argv.slice(3);
      process.exitCode = await runWalk(rest[0] === '--' ? rest.slice(1) : rest);
    } else throw new Error('Use setup, start, host, pages, web, persona or walk');
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
