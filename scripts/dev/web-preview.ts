import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseOptions, readEnv, stackDirectory } from './config.ts';

const root = resolve(import.meta.dir, '../..');
const options = parseOptions(process.argv.slice(2));
if (options.profile !== 'qa') throw new Error('web:preview requires an isolated QA profile');
const appFile = join(stackDirectory(root, options), 'apps.env');
if (!existsSync(appFile)) throw new Error('Start the matching QA stack before web:preview');
const apps = readEnv(appFile);
const env = { ...process.env, ...apps };
const built = spawnSync('corepack', ['yarn', 'workspace', '@rezics/web', 'build'],
  { cwd: root, env, stdio: 'inherit' });
if (built.error || built.status !== 0) throw built.error ?? new Error('Web Worker build failed');
const worker = spawn('corepack', ['yarn', 'workspace', '@rezics/web', 'exec', 'wrangler', 'dev',
  '--config', 'dist/server/wrangler.json', '--ip', '127.0.0.1', '--port', '3003'],
{ cwd: root, env, stdio: 'inherit' });
process.once('SIGINT', () => worker.kill('SIGTERM'));
process.once('SIGTERM', () => worker.kill('SIGTERM'));
const code = await new Promise<number | null>(resolveExit => worker.once('exit', resolveExit));
if (code !== 0 && code !== null) process.exitCode = code;
