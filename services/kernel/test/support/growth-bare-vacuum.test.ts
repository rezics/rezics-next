import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';

const supportDirectory = dirname(fileURLToPath(import.meta.url));
const bareVacuumAllowlist = {
  'growth-settle.test.ts': 'Intentional negative control: demonstrates that bare VACUUM leaves index-probe excess.',
};

test('growth support tests use settle instead of issuing bare VACUUM statements', () => {
  const files = readdirSync(supportDirectory).filter((name) => /^growth.*\.test\.ts$/.test(name));
  const issuedVacuum = /\.query\s*\(\s*(['"`])\s*VACUUM\b/gi;
  const matches = new Map<string, string[]>();

  for (const file of files) {
    const source = readFileSync(join(supportDirectory, file), 'utf8');
    const statements = [...source.matchAll(issuedVacuum)].map((match) => match[0]);
    if (statements.length > 0) matches.set(file, statements);
  }

  expect(Object.keys(bareVacuumAllowlist)).toEqual(['growth-settle.test.ts']);
  expect(bareVacuumAllowlist['growth-settle.test.ts']).toContain('negative control');
  expect([...matches.keys()].filter((file) => !(file in bareVacuumAllowlist))).toEqual([]);
  expect(matches.get('growth-settle.test.ts')).toHaveLength(1);
});
