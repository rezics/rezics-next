import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Profile = 'dev' | 'qa';
export interface StackOptions { profile: Profile; runId?: string; persistent?: boolean;
  rawUpdate?: boolean;
  /** `task dev` serves the Accounts app for this stack (set by the dev CLI, not a flag). */
  accountsApp?: boolean }

export function stackStorage(options: StackOptions): 'persistent' | 'tmpfs' {
  return options.profile === 'dev' || options.persistent ? 'persistent' : 'tmpfs';
}

/** Only the fixed shared dev project outranks disposable QA and worktree stacks. */
export function stackMemorySettings(options: StackOptions,
  env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // A seeded worktree Fuseki used 5.6 GiB resident with a 2 GiB heap. Allow
  // 7 GiB for mapped TDB2 pages while leaving the smaller QA heap below it.
  return options.profile === 'dev'
    ? { REZICS_FUSEKI_OOM_SCORE_ADJ: '-900', REZICS_POSTGRES_OOM_SCORE_ADJ: '-800',
      REZICS_FUSEKI_MEMORY_LIMIT: '0', REZICS_FUSEKI_JVM_ARGS: '-Xms256m -Xmx2g' }
    : { REZICS_FUSEKI_OOM_SCORE_ADJ: '0', REZICS_POSTGRES_OOM_SCORE_ADJ: '0',
      REZICS_FUSEKI_MEMORY_LIMIT: env.REZICS_FUSEKI_MEMORY_LIMIT ?? '7g',
      REZICS_FUSEKI_JVM_ARGS: env.REZICS_FUSEKI_JVM_ARGS
        ?? '-Xms128m -Xmx1536m -XX:MaxDirectMemorySize=512m' };
}

export function assertSavedStackStorage(options: StackOptions, saved: Record<string, string>): void {
  // Projects predating the marker used named volumes for dev and tmpfs for QA.
  const actual = saved.REZICS_STACK_STORAGE ?? (options.profile === 'dev' ? 'persistent' : 'tmpfs');
  if (actual !== stackStorage(options)) throw new Error('Saved stack storage mode differs; use a new QA run-id');
}

export function assertSavedStackRawUpdate(options: StackOptions, saved: Record<string, string>): void {
  const actual = saved.REZICS_STACK_RAW_UPDATE ?? '0';
  if (actual !== (options.rawUpdate ? '1' : '0')) {
    throw new Error('Saved stack raw-update mode differs; use a new QA run-id');
  }
}

/** The Accounts app (apps/accounts) is the public Account origin wherever `task
 * dev` serves it: on this fixed port for the shared dev stack and on a random
 * one for a worktree backend. QA tier stacks never run it, so their public
 * Account origin stays the service itself. Once a stack has an Accounts port it
 * keeps it, because Access principals are bound to the issuer it implies. */
export const ACCOUNTS_PORT = 3004;

export function hostsAccountsApp(options: StackOptions): boolean {
  return options.profile === 'dev' || options.accountsApp === true;
}

const DEV_PORTS = {
  MAIN_PORT: 3001, ACCOUNT_PORT: 3002,
  POSTGRES_PORT: 5432, FUSEKI_PORT: 3030, RUSTFS_PORT: 9000,
  RUSTFS_CONSOLE_PORT: 9001, TOXIPROXY_API_PORT: 8474,
  TOXIPROXY_POSTGRES_PORT: 15432, TOXIPROXY_FUSEKI_PORT: 13030,
  MAILPIT_SMTP_PORT: 1025, MAILPIT_HTTP_PORT: 8025,
};

