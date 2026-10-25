import { expect, test } from 'bun:test';
import { planReads, platformRegistry, readCost, validateComposition } from '../src/index.ts';

const home = {
  root: { props: {} },
  content: [
    {
      type: 'SearchBox',
      props: { id: 'q', placeholder: { en: 'Search books, anime and recipes', ja: '本・アニメ・レシピを検索' } },
    },
    {
      type: 'LinkGrid',
      props: {
        id: 'verticals',
        links: [
          { label: { en: 'Books', ja: '本' }, href: '/search?type=schema%3ABook' },
          { label: { en: 'Recipes' }, href: '/search?type=schema%3ARecipe' },
        ],
      },
    },
    {
      type: 'TypeList',
      props: { id: 'books', title: { en: 'Books' }, types: ['schema:Book'], sort: 'collections', limit: 12 },
    },
  ],
};

test('a route page lists subjects by type without a page subject', () => {
  expect(validateComposition(platformRegistry, home)).toEqual([]);
  const plan = planReads(platformRegistry, home, { subject: null });
  const reads = Object.values(plan.reads);
  expect(reads).toEqual([
    { kind: 'search', body: { filter: { type: { in: ['schema:Book'] } }, sort: 'collections', limit: 12 } },
  ]);
  expect(Object.keys(plan.nodes)).toEqual(['books']);
  expect(readCost(reads[0]!)).toBe(12);
  const withSubject = planReads(platformRegistry, home, { subject: '00000000-0000-8000-8000-000000000001' });
  expect(Object.values(withSubject.reads)).toEqual(reads);
});

test('home components refuse unsafe or unbounded props', () => {
  const bad = {
    root: { props: {} },
    content: [
      { type: 'LinkGrid', props: { id: 'l', links: [{ label: { en: 'x' }, href: 'javascript:alert(1)' }] } },
      { type: 'LinkGrid', props: { id: 'm', links: [] } },
      { type: 'TypeList', props: { id: 't', title: { en: 'x' }, types: ['schema:Book'], sort: 'random', limit: 12 } },
      { type: 'TypeList', props: { id: 'u', title: { en: 'x' }, types: [], sort: 'name', limit: 12 } },
      { type: 'TypeList', props: { id: 'v', title: { en: 'x' }, types: ['schema:Book'], sort: 'name', limit: 25 } },
      { type: 'SearchBox', props: { id: 's', placeholder: { en: 'x'.repeat(81) } } },
      { type: 'LinkGrid', props: { id: 'n', links: [{ label: { en: 'x' }, href: '/', extra: 1 }] } },
    ],
  };
  const pointers = validateComposition(platformRegistry, bad).map(({ pointer }) => pointer);
  expect(pointers).toEqual(
    expect.arrayContaining([
      '/content/0/props/links/0/href',
      '/content/1/props/links',
      '/content/2/props/sort',
      '/content/3/props/types',
      '/content/4/props/limit',
      '/content/5/props/placeholder/en',
      '/content/6/props/links/0/extra',
    ]),
  );
});
