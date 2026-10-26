import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve(import.meta.dir, '../../src/library');
const sources = readdirSync(directory)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file, lines: readFileSync(resolve(directory, file), 'utf8').split('\n') }));

const literalBudget = /(?:Date\.now\(\)|getTime\(\))\s*\+\s*[0-9]/;
const namedBudget = /\b[A-Z_]*BUDGET_MS\b/;
const clockDeadline = /getTime\(\)/;

test('library code takes request deadlines from the request and work deadlines from one wall-clock constant', () => {
  const offenders = sources.flatMap(({ file, lines }) =>
    lines.flatMap((line, index) =>
      literalBudget.test(line) || namedBudget.test(line) || (/deadline/i.test(line) && clockDeadline.test(line))
        ? [`${file}:${index + 1}: ${line.trim()}`]
        : [],
    ),
  );
  expect(offenders).toEqual([]);
  const declarations = sources.flatMap(({ file, lines }) =>
    lines.filter((line) => /\bconst WORK_STEP_DEADLINE_MS = [0-9_]+;/.test(line)).map(() => file),
  );
  expect(declarations).toEqual(['command-support.ts']);
});

test('the library outcome driver configures the kernel request deadline', () => {
  const driver = readFileSync(resolve(import.meta.dir, 'support/outcome-driver.ts'), 'utf8');
  expect(driver).toContain('requestDeadlineMs: 30_000');
});
