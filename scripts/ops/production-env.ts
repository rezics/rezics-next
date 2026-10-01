import { readFileSync } from 'node:fs';
import { cleanEnv, url, type ValidatorSpec } from 'envalid';
import { Pool } from 'pg';
import { mainSpec, relaySpec, relayInitSpec } from '../../services/main/src/config.ts';
import { accountSpec, accountCoreSpec } from '../../services/account/src/config.ts';
import { webSpec } from '../../apps/web/features/config/env.ts';
import { accountsSpec } from '../../apps/accounts/features/config/env.ts';

export const productionSpecs = {
  main: mainSpec,
  relay: relaySpec,
  'relay-init': relayInitSpec,
  account: accountSpec,
  migrate: {
    ...accountCoreSpec,
    ACCESS_DATABASE_URL: mainSpec.ACCESS_DATABASE_URL,
    CONTENT_DATABASE_URL: mainSpec.CONTENT_DATABASE_URL,
    MAIN_RELAY_DATABASE_URL: relaySpec.MAIN_RELAY_DATABASE_URL,
  },
  web: webSpec,
  accounts: accountsSpec,
  about: {
    ABOUT_SITE_URL: url({ desc: 'Canonical public about origin.' }),
  },
};
export type ProductionRole = keyof typeof productionSpecs;

/** Explicit classification is the guard for future envalid development examples
 * and defaults. Private storage may be local to a host; public origins cannot. */
export const developmentValues: Record<
  string,
  'private-url' | 'public-url' | 'secret' | 'fixture' | 'directory' | 'smtp' | 'sender'
> = {
  FUSEKI_URL: 'private-url',
  ACCESS_DATABASE_URL: 'private-url',
  CONTENT_DATABASE_URL: 'private-url',
  MAIN_RELAY_DATABASE_URL: 'private-url',
  ACCOUNT_RELAY_DATABASE_URL: 'private-url',
  OWNER_RELAY_DATABASE_URL: 'private-url',
  ACCOUNT_RECOVERY_DATABASE_URL: 'private-url',
  OWNER_RELOCATION_TARGET_URL: 'private-url',
  ACCOUNT_DATABASE_URL: 'private-url',
  ACCOUNT_ACCESS_DATABASE_URL: 'private-url',
  MAIN_S3_ENDPOINT: 'private-url',
  ACCOUNT_JWKS_URL: 'private-url',
  ACCOUNT_INTROSPECT_URL: 'private-url',
  ACCOUNT_SERVICE_ORIGIN: 'private-url',
  MAIN_ORIGIN: 'private-url',
  ACCOUNT_ORIGIN: 'private-url',
  ACCOUNT_ISSUER: 'public-url',
  ACCOUNT_MAIN_RESOURCE: 'public-url',
  ACCOUNT_BASE_URL: 'public-url',
  MAIN_RESOURCE: 'public-url',
  WEB_ORIGIN: 'public-url',
  ABOUT_SITE_URL: 'public-url',
  FUSEKI_MAINTENANCE_TOKEN: 'secret',
  FUSEKI_COMMAND_TOKEN: 'secret',
  FUSEKI_TITLE_ADMISSION_KEY: 'secret',
  MAIN_S3_ACCESS_KEY: 'secret',
  MAIN_S3_SECRET_KEY: 'secret',
  ACCOUNT_MAIN_CLIENT_ID: 'secret',
  ACCOUNT_MAIN_CLIENT_SECRET: 'secret',
  ACCOUNT_SECRET: 'secret',
  WEB_OAUTH_CLIENT_ID: 'secret',
  MAIN_NOTIFICATION_PROVIDER_TOKEN: 'secret',
  MAIN_NOTIFICATION_CALLBACK_SECRET: 'secret',
  RECOVERY_MANIFEST_HMAC_KEY: 'secret',
  MAIN_OPEN_LIBRARY_FIXTURE_ROOT: 'fixture',
  MAIN_OBJECT_DIRECTORY: 'directory',
  ACCOUNT_SMTP_HOST: 'smtp',
  ACCOUNT_EMAIL_FROM: 'sender',
};

export function isDevelopmentValue(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|\.test(?:[/:]|$)|\.temp[\/]|<[^>]+>|example|changeme|mailpit|^(?:password|secret)$/i.test(
      value,
    )
  );
}

export function assertClassifiedDefaults(
  specs: Record<string, Record<string, ValidatorSpec<unknown>>> = productionSpecs,
) {
  for (const spec of Object.values(specs))
    for (const [name, validator] of Object.entries(spec)) {
      if (
        (isDevelopmentValue(validator.default) || isDevelopmentValue(validator.example)) &&
        !developmentValues[name]
      ) {
        throw new Error(`Unclassified development configuration: ${name}`);
      }
    }
}

function loopback(hostname: string) {
  let normalized = hostname;
  try {
    normalized = new URL(
      `http://${hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname}`,
    ).hostname;
  } catch {
    /* DNS names are also checked below. */
  }
  const host = normalized
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^::ffff:(?:127\.|7f)/.test(host)
  );
}

