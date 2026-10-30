import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const app = join(import.meta.dir, '..');
const root = resolve(app, '../..');
// Documented names are `<story id>.<locale>.<theme>.png`.
// The documented viewport is 1280×720 CSS pixels. A full-page capture of a page that fits the viewport, such as the
// missing-subject page, is 1280×720: the shell fills the viewport exactly, so a short page does not scroll.
const story = 'pages-subjects-missing-subject--signed-out';
const pngSize = { width: 1280, height: 720 };
const names = ['en', 'ja'].flatMap((locale) =>
  (['light', 'dark'] as const).map((theme) => `${story}.${locale}.${theme}.png`),
);
const timeout = 600_000;

function screenshotSettle() {
  const source = readFileSync(join(app, 'scripts/screenshots.ts'), 'utf8');
  const start = source.indexOf('async function settle(');
  const end = source.indexOf('\nasync function captureOne(', start);
  if (start < 0 || end < 0) throw new Error('The screenshot capture settle function is missing.');
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${source.slice(start, end)}\nreturn settle;`);
  return new Function(compiled)() as (
    page: {
      waitForFunction: (...args: unknown[]) => Promise<unknown>;
      evaluate: (...args: unknown[]) => Promise<unknown>;
    },
    id: string,
    pageErrors?: readonly string[],
  ) => Promise<void>;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const end = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return undefined;
  if (bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return undefined;
  if (!bytes.subarray(bytes.length - 12).equals(end)) return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function start(out: string): { child: ChildProcess; done: Promise<{ code: number; stdout: string; stderr: string }> } {
  const child = spawn(
    'bun',
    [
      'run',
      'screenshots',
      '--story',
      story,
      '--locale',
      'en',
      '--locale',
      'ja',
      '--theme',
      'light',
      '--theme',
      'dark',
      '--width',
      String(pngSize.width),
      '--out',
      out,
    ],
    {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', STORYBOOK_DISABLE_TELEMETRY: '1' },
    },
  );
  const keep = (chunks: Buffer[]) => (chunk: Buffer) => chunks.push(chunk);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout!.on('data', keep(stdout));
  child.stderr!.on('data', keep(stderr));
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    child.once('exit', (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      }),
    );
  });
  return { child, done };
}

test(
  'the screenshot script captures every chosen story in each chosen locale and theme',
  async () => {
    mkdirSync(join(root, '.temp'), { recursive: true });
    const out = mkdtempSync(join(root, '.temp/screenshots-'));
    const { child, done } = start(out);
    try {
      const result = await done;
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readdirSync(out).sort()).toEqual([...names].sort());
      const images = new Map<string, Buffer>();
      for (const name of names) {
        const bytes = readFileSync(join(out, name));
        expect(pngDimensions(bytes), name).toEqual(pngSize);
        images.set(name, bytes);
      }
      const en = images.get(`${story}.en.light.png`)!;
      const ja = images.get(`${story}.ja.light.png`)!;
      expect(Buffer.compare(en, ja), 'English and Japanese captures differ').not.toBe(0);
      expect(Buffer.compare(en, images.get(`${story}.en.dark.png`)!), 'light and dark captures differ').not.toBe(0);
    } finally {
      if (child?.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
      }
      rmSync(out, { recursive: true, force: true });
    }
  },
  timeout,
);

test('a story render error fails capture with its story id and the page error', async () => {
  const id = 'pages-capture-failure--throws-while-rendering';
  const settle = screenshotSettle();
  const page = {
    waitForFunction: async () => undefined,
    evaluate: async () => 'errored',
  };
  const message = await settle(page, id, ['Synthetic render failure']).then(
    () => '',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  expect(message).toContain(id);
  expect(message).toContain('Synthetic render failure');
});
