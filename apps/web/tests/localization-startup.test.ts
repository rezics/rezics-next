import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const app = join(import.meta.dir, '..');
const temporary = join(app, '../../.temp');

test('the Vite localization hook runs its compiler when Vite loads under Node', async () => {
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'localization-startup-'));
  const output = join(directory, 'generated');
  const compiler = join(directory, 'compiler.mjs');
  writeFileSync(
    compiler,
    `import { writeFileSync } from 'node:fs';\nexport async function compile() { writeFileSync(${JSON.stringify(output)}, 'generated'); }\n`,
  );
  try {
    const child = Bun.spawn(
      [
        'node',
        '--input-type=module',
        '--eval',
        `import { loadConfigFromFile } from 'vite';
const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' });
const hook = loaded.config.plugins.flat(Infinity).find(plugin => plugin?.name === 'generate-localization');
await hook.config({}, { command: 'serve', mode: 'development' });`,
      ],
      {
        cwd: app,
        env: { ...process.env, REZICS_PARAGLIDE_COMPILER_MODULE: compiler },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(existsSync(output)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
