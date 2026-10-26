import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../src/semantic');
const ownBudget = /(?:Date|performance)\.now\(\)\s*\+/;
const fixedTimeout = /statement_timeout\s*=\s*'\d+\s*ms'/;

// A request has one deadline, fixed at arrival. Semantic code takes its budget from it through deadlineFor or the
// route's job.deadline; outside a request deadlineFor gives now plus the budget.
test('semantic code takes request budgets from the request deadline, never from now plus a constant', () => {
  const found: string[] = [];
  for (const file of [...new Bun.Glob('**/*.ts').scanSync({ cwd: root })].sort()) {
    const lines = readFileSync(resolve(root, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (ownBudget.test(line) || fixedTimeout.test(line)) found.push(`${file}:${index + 1}`);
    });
  }
  expect(found).toEqual([]);
});
