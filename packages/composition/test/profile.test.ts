import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  MAX_PROFILE_BYTES,
  MAX_PROFILE_TEMPLATES,
  PROFILE_FORMAT,
  type CompositionDocument,
  type PresentationProfile,
  platformRegistry,
  profileDigest,
  resolveTemplate,
  validateProfile,
} from '../src/index.ts';
import platform from '../profiles/platform.json' with { type: 'json' };

const page = (id: string, text: string) => ({
  root: { props: {} },
  content: [{ type: 'Heading', props: { id, text, level: 2 } }],
});
const profile = (): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: page('generic', 'Generic'),
  bases: [
    { base: 'schema:CreativeWork', document: page('work', 'Work') },
    { base: 'schema:Thing', document: page('thing', 'Thing') },
  ],
  types: [
    { type: 'schema:Book', document: page('book', 'Book') },
    { type: 'schema:Recipe', document: page('recipe', 'Recipe') },
  ],
  routes: [
    { route: '/', document: page('home', 'Home') },
    { route: '/about/press-kit', document: page('press', 'Press') },
  ],
});

test('a profile with generic, base, type and route templates is valid and has a stable digest', () => {
  const value = profile();
  const before = structuredClone(value);
  expect(validateProfile(platformRegistry, value)).toEqual([]);
  expect(value).toEqual(before);
  const digest = profileDigest(value);
  expect(digest).toBe(`sha256:${createHash('sha256').update(canonicalize(value)!, 'utf8').digest('hex')}`);
  expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  const reordered = {
    routes: value.routes,
    types: value.types,
    generic: value.generic,
    bases: value.bases,
    format: value.format,
  };
  expect(profileDigest(reordered)).toBe(digest);
  expect(profileDigest({ ...value, generic: page('generic', 'Other') })).not.toBe(digest);
  expect(
    validateProfile(platformRegistry, {
      format: PROFILE_FORMAT,
      generic: page('g', 'G'),
      bases: [],
      types: [],
      routes: [],
    }),
  ).toEqual([]);
});

test('profile keys are checked, sorted and unique', () => {
  const value = profile();
  value.types = [
    { type: 'schema:Recipe', document: page('recipe', 'Recipe') },
    { type: 'schema:Book', document: page('book', 'Book') },
    { type: 'schema:Book', document: page('book2', 'Again') },
  ];
  value.bases[1]!.base = 'Thing';
  value.routes = [
    { route: '/', document: page('home', 'Home') },
    { route: '//evil.example', document: page('evil', 'Evil') },
    { route: '/Upper', document: page('upper', 'Upper') },
  ];
  expect(validateProfile(platformRegistry, value)).toEqual([
    { pointer: '/bases/1/base', code: 'invalid' },
    { pointer: '/routes/1/route', code: 'invalid' },
    { pointer: '/routes/2/route', code: 'invalid' },
    { pointer: '/types/1/type', code: 'invalid' },
    { pointer: '/types/2/type', code: 'duplicate' },
  ]);
  expect(
    validateProfile(platformRegistry, { ...profile(), format: 'https://rezics.com/presentation/profile/2' }),
  ).toEqual([{ pointer: '/format', code: 'invalid' }]);
  expect(validateProfile(platformRegistry, { ...profile(), zones: {} })).toEqual([
    { pointer: '/zones', code: 'invalid' },
  ]);
  const { routes: _routes, ...missing } = profile();
  expect(validateProfile(platformRegistry, missing)).toEqual([{ pointer: '/routes', code: 'invalid' }]);
  expect(validateProfile(platformRegistry, 'profile')).toEqual([{ pointer: '', code: 'invalid' }]);
});

test('every template is validated with pointers into the profile', () => {
  const value = profile();
  const only = (entry: { document?: CompositionDocument | undefined }) => entry.document!;
  (value.generic as CompositionDocument).content[0]!.props.text = '<script>alert(1)</script>';
  only(value.types[1]!).content[0]!.type = 'Script';
  // The platform Heading level is a literal enumeration, rather than an Integer range.
  only(value.routes[0]!).content[0]!.props.level = 9;
  expect(validateProfile(platformRegistry, value)).toEqual([
    { pointer: '/generic/content/0/props/text', code: 'unsafe' },
    { pointer: '/routes/0/document/content/0/props/level', code: 'invalid' },
    { pointer: '/types/1/document/content/0/type', code: 'unknown_type' },
  ]);
});

