// Rezics development AppHost, started by `task dev` (scripts/dev/cli.ts).
//
// - main:     the main checkout; shared Account, Main, Accounts app, web and
//             Storybook on the fixed ports 3002, 3001, 3004, 3000 and 6006
//             through Aspire's proxy.
// - frontend: a worktree; the Accounts app, web and Storybook on random ports
//             against the shared backend, which appears here as external services.
// - backend:  a worktree with --backend; its own isolated stack and services. Its
//             Accounts app binds the stack's ACCOUNTS_PORT, the issuer origin.
//
// The Accounts app is the public Account origin: web reaches Account through it,
// and it proxies the Account service, so the session cookie stays on its origin.
//
// scripts/dev owns storage and writes the environment file this reads. Each
// process receives only the variables its envalid spec declares; secrets are
// Aspire secret parameters, and service addresses flow through endpoint
// references so ports can be fixed or random.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mainSpec } from '../services/main/src/config.ts';
import { accountSpec } from '../services/account/src/config.ts';
import { webSpec } from '../apps/web/features/config/env.ts';
import { accountsSpec } from '../apps/accounts/features/config/env.ts';
import { createBuilder } from './.aspire/modules/aspire.mjs';

const root = resolve(import.meta.dirname, '..');
const web = resolve(root, 'apps/web');
const accountsApp = resolve(root, 'apps/accounts');
const mode = process.env.REZICS_DEV_MODE ?? 'main';
if (!['main', 'frontend', 'backend'].includes(mode)) throw new Error(`Unknown REZICS_DEV_MODE: ${mode}`);
const envFile = process.env.REZICS_DEV_ENV;
if (!envFile) throw new Error('REZICS_DEV_ENV is unset; start the AppHost with `task dev`');
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(Boolean)
  .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const secretName = /SECRET|TOKEN|KEY|PASSWORD|_DATABASE_URL$/;

const builder = await createBuilder();
const parameters = new Map<string, ReturnType<typeof builder.addParameter>>();
function secret(name: string) {
  let parameter = parameters.get(name);
  if (!parameter) {
    parameter = builder.addParameter(name.toLowerCase().replaceAll('_', '-'), { value: env[name]!, secret: true });
    parameters.set(name, parameter);
  }
  return parameter;
}

/** Pass the variables a spec declares, except those Aspire assigns. */
function configure<T extends { withEnvironment(name: string, value: never): T }>(resource: T,
  spec: Record<string, unknown>, assigned: string[] = []): T {
  let result = resource;
  for (const name of Object.keys(spec)) {
    if (assigned.includes(name) || env[name] === undefined) continue;
    result = result.withEnvironment(name, (secretName.test(name) ? secret(name) : env[name]) as never);
  }
  return result;
}

let mainUrl;
let accountUrl;
let backend;
if (mode === 'frontend') {
  const account = builder.addExternalService('account', `http://127.0.0.1:${env.ACCOUNT_PORT}/`)
    .withHttpHealthCheck({ path: '/health/ready' });
  const main = builder.addExternalService('main', `http://127.0.0.1:${env.MAIN_PORT}/`)
    .withHttpHealthCheck({ path: '/health/ready' });
  accountUrl = account;
  mainUrl = main;
  backend = main;
} else {
  // The main checkout keeps fixed ports on Aspire's proxy and gives each process
  // its own listening port. A worktree stack already assigned these ports, and
  // its issuer URL is built from them, so they bind directly.
  const fixed = mode === 'main';
  const serviceEndpoint = (port: number, variable: string) => fixed
    ? { port, env: variable }
    : { port: Number(env[variable]), isProxied: false };
  const account = configure(builder.addExecutable('account', 'bun', root,
    ['--watch', 'services/account/src/index.ts']), accountSpec, fixed ? ['ACCOUNT_PORT'] : [])
    .withHttpEndpoint(serviceEndpoint(3002, 'ACCOUNT_PORT'))
    .withHttpHealthCheck({ path: '/health/ready' });
  const main = configure(builder.addExecutable('main', 'bun', root,
    ['--watch', 'services/main/src/index.ts']), mainSpec, fixed ? ['MAIN_PORT'] : [])
    .withHttpEndpoint(serviceEndpoint(3001, 'MAIN_PORT'))
    .withHttpHealthCheck({ path: '/health/ready' })
    .waitFor(account);
  accountUrl = account.getEndpoint('http');
  mainUrl = main.getEndpoint('http');
  backend = main;
}

const frontendEndpoint = (port: number) => mode === 'main' ? { port, env: 'PORT' } : { env: 'PORT' };
// A worktree backend's issuer is built from its ACCOUNTS_PORT, so it binds that
// port directly; a worktree frontend's app proxies to the shared service.
const accountsEndpoint = mode === 'backend' && env.ACCOUNTS_PORT
  ? { port: Number(env.ACCOUNTS_PORT), isProxied: false, env: 'PORT' } : frontendEndpoint(3004);
const accounts = configure(builder.addExecutable('accounts', 'sh', accountsApp,
  ['-c', 'exec ../../node_modules/.bin/vinext dev --hostname 127.0.0.1 --port "$PORT"']),
accountsSpec, ['ACCOUNT_SERVICE_ORIGIN', 'WEB_ORIGIN'])
  .withEnvironment('ACCOUNT_SERVICE_ORIGIN', accountUrl)
  .withHttpEndpoint(accountsEndpoint)
  .waitFor(backend);
const accountsUrl = accounts.getEndpoint('http');

const webApp = configure(builder.addExecutable('web', 'sh', web,
  ['-c', 'exec ../../node_modules/.bin/vinext dev --host 127.0.0.1 --port "$PORT"']),
webSpec, ['MAIN_ORIGIN', 'ACCOUNT_ORIGIN'])
  .withEnvironment('MAIN_ORIGIN', mainUrl)
  // Account accepts browser-originated writes only from its public base URL (the
  // Accounts app); Aspire's endpoint says localhost where that URL says 127.0.0.1.
  .withEnvironment('ACCOUNT_ORIGIN', env.ACCOUNT_BASE_URL ?? accountsUrl)
  .withHttpEndpoint(frontendEndpoint(3000))
  .waitFor(backend);
accounts.withEnvironment('WEB_ORIGIN', webApp.getEndpoint('http'));

builder.addExecutable('storybook', 'sh', web,
  ['-c', 'exec ../../node_modules/.bin/storybook dev --host 127.0.0.1 --no-open -p "$PORT"'])
  .withHttpEndpoint(frontendEndpoint(6006));

await builder.build().run();
