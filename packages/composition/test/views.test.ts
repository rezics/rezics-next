import { expect, test } from 'bun:test';
import {
  PROFILE_FORMAT,
  VIEWS,
  definedViews,
  planReads,
  platformRegistry,
  profileDigest,
  resolveTemplate,
  resolveView,
  templateViews,
  validateProfile,
  type CompositionDocument,
  type PresentationProfile,
} from '../src/index.ts';
import platform from '../profiles/platform.json' with { type: 'json' };

const page = (id: string, text: string): CompositionDocument => ({
  root: { props: {} },
  content: [{ type: 'Heading', props: { id, text, level: 2 } }],
});
const profile = (): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { views: { overview: page('generic', 'Generic'), details: page('generic-details', 'Generic details') } },
  bases: [
    { base: 'schema:CreativeWork', views: { overview: page('work', 'Work'), credits: page('credits', 'Credits') } },
  ],
  types: [
    { type: 'schema:Book', views: { overview: page('book', 'Book'), editions: page('editions', 'Editions') } },
    { type: 'schema:Recipe', document: page('recipe', 'Recipe') },
  ],
  routes: [],
});
const book = { type: 'schema:Book', bases: ['schema:CreativeWork'] };

test('a template holds one document per view, and a lone document is its overview', () => {
  const value = profile();
  expect(validateProfile(platformRegistry, value)).toEqual([]);
  expect(Object.keys(templateViews(value.types[1]!))).toEqual(['overview']);
  expect(templateViews(value.types[0]!).editions).toBe(value.types[0]!.views!.editions!);
  expect(templateViews(value.generic).details).toBeDefined();
  expect(profileDigest(value)).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test('views are a closed list with a required overview, each validated as its own document', () => {
  const value = profile() as unknown as { types: { views: Record<string, unknown> }[]; generic: { views: object } };
  value.types[0]!.views.tabs = page('tabs', 'Tabs');
  value.types[0]!.views.credits = { root: { props: {} }, content: [{ type: 'Script', props: { id: 'x' } }] };
  delete (value.generic.views as { overview?: unknown }).overview;
  expect(validateProfile(platformRegistry, value)).toEqual([
    { pointer: '/generic/views/overview', code: 'invalid' },
    { pointer: '/types/0/views/credits/content/0/type', code: 'unknown_type' },
    { pointer: '/types/0/views/tabs', code: 'invalid' },
  ]);
  const both = profile() as unknown as { types: Record<string, unknown>[] };
  both.types[1]!.views = { overview: page('o', 'O') };
  expect(validateProfile(platformRegistry, both)).toEqual([{ pointer: '/types/1/document', code: 'invalid' }]);
  const neither = profile() as unknown as { types: Record<string, unknown>[] };
  delete neither.types[1]!.document;
  expect(validateProfile(platformRegistry, neither)).toEqual([{ pointer: '/types/1/document', code: 'invalid' }]);
});

test('a view resolves through the template order, then the generic view', () => {
  const value = profile();
  expect(resolveView(value, book, 'editions')).toEqual({
    scope: 'type',
    key: 'schema:Book',
    document: value.types[0]!.views!.editions!,
  });
  expect(resolveView(value, book, 'credits')).toEqual({
    scope: 'base',
    key: 'schema:CreativeWork',
    document: value.bases[0]!.views!.credits!,
  });
  expect(resolveView(value, book, 'details')).toEqual({
    scope: 'generic',
    key: null,
    document: (value.generic as { views: { details: CompositionDocument } }).views.details,
  });
  expect(resolveView(value, book, 'relations')).toBeNull();
  expect(resolveView(value, { type: 'schema:Recipe' }, 'overview')?.scope).toBe('type');
  expect(resolveTemplate(value, book).document).toBe(value.types[0]!.views!.overview);
});

test('the views a page defines are those of any template in the order, in the documented order', () => {
  const value = profile();
  expect(definedViews(value, book)).toEqual(['overview', 'editions', 'credits', 'details']);
  expect(definedViews(value, { type: 'schema:Recipe' })).toEqual(['overview', 'details']);
  expect(VIEWS).toEqual([
    'overview',
    'editions',
    'contents',
    'characters',
    'appearances',
    'credits',
    'works',
    'relations',
    'posts',
    'reviews',
    'discussion',
    'lists',
    'collections',
    'details',
  ]);
});

test('the platform profile has an overview ending in Sources and a Details view holding the remaining facts', () => {
  const value = platform as unknown as PresentationProfile;
  expect(validateProfile(platformRegistry, value)).toEqual([]);
  for (const entry of [value.generic, ...value.bases, ...value.types]) {
    const views = templateViews(entry);
    const types = views.overview!.content.map((node) => node.type);
    expect(types.at(-1)).toBe('Sources');
    expect(types).not.toContain('MoreStatements');
    expect(views.details!.content.map((node) => node.type)).toContain('MoreStatements');
    for (const [view, document] of Object.entries(views)) {
      if (view === 'overview') continue;
      expect(
        planReads(platformRegistry, document!, { subject: '01a1740d-7480-71e4-841f-66c04022d7d0' }).reads,
      ).toBeDefined();
    }
  }
  const work = definedViews(value, { type: 'schema:Book', bases: ['schema:CreativeWork'] });
  expect(work).toEqual([
    'overview',
    'editions',
    'contents',
    'characters',
    'credits',
    'relations',
    'reviews',
    'discussion',
    'lists',
    'details',
  ]);
});
