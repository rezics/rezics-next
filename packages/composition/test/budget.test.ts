import { expect, test } from 'bun:test';
import {
  MAX_PAGE_COST,
  MAX_PAGE_READS,
  planReads,
  platformRegistry,
  readCost,
  validateComposition,
} from '../src/index.ts';

const subject = '018f0000-0000-7000-8000-00a000000001';
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const list = (id: string, property: string, limit: number) =>
  node('SubjectList', id, { title: 'Works', property, limit });
const page = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });
const cost = (document: ReturnType<typeof page>) =>
  Object.values(planReads(platformRegistry, document as never, { subject }).reads).reduce(
    (total, read) => total + readCost(read),
    0,
  );
const lists = (count: number, limit: number) =>
  Array.from({ length: count }, (_, i) => list(`l${i}`, `schema:p${i}`, limit));

test('a read costs the subjects it can return', () => {
  expect(readCost({ kind: 'subject', id: subject })).toBe(1);
  expect(
    readCost({
      kind: 'search',
      body: { filter: { statement: { property: 'schema:author', in: [subject] } }, sort: 'name', limit: 24 },
    }),
  ).toBe(24);
});

test('a page whose distinct reads cost more than the budget is refused at publish', () => {
  expect(MAX_PAGE_COST).toBe(128);
  const full = page(node('SubjectHeader', 'header'), ...lists(5, 24), list('last', 'schema:p5', 7));
  expect(cost(full)).toBe(128);
  expect(validateComposition(platformRegistry, full)).toEqual([]);
  const over = page(node('SubjectHeader', 'header'), ...lists(5, 24), list('last', 'schema:p5', 8));
  expect(validateComposition(platformRegistry, over)).toEqual([{ pointer: '/content', code: 'limit' }]);
  const repeated = page(
    node('SubjectHeader', 'header'),
    ...Array.from({ length: 12 }, (_, i) => list(`r${i}`, 'schema:author', 24)),
  );
  expect(cost(repeated)).toBe(25);
  expect(validateComposition(platformRegistry, repeated)).toEqual([]);
  const many = page(...Array.from({ length: MAX_PAGE_READS + 1 }, (_, i) => list(`m${i}`, `schema:q${i}`, 1)));
  expect(validateComposition(platformRegistry, many)).toEqual([{ pointer: '/content', code: 'limit' }]);
});
