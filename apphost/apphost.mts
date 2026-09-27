// Rezics development AppHost. `task dev` prepares storage with
// `scripts/dev/cli.ts dev:prepare`, which writes the application environment,
// then starts this AppHost. Storage stays owned by scripts/dev; Aspire runs
// the application processes, health-orders them and exposes them to agents
// through its dashboard, CLI and MCP server.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBuilder } from './.aspire/modules/aspire.mjs';

const root = resolve(import.meta.dirname, '..');
const envFile = process.env.REZICS_DEV_ENV;
if (!envFile) throw new Error('REZICS_DEV_ENV is unset; start the AppHost with `task dev`');
const profile = process.env.REZICS_DEV_PROFILE === 'qa' ? 'qa' : 'dev';
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(Boolean)
  .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

// The dev profile keeps the documented fixed ports on Aspire's proxy and gives
// each process its own listening port through the named variable. A QA stack
// already assigns Account and Main ports, so those bind directly.
const fixed = profile === 'dev';
const endpoint = (port: number, variable: string) => fixed
  ? { port, env: variable }
  : { env: variable, isProxied: false };
const serviceEndpoint = (port: number, variable: string) => fixed
  ? { port, env: variable }
  : { port: Number(env[variable]), isProxied: false };
const ownPorts = new Set(['ACCOUNT_PORT', 'MAIN_PORT']);

const builder = await createBuilder();

let account = builder.addExecutable('account', 'bun', root, ['--watch', 'services/account/src/index.ts']);
for (const [key, value] of Object.entries(env)) {
  if (!fixed || !ownPorts.has(key)) account = account.withEnvironment(key, value);
}
account = account.withHttpEndpoint(serviceEndpoint(3002, 'ACCOUNT_PORT'))
  .withHttpHealthCheck({ path: '/health/ready' });

let main = builder.addExecutable('main', 'bun', root, ['--watch', 'services/main/src/index.ts']);
for (const [key, value] of Object.entries(env)) {
  if (!fixed || !ownPorts.has(key)) main = main.withEnvironment(key, value);
}
main = main.withHttpEndpoint(serviceEndpoint(3001, 'MAIN_PORT'))
  .withHttpHealthCheck({ path: '/health/ready' })
  .waitFor(account);

let web = builder.addExecutable('web', 'sh', resolve(root, 'apps/web'),
  ['-c', 'exec ../../node_modules/.bin/vinext dev --host 127.0.0.1 --port "$PORT"']);
for (const [key, value] of Object.entries(env)) web = web.withEnvironment(key, value);
web = web.withHttpEndpoint(endpoint(3000, 'PORT')).waitFor(main);

const storybook = builder.addExecutable('storybook', 'sh', resolve(root, 'apps/web'),
  ['-c', 'exec ../../node_modules/.bin/storybook dev --host 127.0.0.1 --no-open -p "$PORT"'])
  .withHttpEndpoint(endpoint(6006, 'PORT'));

await Promise.all([account, main, web, storybook]);
await builder.build().run();
