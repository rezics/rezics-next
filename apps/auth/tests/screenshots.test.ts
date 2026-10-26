import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
const states = [
  'login',
  'login-error',
  'signup',
  'consent',
  'recovery-request',
  'recovery-password',
  'security',
  'account-delete',
  'organization-new',
  'step-up',
] as const;
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const themes = ['light', 'dark'] as const;
const required = states.flatMap((state) =>
  locales.flatMap((locale) => themes.map((theme) => `${state}.${locale}.${theme}.png`)),
);
const phone = locales.map((locale) => `login.${locale}.phone.png`);
const timeout = 900_000;

test(
  'bun run screenshots writes every Auth page state in all eight locales and both themes',
  async () => {
    mkdirSync(join(root, '.temp'), { recursive: true });
    const out = mkdtempSync(join(root, '.temp/auth-screenshots-'));
    const child = spawn('bun', ['run', 'screenshots', '--out', out], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
    const done = new Promise<number>((resolve) => {
      child.once('exit', (code) => resolve(code ?? 1));
    });

    try {
      const code = await done;
      const output = `${Buffer.concat(stdout).toString()}\n${Buffer.concat(stderr).toString()}`;
      expect(code, output).toBe(0);
      const names = readdirSync(out).sort();
      expect(names).toEqual([...required, ...phone].sort());
      for (const name of [...required, ...phone]) {
        const bytes = readFileSync(join(out, name));
        expect(bytes.length, `${name} is non-empty`).toBeGreaterThan(0);
        expect(bytes.subarray(0, 8), `${name} has the PNG signature`).toEqual(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
      }
    } finally {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
      }
      rmSync(out, { recursive: true, force: true });
    }
  },
  timeout,
);
