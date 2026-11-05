import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve(import.meta.dir, '../../src/library');
const sources = readdirSync(directory)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file, lines: readFileSync(resolve(directory, file), 'utf8').split('\n') }));

const computedDeadline = /(?:Date\.now\(\)|getTime\(\))\s*\+/;
const namedBudget = /\b[A-Z_]*BUDGET_MS\b/;

test('library code takes every deadline from deadlineFor with one wall-clock work budget', () => {
  const offenders = sources.flatMap(({ file, lines }) =>
    lines.flatMap((line, index) =>
      computedDeadline.test(line) || namedBudget.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
    ),
  );
  expect(offenders).toEqual([]);
  const declarations = sources.flatMap(({ file, lines }) =>
    lines.filter((line) => /\bconst WORK_STEP_DEADLINE_MS = [0-9_]+;/.test(line)).map(() => file),
  );
  expect(declarations).toEqual(['work-step-policy.ts']);
  const users = sources.filter(({ lines }) =>
    lines.some((line) => line.includes('deadlineFor(WORK_STEP_DEADLINE_MS)')),
  );
  expect(users.map(({ file }) => file).sort()).toEqual(
    [
      'collection-reads.ts',
      'collections.ts',
      'command-support.ts',
      'follows.ts',
      'subject-anchor.ts',
      'views.ts',
    ].sort(),
  );
});

test('the library outcome driver configures the kernel request deadline', () => {
  const driver = readFileSync(resolve(import.meta.dir, 'support/outcome-driver.ts'), 'utf8');
  expect(driver).toContain('requestDeadlineMs: 30_000');
});
