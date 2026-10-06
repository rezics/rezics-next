import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseOptions, readEnv, stackDirectory } from './config.ts';

// vinext dev keeps a compiler resident for the whole run. The QA tier serves the
// built Worker, the same way the web preview does, and wrangler only binds after the build.
const root = resolve(import.meta.dir, '../..');
const options = parseOptions(process.argv.slice(2));
if (options.profile !== 'qa') throw new Error('accounts:preview requires an isolated QA profile');
const appFile = join(stackDirectory(root, options), 'apps.env');
if (!existsSync(appFile)) throw new Error('Start the matching QA stack before accounts:preview');
const apps = readEnv(appFile);
if (!apps.ACCOUNTS_PORT) throw new Error('The QA stack has no public Accounts origin');
const webOrigin = process.env.REZICS_WEB_E2E_BASE_URL;
if (!webOrigin) throw new Error('accounts:preview requires REZICS_WEB_E2E_BASE_URL');
const env = { ...process.env, ...apps, WEB_ORIGIN: webOrigin };
const accounts = join(root, 'apps/accounts');
const built = spawnSync(join(root, 'node_modules/.bin/vinext'), ['build'],
  { cwd: accounts, env, stdio: 'inherit' });
if (built.error || built.status !== 0) throw built.error ?? new Error('Accounts Worker build failed');
const worker = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev',
  '--config', 'dist/server/wrangler.json', '--ip', '127.0.0.1', '--port', apps.ACCOUNTS_PORT],
{ cwd: accounts, env, stdio: 'inherit' });
process.once('SIGINT', () => worker.kill('SIGTERM'));
process.once('SIGTERM', () => worker.kill('SIGTERM'));
const code = await new Promise<number | null>(resolveExit => worker.once('exit', resolveExit));
if (code !== 0 && code !== null) process.exitCode = code;
