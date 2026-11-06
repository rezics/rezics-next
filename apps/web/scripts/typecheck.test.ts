import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('the owning compiler includes executable scripts without Worker ambient types', () => {
  const cwd = resolve(import.meta.dir, '..');
  const result = Bun.spawnSync(
    [resolve(cwd, '../../node_modules/.bin/tsc'), '--showConfig', '-p', 'tsconfig.scripts.json'],
    { cwd },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const config = JSON.parse(result.stdout.toString()) as {
    files: string[];
    compilerOptions: { types: string[] };
    contentMappers: { package: string; extensions: string[] }[];
  };
  for (const file of ['check', 'record', 'seeded-content-ratings-reviews-walk', 'seeded-question-management-walk'])
    expect(config.files).toContain(`./scripts/${file}.ts`);
  expect(config.compilerOptions.types).toEqual(['bun']);
  expect(config.contentMappers).toContainEqual({ package: 'reylo', extensions: ['.sql'] });
});
