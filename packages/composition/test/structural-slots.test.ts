import { expect, test } from 'bun:test';
import {
  planReads,
  platformRegistry,
  walkStructuralContent,
  type CompositionDocument,
} from '../src/index.ts';

const heading = (id: string) => ({
  type: 'Heading',
  props: { id, text: { en: id }, level: 2 },
});
const list = (id: string, limit = 12) => ({
  type: 'TypeList',
  props: {
    id,
    title: { en: id },
    types: ['schema:Book'],
    sort: 'name' as const,
    limit,
  },
});

test('structural lookup keeps sibling order around unknown components and malformed slots', () => {
  const content = [
    heading('before'),
    { type: 'UnknownFuture', props: { id: 'gone', children: [list('hidden')] } },
    'malformed',
    list('books'),
    heading('after'),
  ];
  expect([...walkStructuralContent(platformRegistry, content)].map((node) => node.props.id)).toEqual([
    'before',
    'books',
    'after',
  ]);
});

test('TypeList plans native Search pages at the authored body.limit', () => {
  const document: CompositionDocument = {
    root: { props: {} },
    content: [list('recipes', 8)],
  };
  const plan = planReads(platformRegistry, document, { subject: null });
  expect(plan.reads[plan.nodes.recipes!]!).toEqual({
    kind: 'search',
    body: {
      filter: { type: { in: ['schema:Book'] } },
      sort: 'name',
      limit: 8,
    },
  });
});
