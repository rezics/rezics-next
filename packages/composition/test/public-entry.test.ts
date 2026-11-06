import { expect, test } from 'bun:test';
import {
  MAX_ZONE_PAGES,
  PROFILE_FORMAT,
  UI_LOCALES,
  pickZoneName,
  planReads,
  platformRegistry,
  validateComposition,
  validateProfile,
  validateZoneStarter,
  type CompositionDocument,
} from '@rezics/composition';

// Consumers resolve the package name. The in-source tests import ../src directly, so this file is the only proof that
// the package entry loads and its Zone exports and paged TypeList admission run through it together.
const page = (content: CompositionDocument['content']): CompositionDocument => ({ root: { props: {} }, content });
const labels = Object.fromEntries(UI_LOCALES.map((locale) => [locale, `Books (${locale})`]));
const starter = {
  labels,
  pages: [{ route: '', document: page([{ type: 'Heading', props: { id: 'home', text: 'Books', level: 2 } }]) }],
  scope: ['books/fiction'],
};
const books = (limit: number) =>
  page([
    {
      type: 'TypeList',
      props: { id: 'books', title: { en: 'Books' }, types: ['schema:Book'], sort: 'name', limit, paged: true },
    },
  ]);

test('the package entry admits a Zone starter, names it for a reader and plans a paged list at its clamp', () => {
  expect(MAX_ZONE_PAGES).toBe(16);
  expect(validateZoneStarter(platformRegistry, starter, { filters: new Set(['books/fiction']) })).toEqual([]);
  expect(pickZoneName({ labels: { ja: '本', en: 'Books' } }, 'de')).toEqual({ text: 'Books', lang: 'en' });
  expect(validateComposition(platformRegistry, books(24))).toEqual([]);
  const plan = planReads(platformRegistry, books(24), { subject: null });
  expect(plan.reads[plan.nodes.books!]).toMatchObject({ kind: 'search', body: { limit: 12 } });
});

test('a paged TypeList refuses its raw limit before the paged clamp can hide it', () => {
  expect(validateComposition(platformRegistry, books(30))).toEqual([
    { pointer: '/content/0/props/limit', code: 'limit' },
  ]);
});

test('profile publication refuses executable input at the registry boundary', () => {
  expect(
    validateProfile(platformRegistry, {
      format: PROFILE_FORMAT,
      generic: page([
        { type: 'LinkGrid', props: { id: 'links', links: [{ label: { en: 'Open' }, href: 'javascript:alert(1)' }] } },
      ]),
      bases: [],
      types: [],
      routes: [],
    }),
  ).toEqual([{ pointer: '/generic/content/0/props/links/0/href', code: 'unsafe' }]);
});