export function parseOptions(args: string[]): StackOptions {
  let profile: Profile = 'dev';
  let runId: string | undefined;
  let persistent = false;
  let rawUpdate = false;
  let accountsApp = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile' && (args[i + 1] === 'dev' || args[i + 1] === 'qa')) {
      profile = args[++i] as Profile;
    } else if (args[i] === '--run-id' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(args[i + 1] ?? '')) {
      runId = args[++i];
    } else if (args[i] === '--persistent') {
      persistent = true;
    } else if (args[i] === '--raw-update') {
      rawUpdate = true;
    } else if (args[i] === '--accounts-app') {
      // This QA project serves the public OAuth issuer on its own port.
      accountsApp = true;
    } else {
      throw new Error(`Invalid stack option: ${args[i] ?? ''}`);
    }
  }
  if (profile === 'dev' && runId) throw new Error('--run-id requires --profile qa');
  if (profile === 'dev' && persistent) throw new Error('--persistent requires --profile qa');
  if (rawUpdate && (profile !== 'qa' || !persistent)) {
    throw new Error('--raw-update requires --profile qa --persistent');
  }
  if (accountsApp && profile !== 'qa') throw new Error('--accounts-app requires --profile qa');
  return { profile, runId, persistent, rawUpdate, accountsApp };
}

export function projectName(options: StackOptions): string {
  if (options.profile === 'dev') return 'rezics-dev';
  if (!options.runId) throw new Error('QA stack requires --run-id to keep projects isolated');
  return `rezics-qa-${options.runId}`;
}

export function stackDirectory(root: string, options: StackOptions): string {
  return join(root, '.temp', 'stack', projectName(options));
}

function secret(): string { return randomBytes(32).toString('hex'); }

export function createSecrets(): Record<string, string> {
  return {
    POSTGRES_PASSWORD: secret(),
    REZICS_ACCOUNT_PASSWORD: secret(), REZICS_ACCESS_PASSWORD: secret(),
    REZICS_CONTENT_PASSWORD: secret(), REZICS_RELAY_PASSWORD: secret(),
    RUSTFS_ACCESS_KEY: `rezics${randomBytes(12).toString('hex')}`,
    RUSTFS_SECRET_KEY: secret(),
    ACCOUNT_SECRET: secret(), ACCOUNT_MAIN_CLIENT_ID: `main-${randomUUID()}`,
    ACCOUNT_MAIN_CLIENT_SECRET: secret(),
    FUSEKI_MAINTENANCE_TOKEN: secret(),
    FUSEKI_COMMAND_TOKEN: secret(),
    FUSEKI_TITLE_ADMISSION_KEY: secret(),
    MAIN_DATA_EPOCH: randomUUID(), MAIN_ROUTING_EPOCH: randomUUID(),
  };
}

export function serializeEnv(values: Record<string, string | number>): string {
  return Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(String(value))) {
      throw new Error(`Invalid environment field: ${key}`);
    }
    return `${key}=${value}`;
  }).join('\n') + '\n';
}

export function readEnv(path: string): Record<string, string> {
  return Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(line => {
      const at = line.indexOf('=');
      if (at < 1) throw new Error(`Invalid environment file: ${path}`);
      return [line.slice(0, at), line.slice(at + 1)];
    }));
}

/** Compose gives process variables precedence over --env-file. Bind every saved
 * project setting to its own process so an enclosing QA stack cannot replace it. */
export function composeProcessEnvironment(inherited: NodeJS.ProcessEnv,
  saved: Record<string, string>): NodeJS.ProcessEnv {
  return { ...inherited, ...saved };
}

