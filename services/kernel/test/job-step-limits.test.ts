import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { BULK_COMMAND_DEADLINE_MS, BULK_PAGE_LIMIT, BULK_SEGMENT_PAGES } from '../src/library/bulk-contract.ts';
import { SHELF_MAINTENANCE_LIMITS } from '../src/library/shelf-maintenance-ops-contract.ts';

const readme = readFileSync(join(import.meta.dir, '../README.md'), 'utf8');
const subsection = readme.match(/### Bounded job steps\n([\s\S]*?)(?=\n### |\n## |$)/)?.[1];

function limit(label: string): string {
  const row = subsection?.split('\n').find((line) => line.startsWith(`| ${label} |`));
  expect(row, `README row for ${label}`).toBeDefined();
  return row!.split('|')[2]!.trim();
}

test('the kernel README bounded job step limits equal the Library code constants that enforce them', () => {
  expect(limit('Raw rows per page')).toBe(`${SHELF_MAINTENANCE_LIMITS.page} rows`);
  expect(limit('Raw rows per page')).toBe(`${BULK_PAGE_LIMIT} rows`);
  expect(limit('Pages per durable workflow segment')).toBe(`${SHELF_MAINTENANCE_LIMITS.segment} pages`);
  expect(limit('Pages per durable workflow segment')).toBe(`${BULK_SEGMENT_PAGES} pages`);
  expect(limit('Native command deadline')).toBe(
    `${SHELF_MAINTENANCE_LIMITS.commandDeadlineMs} ms; a shorter caller deadline wins`,
  );
  expect(limit('Native command deadline')).toBe(
    `${BULK_COMMAND_DEADLINE_MS} ms; a shorter caller deadline wins`,
  );
  expect(limit('Continuation (keyset cursor or frontier)')).toBe(
    `${SHELF_MAINTENANCE_LIMITS.cursorScalars} scalars and ${SHELF_MAINTENANCE_LIMITS.cursorBytes} UTF-8 JSON bytes, including full unique tie keys; never OFFSET`,
  );
  expect(limit('Workflow arguments and results')).toBe(
    `${SHELF_MAINTENANCE_LIMITS.workflowBytes} UTF-8 JSON bytes each, independent of population and input size`,
  );
});
