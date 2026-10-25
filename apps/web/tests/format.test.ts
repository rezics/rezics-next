import { expect, test } from 'bun:test';
import { join } from 'node:path';

// One formatter for the whole repository, configured in the root .oxfmtrc.json. Each package checks its own files.
const root = join(import.meta.dir, '..', '..', '..');
const oxfmt = join(root, 'node_modules', '.bin', 'oxfmt');

for (const pkg of ['apps/web', 'packages/ui', 'packages/document']) {
  test(`${pkg} follows the repository format`, () => {
    const result = Bun.spawnSync([oxfmt, '--list-different', '.'], {
      cwd: join(root, pkg),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.stdout.toString().trim()).toBe('');
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test(`${pkg} checks the format in its own check`, async () => {
    const { scripts } = await Bun.file(join(root, pkg, 'package.json')).json();
    expect(scripts.check).toMatch(/(^|&&\s*)oxfmt --check \.(\s|$)/);
  });
}