test('numeric limits retain their classification and exact pointers through every profile template', () => {
  const list = (limit: unknown): CompositionDocument => ({
    root: { props: {} },
    content: [{ type: 'SubjectList', props: { id: 'works', title: 'Works', property: 'schema:author', limit } }],
  });
  const withLimit = (limit: unknown): PresentationProfile => ({
    format: PROFILE_FORMAT,
    generic: list(limit),
    bases: [{ base: 'schema:CreativeWork', document: list(limit) }],
    types: [{ type: 'schema:Book', views: { overview: list(limit) } }],
    routes: [{ route: '/', document: list(limit) }],
  });
  for (const limit of [1, 24]) expect(validateProfile(platformRegistry, withLimit(limit))).toEqual([]);
  for (const [limit, code] of [
    [0, 'limit'],
    [25, 'limit'],
    ['25', 'invalid'],
    [1.5, 'invalid'],
    [25.5, 'invalid'],
  ] as const) {
    expect(validateProfile(platformRegistry, withLimit(limit))).toEqual([
      { pointer: '/bases/0/document/content/0/props/limit', code },
      { pointer: '/generic/content/0/props/limit', code },
      { pointer: '/routes/0/document/content/0/props/limit', code },
      { pointer: '/types/0/views/overview/content/0/props/limit', code },
    ]);
  }
});

test('a profile past its size or template limit stops validation', () => {
  const many = profile();
  many.types = Array.from({ length: MAX_PROFILE_TEMPLATES - 4 }, (_, i) => ({
    type: `schema:T${String(i).padStart(4, '0')}`,
    document: page(`t${i}`, 'Type'),
  }));
  expect(validateProfile(platformRegistry, many)).toEqual([]);
  many.types.push({ type: 'schema:Tzzzz', document: page('extra', 'Extra') });
  expect(validateProfile(platformRegistry, many)).toEqual([{ pointer: '', code: 'limit' }]);

  const large = profile();
  const text = 'x'.repeat(1_900);
  large.types = [
    {
      type: 'schema:Large',
      document: {
        root: { props: {} },
        content: Array.from({ length: 600 }, (_, j) => ({ type: 'Text', props: { id: `n${j}`, text } })),
      },
    },
  ];
  (large.generic as CompositionDocument).content[0]!.props.text = '<b>never reached</b>';
  expect(canonicalize(large)!.length).toBeGreaterThan(MAX_PROFILE_BYTES);
  expect(validateProfile(platformRegistry, large)).toEqual([{ pointer: '', code: 'limit' }]);
});

test('templates resolve by route, then type, then structural bases nearest first, then generic', () => {
  const value = profile();
  const pick = (target: Parameters<typeof resolveTemplate>[1]) => {
    const { scope, key, document } = resolveTemplate(value, target);
    return { scope, key, id: document.content[0]!.props.id };
  };
  expect(pick({ route: '/' })).toEqual({ scope: 'route', key: '/', id: 'home' });
  expect(pick({ route: '/about/press-kit', type: 'schema:Book' })).toEqual({
    scope: 'route',
    key: '/about/press-kit',
    id: 'press',
  });
  expect(pick({ route: '/unknown', type: 'schema:Book', bases: ['schema:CreativeWork'] })).toEqual({
    scope: 'type',
    key: 'schema:Book',
    id: 'book',
  });
  expect(pick({ type: 'schema:Movie', bases: ['schema:CreativeWork', 'schema:Thing'] })).toEqual({
    scope: 'base',
    key: 'schema:CreativeWork',
    id: 'work',
  });
  expect(pick({ type: 'schema:Person', bases: ['schema:Agent', 'schema:Thing'] })).toEqual({
    scope: 'base',
    key: 'schema:Thing',
    id: 'thing',
  });
  expect(pick({ type: 'schema:Person' })).toEqual({ scope: 'generic', key: null, id: 'generic' });
  expect(pick({ route: '/unknown' })).toEqual({ scope: 'generic', key: null, id: 'generic' });
  expect(pick({})).toEqual({ scope: 'generic', key: null, id: 'generic' });
});

test('the shipped platform profile validates against the shared registry and lists each launch vertical', () => {
  const value = platform as PresentationProfile;
  expect(validateProfile(platformRegistry, value)).toEqual([]);
  const home = resolveTemplate(value, { route: '/' });
  expect(home).toMatchObject({ scope: 'route', key: '/' });
  expect(
    home.document.content
      .filter((node) => node.type === 'TypeList')
      .map((node) => [node.props.id, node.props.types, node.props.limit]),
  ).toEqual([
    ['books', ['schema:Book'], 12],
    ['anime', ['schema:TVSeries', 'schema:Movie'], 12],
    ['visual-novels', ['wd:Q689445'], 12],
    ['recipes', ['schema:Recipe'], 12],
  ]);
  expect(resolveTemplate(value, { type: 'schema:Recipe' }).scope).toBe('type');
  expect(resolveTemplate(value, { type: 'schema:Book', bases: ['schema:CreativeWork'] }).scope).toBe('base');
});
