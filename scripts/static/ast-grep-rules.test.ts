import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

// The rule tests (valid and invalid cases plus their snapshots) ran only when someone
// remembered `task ast-grep -- test`, so a rule could stop matching without any tier noticing.
test('every ast-grep rule matches its invalid cases, spares its valid ones and keeps its snapshot', () => {
  const result = Bun.spawnSync({
    cmd: [join(root, 'node_modules/.bin/ast-grep'), 'test'],
    cwd: root, stdout: 'pipe', stderr: 'pipe',
  });
  expect(`${result.stdout}${result.stderr}`).toContain('test result: ok');
  expect(result.exitCode).toBe(0);
});
