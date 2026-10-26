import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve(import.meta.dir, '../../src/commerce');
const sources = readdirSync(directory)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file, lines: readFileSync(resolve(directory, file), 'utf8').split('\n') }));

const computedDeadline = /(?:Date\.now\(\)|getTime\(\))\s*\+/;
const namedBudget = /\b[A-Z_]*BUDGET_MS\b/;

test('commerce code takes request deadlines from deadlineFor and one wall-clock work budget', () => {
  const computed = sources.flatMap(({ file, lines }) =>
    lines.flatMap((line, index) => (computedDeadline.test(line) ? [`${file}: ${line.trim()}`] : [])),
  );
  expect(computed).toEqual(['commands.ts: const deadline = Date.now() + WORK_STEP_DEADLINE_MS;']);
  const named = sources.flatMap(({ file, lines }) => lines.filter((line) => namedBudget.test(line)).map(() => file));
  expect(named).toEqual([]);
  const declarations = sources.flatMap(({ file, lines }) =>
    lines.filter((line) => /\bconst WORK_STEP_DEADLINE_MS = [0-9_]+;/.test(line)).map(() => file),
  );
  expect(declarations).toEqual(['commands.ts']);
  const commands = sources.find((source) => source.file === 'commands.ts')!.lines.join('\n');
  expect(commands.match(/deadlineFor\(WORK_STEP_DEADLINE_MS\)/g)?.length).toBe(2);
  expect(commands).not.toContain("throw new Error('Checkout outcome recording deadline exceeded')");
});

test('the commerce outcome driver configures the kernel request deadline', () => {
  const driver = readFileSync(resolve(import.meta.dir, 'support/outcome-driver.ts'), 'utf8');
  expect(driver).toContain('requestDeadlineMs: 30_000');
  expect(driver).not.toMatch(/Date\.now\(\)\s*\+\s*5_?000\b/);
});
