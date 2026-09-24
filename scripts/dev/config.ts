import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Profile = 'dev' | 'qa';
export interface StackOptions { profile: Profile; runId?: string }

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
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile' && (args[i + 1] === 'dev' || args[i + 1] === 'qa')) {
      profile = args[++i] as Profile;
    } else if (args[i] === '--run-id' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(args[i + 1] ?? '')) {
      runId = args[++i];
    } else {
      throw new Error(`Invalid stack option: ${args[i] ?? ''}`);
    }
  }
  if (profile === 'dev' && runId) throw new Error('--run-id requires --profile qa');
  return { profile, runId };
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

export function savePrivate(path: string, values: Record<string, string | number>): void {
  writeFileSync(path, serializeEnv(values), { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

export function ensureSecrets(root: string, options: StackOptions,
  ports: Record<string, number> = DEV_PORTS): Record<string, string> {
  const dir = stackDirectory(root, options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, 'compose.env');
  if (!existsSync(path)) savePrivate(path, { ...createSecrets(), ...ports });
  return readEnv(path);
}

export function devPorts(): Record<string, number> { return { ...DEV_PORTS }; }

function pgUrl(role: string, password: string, port: string): string {
  return `postgres://${role}:${encodeURIComponent(password)}@127.0.0.1:${port}/${role}`;
}

export function appEnvironment(compose: Record<string, string>, dir: string): Record<string, string> {
  const account = `http://127.0.0.1:${compose.ACCOUNT_PORT}`;
  return {
    FUSEKI_URL: `http://127.0.0.1:${compose.FUSEKI_PORT}/rezics/`,
    ACCESS_DATABASE_URL: pgUrl('access', compose.REZICS_ACCESS_PASSWORD, compose.POSTGRES_PORT),
    ACCOUNT_DATABASE_URL: pgUrl('account', compose.REZICS_ACCOUNT_PASSWORD, compose.POSTGRES_PORT),
    ACCOUNT_ACCESS_DATABASE_URL: pgUrl('access', compose.REZICS_ACCESS_PASSWORD, compose.POSTGRES_PORT),
    ACCOUNT_RELAY_DATABASE_URL: pgUrl('relay', compose.REZICS_RELAY_PASSWORD, compose.POSTGRES_PORT),
    ACCOUNT_BASE_URL: account, ACCOUNT_PORT: compose.ACCOUNT_PORT,
    ACCOUNT_ISSUER: `${account}/api/auth`,
    ACCOUNT_JWKS_URL: `${account}/api/auth/jwks`,
    ACCOUNT_INTROSPECT_URL: `${account}/api/auth/oauth2/introspect`,
    ACCOUNT_MAIN_RESOURCE: 'https://main.rezics.test',
    ACCOUNT_SECRET: compose.ACCOUNT_SECRET,
    ACCOUNT_MAIN_CLIENT_ID: compose.ACCOUNT_MAIN_CLIENT_ID,
    ACCOUNT_MAIN_CLIENT_SECRET: compose.ACCOUNT_MAIN_CLIENT_SECRET,
    MAIN_PORT: compose.MAIN_PORT, MAIN_DATA_EPOCH: compose.MAIN_DATA_EPOCH,
    MAIN_ROUTING_EPOCH: compose.MAIN_ROUTING_EPOCH,
    MAIN_OBJECT_DIRECTORY: join(dir, 'objects'),
    MAIN_CANDIDATE_DIRECTORY: join(dir, 'candidates'),
  };
}
