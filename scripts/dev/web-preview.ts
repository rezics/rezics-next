import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { releaseHeldWebPort } from '../qa/e2e.ts';
import { parseOptions, readEnv, stackDirectory } from './config.ts';

function previewPort(): string {
  const configured = process.env.REZICS_WEB_E2E_BASE_URL;
  if (!configured) return '3003';
  const url = new URL(configured);
  if (!url.port) throw new Error('REZICS_WEB_E2E_BASE_URL needs an explicit port');
  return url.port;
}

const root = resolve(import.meta.dir, '../..');
const options = parseOptions(process.argv.slice(2));
if (options.profile !== 'qa') throw new Error('web:preview requires an isolated QA profile');
const appFile = join(stackDirectory(root, options), 'apps.env');
if (!existsSync(appFile)) throw new Error('Start the matching QA stack before web:preview');
const apps = readEnv(appFile);
const authDir = join(stackDirectory(root, options), 'web-auth');
const runtimePath = join(authDir, 'runtime.env');
const publicPath = join(authDir, 'public.json');
const runtime = existsSync(runtimePath) ? readEnv(runtimePath) : {};
const publicConfig = existsSync(publicPath)
  ? JSON.parse(await Bun.file(publicPath).text()) as { clientId: string } : undefined;
const env = { ...process.env, ...apps, ...runtime,
  ...(publicConfig ? { WEB_OAUTH_CLIENT_ID: publicConfig.clientId } : {}) };
const web = join(root, 'apps/web');
const built = spawnSync(join(root, 'node_modules/.bin/vinext'), ['build'],
  { cwd: web, env, stdio: 'inherit' });
if (built.error || built.status !== 0) throw built.error ?? new Error('Web Worker build failed');
const port = previewPort();
const holderPid = Number(process.env.REZICS_WEB_E2E_PORT_HOLDER);
// The QA runner holds this port until the build finishes. Release it now so wrangler can bind it.
if (Number.isInteger(holderPid) && holderPid > 0) await releaseHeldWebPort(holderPid, Number(port));
const worker = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev',
  '--config', 'dist/server/wrangler.json', '--ip', '127.0.0.1', '--port', port],
{ cwd: web, env, stdio: 'inherit' });
process.once('SIGINT', () => worker.kill('SIGTERM'));
process.once('SIGTERM', () => worker.kill('SIGTERM'));
const code = await new Promise<number | null>(resolveExit => worker.once('exit', resolveExit));
if (code !== 0 && code !== null) process.exitCode = code;
