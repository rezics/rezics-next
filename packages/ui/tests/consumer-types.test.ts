import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

// Apps import these sources directly and type-check them under the repository's base settings, so the package must
// compile under those settings too. Stories and their helpers are only for Storybook and are left out.
// The shadcn CLI writes code for default optional-property typing and the files are never edited by hand, so the
// three that do not satisfy `exactOptionalPropertyTypes` (the calendar, the code block and its highlighter) are
// left out here; the package's own `tsc` run checks them, and a page that imports one needs a task of its own.
const unstrict = [
  'shadcn/calendar.tsx',
  'shadcn/code-block.tsx',
  'lib/highlighter.tsx',
  'hooks/use-highlighted-code.ts',
];
test('the package sources type-check under the settings of the apps that import them', async () => {
  const directory = mkdtempSync(join(root, '.consumer-types-'));
  try {
    const config = join(directory, 'tsconfig.json');
    writeFileSync(
      config,
      JSON.stringify({
        extends: join(root, '..', '..', 'tsconfig.base.json'),
        compilerOptions: { jsx: 'react-jsx', lib: ['DOM', 'DOM.Iterable', 'ESNext'] },
        include: [join(root, 'src', '**', '*.ts'), join(root, 'src', '**', '*.tsx')],
        exclude: [
          join(root, 'src', '**', '*.stories.tsx'),
          join(root, 'src', 'stories'),
          join(root, 'src', 'test'),
          ...unstrict.map((file) => join(root, 'src', file)),
        ],
      }),
    );
    const run = Bun.spawn(['bun', 'x', 'tsc', '--noEmit', '-p', config], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