export function checkProductionEnv(
  env: Record<string, string | undefined>,
  roles: ProductionRole[] = ['main', 'account', 'relay', 'relay-init', 'migrate'],
) {
  assertClassifiedDefaults();
  const specs = Object.assign({}, ...roles.map((role) => productionSpecs[role])) as Record<
    string,
    ValidatorSpec<unknown>
  >;
  const config = cleanEnv(env, specs, {
    reporter: ({ errors }) => {
      const names = Object.keys(errors);
      if (names.length) throw new Error(`Invalid production configuration: ${names.join(', ')}`);
    },
  });
  const values = Object.fromEntries(
    Object.keys(specs).map((name) => [name, (config as Record<string, unknown>)[name]]),
  );
  for (const [name, rule] of Object.entries(developmentValues)) {
    // Check all supplied fields too: a per-role entrypoint must not overlook a
    // fixture or public origin carried in a combined environment file.
    const value = env[name] ?? values[name];
    if (value === undefined || value === '') continue;
    const text = String(value);
    if (rule === 'fixture') throw new Error(`Production forbids ${name}`);
    if (rule === 'directory' && /(?:^|\/)\.temp(?:\/|$)|fixture/i.test(text))
      throw new Error(`Production forbids development ${name}`);
    if (
      rule === 'secret' &&
      /<[^>]+>|example|changeme|generated by task|^secret$|^password$/i.test(text)
    )
      throw new Error(`Production requires a real ${name}`);
    if (rule === 'smtp' && (loopback(text) || /mailpit/i.test(text)))
      throw new Error('Production requires a remote SMTP host');
    if (rule === 'sender' && /localhost|example|\.test(?:>|$)/i.test(text))
      throw new Error('Production requires a verified sender');
    if (rule === 'public-url' || rule === 'private-url') {
      const parsed = new URL(text);
      if (
        loopback(parsed.hostname) ||
        /\.(?:test|example|invalid)$|(?:^|\.)example\.(?:com|org|net)$|^mailpit$/i.test(
          parsed.hostname,
        )
      ) {
        throw new Error(`Production forbids development ${name}`);
      }
      if (rule === 'public-url' && parsed.protocol !== 'https:')
        throw new Error(`Production requires HTTPS for ${name}`);
      if (/^(?:password|secret|changeme|example)$/i.test(decodeURIComponent(parsed.password)))
        throw new Error(`Production requires a real credential for ${name}`);
    }
  }
  if (
    'ACCOUNT_SMTP_HOST' in specs &&
    !values.ACCOUNT_SMTP_SECURE &&
    !values.ACCOUNT_SMTP_REQUIRE_TLS
  ) {
    throw new Error('Production SMTP requires TLS');
  }
  if (/^(?:true|1)$/i.test(env.ACCOUNTS_COUNTRY_FROM_HEADER ?? ''))
    throw new Error('Production takes the sign-up country from the Cloudflare edge, never ACCOUNTS_COUNTRY_FROM_HEADER');
  for (const name of [
    'FUSEKI_MAINTENANCE_TOKEN',
    'FUSEKI_COMMAND_TOKEN',
    'FUSEKI_TITLE_ADMISSION_KEY',
  ]) {
    if (env[name] && !/^[a-f0-9]{64}$/.test(env[name]!))
      throw new Error(`${name} requires a 64-character lowercase hex capability`);
  }
  if (
    env.FUSEKI_TITLE_ADMISSION_KEY &&
    [env.FUSEKI_MAINTENANCE_TOKEN, env.FUSEKI_COMMAND_TOKEN].includes(
      env.FUSEKI_TITLE_ADMISSION_KEY,
    )
  ) {
    throw new Error('FUSEKI_TITLE_ADMISSION_KEY must be independently provisioned');
  }
  if (
    env.MAIN_RELAY_DATABASE_URL &&
    env.ACCOUNT_RELAY_DATABASE_URL &&
    env.MAIN_RELAY_DATABASE_URL !== env.ACCOUNT_RELAY_DATABASE_URL
  )
    throw new Error('Production release requires one shared relay database');
  return config;
}

export function readProductionEnv(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1]!))
      throw new Error('Invalid or duplicate environment field');
    const value = match[2]!;
    values[match[1]!] = /^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value;
  }
  return values;
}

/** No provider, even disabled fake rows, is deployable before Stripe approval. */
export async function assertNoPaymentProvider(url: string, allowUnmigrated = false) {
  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  try {
    const exists = await pool.query("SELECT to_regclass('commerce.payment_provider') AS name");
    if (!exists.rows[0]?.name && allowUnmigrated) return;
    const result = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM commerce.payment_provider) AS present',
    );
    if (result.rows[0]?.present !== false)
      throw new Error('Production forbids payment provider rows before approval');
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('ops:env-check requires an environment file');
  const env = readProductionEnv(path);
  checkProductionEnv(env);
  await assertNoPaymentProvider(env.ACCESS_DATABASE_URL!, true);
  console.log('Production configuration accepted; payments disabled');
}
