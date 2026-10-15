import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LaunchOptions } from 'playwright';

/** Linux loopback QA keeps the real Chromium transport without watching Docker interfaces. */
export function loopbackChromiumLaunch(origin: string, env: NodeJS.ProcessEnv = process.env): LaunchOptions {
  if (process.platform !== 'linux' || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) return {};
  // Task and Playwright run at the repository root, including Node's CJS config loader.
  const source = resolve('scripts/qa/chromium-loopback.c');
  const key = createHash('sha256').update(readFileSync(source)).update(process.arch).digest('hex').slice(0, 16);
  const directory = resolve('.temp/chromium-loopback', key);
  const library = join(directory, 'loopback.so');
  if (!existsSync(library)) {
    mkdirSync(directory, { recursive: true });
    const staged = `${library}.${process.pid}.next`;
    try {
      const build = spawnSync('cc', ['-shared', '-fPIC', '-Wall', '-Wextra', '-Werror', '-o', staged, source, '-ldl'],
        { encoding: 'utf8', timeout: 30_000 });
      if (build.status !== 0 || build.error) throw new Error(`Chromium loopback launch build failed: ${build.stderr || build.error?.message}`);
      renameSync(staged, library);
    } finally { rmSync(staged, { force: true }); }
  }
  return { env: { ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    LD_PRELOAD: [library, env.LD_PRELOAD].filter(Boolean).join(':') } };
}
