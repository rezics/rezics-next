import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseOptions, readEnv, stackDirectory } from './config.ts';
import { runWorkerPreview } from './preview.ts';

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
const directory = stackDirectory(root, options);
const appFile = join(directory, 'apps.env');
if (!existsSync(appFile)) throw new Error('Start the matching QA stack before web:preview');
const apps = readEnv(appFile);
const runtimePath = join(directory, 'web-auth', 'runtime.env');
const publicPath = join(directory, 'web-auth', 'public.json');
const runtime = existsSync(runtimePath) ? readEnv(runtimePath) : {};
const publicConfig = existsSync(publicPath)
  ? JSON.parse(await Bun.file(publicPath).text()) as { clientId: string } : undefined;
const port = previewPort();
// The QA runner holds this port until the build finishes. The holder is released before wrangler binds.
await runWorkerPreview({
  root, directory: join(root, 'apps/web'), port, buildFailure: 'Web Worker build failed',
  env: { ...process.env, ...apps, ...runtime, ...(publicConfig ? { WEB_OAUTH_CLIENT_ID: publicConfig.clientId } : {}) },
}, Number(process.env.REZICS_WEB_E2E_PORT_HOLDER));
