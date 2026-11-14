import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const routes = readFileSync(new URL('../../src/library/personal-routes.ts', import.meta.url), 'utf8');

test('mounted loan list rechecks owner admission after both optional enrichments', () => {
  const start = routes.indexOf(".get(\n      '/v1/copy-loans',");
  const end = routes.indexOf(".post(\n      '/v1/copy-loans',", start);
  const list = routes.slice(start, end);
  const people = list.indexOf('loanPeopleDisplay');
  const copies = list.indexOf('attachCopyListContext');
  const response = list.indexOf('const response = {');
  const admission = list.indexOf('await assertCurrentOwner();');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(people).toBeLessThan(admission);
  expect(copies).toBeLessThan(admission);
  expect(response).toBeLessThan(admission);
  expect(admission).toBeLessThan(list.indexOf('return response;'));
  expect(list).toContain('loans().assertCurrentOwner(actor, job.deadline)');
});
