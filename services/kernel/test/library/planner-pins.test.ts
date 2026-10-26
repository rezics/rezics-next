import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A growth check that sets a planner option proves an index the production planner may not choose.
const plannerSetting =
  /\b(enable_[a-z]+|random_page_cost|seq_page_cost|cpu_tuple_cost|cpu_index_tuple_cost|cpu_operator_cost)\s*(=|\bto\b)/i;

test('library tests measure with the planner settings production has', () => {
  const offenders: string[] = [];
  const files = readdirSync(import.meta.dir).filter(
    (name) => name.endsWith('.test.ts') && name !== 'planner-pins.test.ts',
  );
  for (const file of files) {
    readFileSync(resolve(import.meta.dir, file), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (plannerSetting.test(line)) offenders.push(`${file}:${index + 1}`);
      });
  }
  expect(offenders).toEqual([]);
});
