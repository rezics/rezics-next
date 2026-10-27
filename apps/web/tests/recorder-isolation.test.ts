import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const isolatable =
  process.platform === 'linux' &&
  Bun.spawnSync(['unshare', '--user', '--map-root-user', '--net', 'true'], { stderr: 'ignore' }).exitCode === 0;

for (const selection of ['named', 'discovered']) {
  test.skipIf(!isolatable)(
    `${selection} tests isolate browsers, let the recorder reach host ports, and retain a browser failure`,
    async () => {
      mkdirSync(join(root, '.temp'), { recursive: true });
      const directory = mkdtempSync(join(root, '.temp/recorder-isolation-'));
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('published port') });
      const browser = join(directory, 'browser.test.ts');
      const recorder = join(directory, 'record-script.test.ts');
      const browserResult = join(directory, 'browser.json');
      const recorderResult = join(directory, 'recorder.txt');
      try {
        writeFileSync(
          browser,
          `import { test } from 'bun:test';
import { networkInterfaces } from 'node:os';
test('browser probe', async () => {
  let reachable = false;
  try { reachable = (await fetch(${JSON.stringify(server.url.href)})).ok; } catch {}
  await Bun.write(${JSON.stringify(browserResult)}, JSON.stringify({ names: Object.keys(networkInterfaces()), reachable }));
  throw new Error('deliberate browser failure');
});`,
        );
        writeFileSync(
          recorder,
          `import { test } from 'bun:test';
test('recorder probe', async () => {
  await Bun.write(${JSON.stringify(recorderResult)}, await (await fetch(${JSON.stringify(server.url.href)})).text());
});`,
        );
        const child = Bun.spawn(
          [
            process.execPath,
            join(root, 'apps/web/scripts/isolated.ts'),
            process.execPath,
            'test',
            ...(selection === 'named' ? [browser, recorder] : []),
          ],
          {
            cwd: directory,
            env: { ...process.env, REZICS_STACK_LEASE_DIR: join(directory, 'lease'), REZICS_STACK_SLOTS: '1' },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, `${stdout}\n${stderr}`).toBe(1);
        expect(JSON.parse(readFileSync(browserResult, 'utf8'))).toEqual({ names: ['lo'], reachable: false });
        expect(readFileSync(recorderResult, 'utf8')).toBe('published port');
      } finally {
        server.stop(true);
        rmSync(directory, { recursive: true, force: true });
      }
    },
    600_000,
  );
}