export function savePrivate(path: string, values: Record<string, string | number>): void {
  writeFileSync(path, serializeEnv(values), { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

export function replacePrivate(path: string, values: Record<string, string | number>): void {
  const staged = `${path}.${randomUUID()}.next`;
  savePrivate(staged, values);
  renameSync(staged, path);
}

export function ensureSecrets(root: string, options: StackOptions,
  ports: Record<string, number> = DEV_PORTS): Record<string, string> {
  const dir = stackDirectory(root, options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, 'compose.env');
  const accountsPort = hostsAccountsApp(options)
    ? ports.ACCOUNTS_PORT ?? (options.profile === 'dev' ? ACCOUNTS_PORT : undefined) : undefined;
  if (!existsSync(path)) savePrivate(path, { ...createSecrets(), ...ports,
    ...(accountsPort ? { ACCOUNTS_PORT: accountsPort } : {}),
    REZICS_STACK_STORAGE: stackStorage(options),
    REZICS_STACK_RAW_UPDATE: options.rawUpdate ? '1' : '0', ...stackMemorySettings(options) });
  const values = readEnv(path);
  assertSavedStackStorage(options, values);
  assertSavedStackRawUpdate(options, values);
  let upgraded = false;
  if (!values.REZICS_STACK_STORAGE) { values.REZICS_STACK_STORAGE = stackStorage(options); upgraded = true; }
  if (accountsPort && !values.ACCOUNTS_PORT) { values.ACCOUNTS_PORT = String(accountsPort); upgraded = true; }
  for (const [name, value] of Object.entries(stackMemorySettings(options))) {
    if (!values[name]) { values[name] = value; upgraded = true; }
  }
  for (const name of ['FUSEKI_MAINTENANCE_TOKEN', 'FUSEKI_COMMAND_TOKEN', 'FUSEKI_TITLE_ADMISSION_KEY']) {
    if (!values[name]) { values[name] = secret(); upgraded = true; }
  }
  if (upgraded) replacePrivate(path, values);
  return values;
}

export function devPorts(): Record<string, number> { return { ...DEV_PORTS }; }

function pgUrl(role: string, password: string, port: string): string {
  return `postgres://${role}:${encodeURIComponent(password)}@127.0.0.1:${port}/${role}`;
}

export function appEnvironment(compose: Record<string, string>, dir: string): Record<string, string> {
  const service = `http://127.0.0.1:${compose.ACCOUNT_PORT}`;
  // Browsers, products and the OAuth issuer use the public Account origin;
  // Main still reads JWKS and introspection from the service directly.
  const account = compose.ACCOUNTS_PORT ? `http://127.0.0.1:${compose.ACCOUNTS_PORT}` : service;
  return {
    // Seed/load/QA exercise the same admission code with an explicit local
    // policy. Operators can lower any family through saved environment config.
    MAIN_RATE_LIMIT_BUDGETS: compose.MAIN_RATE_LIMIT_BUDGETS ?? JSON.stringify(Object.fromEntries(
      ['anonymous', 'new-account', 'member', 'trusted', 'service'].map(principal => [principal,
        Object.fromEntries(['write', 'upload', 'report', 'correspondence', 'search', 'provider', 'address']
          .map(family => [family, { maximum: 1_000_000, seconds: 60 }]))]))),
    MAIN_RATE_LIMIT_TRUSTED_PROXY_PEERS: compose.MAIN_RATE_LIMIT_TRUSTED_PROXY_PEERS ?? '127.0.0.1,::1',
    // Account applies a sign-up's market rule from the edge's CF-IPCountry only via a trusted
    // peer; locally the Accounts app proxies from loopback, so a browser tool can choose a region.
    ACCOUNTS_COUNTRY_FROM_HEADER: compose.ACCOUNTS_COUNTRY_FROM_HEADER ?? 'true',
    ACCOUNT_TRUSTED_PROXY_PEERS: compose.ACCOUNT_TRUSTED_PROXY_PEERS ?? '127.0.0.1,::1',
    MAIN_READER_IMPORT_SEARCHES_PER_DAY: compose.MAIN_READER_IMPORT_SEARCHES_PER_DAY ?? '1000000',
    MAIN_READER_IMPORT_ACQUISITIONS_PER_DAY: compose.MAIN_READER_IMPORT_ACQUISITIONS_PER_DAY ?? '1000000',
    ACCOUNT_TURNSTILE_MODE: compose.ACCOUNT_TURNSTILE_MODE ?? 'local',
    ACCOUNT_TURNSTILE_SECRET_KEY: compose.ACCOUNT_TURNSTILE_SECRET_KEY ?? '',
    ACCOUNT_TURNSTILE_SITE_KEY: compose.ACCOUNT_TURNSTILE_SITE_KEY ?? '',
    ACCOUNT_ENROLLMENT_TOKEN: compose.ACCOUNT_ENROLLMENT_TOKEN ?? 'local:127.0.0.1:account-enrollment',
    FUSEKI_URL: `http://127.0.0.1:${compose.FUSEKI_PORT}/rezics/`,
    FUSEKI_MAINTENANCE_TOKEN: compose.FUSEKI_MAINTENANCE_TOKEN,
    FUSEKI_COMMAND_TOKEN: compose.FUSEKI_COMMAND_TOKEN,
    FUSEKI_TITLE_ADMISSION_KEY: compose.FUSEKI_TITLE_ADMISSION_KEY,
    ACCESS_DATABASE_URL: pgUrl('access', compose.REZICS_ACCESS_PASSWORD, compose.POSTGRES_PORT),
    CONTENT_DATABASE_URL: pgUrl('content', compose.REZICS_CONTENT_PASSWORD, compose.POSTGRES_PORT),
    ACCOUNT_DATABASE_URL: pgUrl('account', compose.REZICS_ACCOUNT_PASSWORD, compose.POSTGRES_PORT),
    ACCOUNT_ACCESS_DATABASE_URL: pgUrl('access', compose.REZICS_ACCESS_PASSWORD, compose.POSTGRES_PORT),
    ACCOUNT_RELAY_DATABASE_URL: pgUrl('relay', compose.REZICS_RELAY_PASSWORD, compose.POSTGRES_PORT),
    MAIN_RELAY_DATABASE_URL: pgUrl('relay', compose.REZICS_RELAY_PASSWORD, compose.POSTGRES_PORT),
    MAIN_RELAY_CONSUMER: 'main-graph-v1',
    ACCOUNT_BASE_URL: account, ACCOUNT_SERVICE_ORIGIN: service, ACCOUNT_PORT: compose.ACCOUNT_PORT,
    ...(compose.ACCOUNTS_PORT ? { ACCOUNTS_PORT: compose.ACCOUNTS_PORT } : {}),
    // Each stack's Account email reaches that stack's Mailpit, not the shared one.
    ...(compose.MAILPIT_SMTP_PORT ? { ACCOUNT_SMTP_PORT: compose.MAILPIT_SMTP_PORT } : {}),
    ACCOUNT_ISSUER: `${account}/api/auth`,
    ACCOUNT_JWKS_URL: `${service}/api/auth/jwks`,
    ACCOUNT_INTROSPECT_URL: `${service}/api/auth/oauth2/introspect`,
    ACCOUNT_MAIN_RESOURCE: 'https://main.rezics.test',
    MAIN_RESOURCE: 'https://main.rezics.test',
    MAIN_ORIGIN: `http://127.0.0.1:${compose.MAIN_PORT}`,
    ACCOUNT_ORIGIN: account,
    ACCOUNT_SECRET: compose.ACCOUNT_SECRET,
    ACCOUNT_MAIN_CLIENT_ID: compose.ACCOUNT_MAIN_CLIENT_ID,
    ACCOUNT_MAIN_CLIENT_SECRET: compose.ACCOUNT_MAIN_CLIENT_SECRET,
    MAIN_PORT: compose.MAIN_PORT, MAIN_DATA_EPOCH: compose.MAIN_DATA_EPOCH,
    MAIN_ROUTING_EPOCH: compose.MAIN_ROUTING_EPOCH,
    MAIN_OBJECT_DIRECTORY: join(dir, 'objects'),
    MAIN_OPEN_LIBRARY_FIXTURE_ROOT: resolve(dir, '../../..'),
    MAIN_S3_ENDPOINT: `http://127.0.0.1:${compose.RUSTFS_PORT}`,
    MAIN_S3_BUCKET: 'rezics-semantic',
    MAIN_S3_REGION: 'us-east-1',
    MAIN_S3_ACCESS_KEY: compose.RUSTFS_ACCESS_KEY,
    MAIN_S3_SECRET_KEY: compose.RUSTFS_SECRET_KEY,
    MAIN_CANDIDATE_DIRECTORY: join(dir, 'candidates'),
  };
}
