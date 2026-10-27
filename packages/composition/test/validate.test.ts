import { expect, test } from 'bun:test';
import Type from 'typebox';
import { Compile } from 'typebox/schema';
import {
  APPEARANCE,
  MAX_COMPOSITION_BYTES,
  MAX_COMPOSITION_DEPTH,
  MAX_COMPOSITION_NODES,
  SLOT_NAMES,
  compositionSchema,
  curie,
  defineRegistry,
  href,
  plainText,
  platformRegistry,
  validateComposition,
} from '../src/index.ts';

const registry = defineRegistry({
  root: Type.Object({ title: Type.Optional(plainText({ maxLength: 120 })) }, { additionalProperties: false }),
  components: [
    {
      type: 'Stack',
      props: Type.Object(
        { gap: Type.Union([Type.Literal('sm'), Type.Literal('lg')]) },
        { additionalProperties: false },
      ),
      slots: ['children'],
    },
    {
      type: 'Heading',
      props: Type.Object(
        { text: plainText({ maxLength: 200 }), level: Type.Integer({ minimum: 2, maximum: 4 }) },
        { additionalProperties: false },
      ),
    },
    {
      type: 'Link',
      props: Type.Object(
        { label: plainText({ maxLength: 200 }), href: href(), property: Type.Optional(curie()) },
        { additionalProperties: false },
      ),
    },
  ],
});

const heading = (index: number, text = 't') => ({ type: 'Heading', props: { id: `h${index}`, text, level: 2 } });
const valid = {
  root: { props: { title: 'Books' } },
  content: [
    {
      type: 'Stack',
      props: {
        id: 'stack-1',
        gap: 'sm',
        children: [
          { type: 'Heading', props: { id: 'heading-1', text: 'New this week', level: 2 } },
          { type: 'Link', props: { id: 'link-1', label: 'All books', href: '/browse?type=schema%3ABook' } },
          {
            type: 'Link',
            props: { id: 'link-2', label: 'Source', href: 'https://example.org:8443/a?b=c#d', property: 'schema:url' },
          },
        ],
      },
    },
  ],
};

test('a Puck document built from registered components is valid', () => {
  const copy = structuredClone(valid);
  expect(validateComposition(registry, valid)).toEqual([]);
  expect(valid).toEqual(copy);
  expect(validateComposition(registry, { root: { props: {} }, content: [] })).toEqual([]);
});

test('unknown types, unknown props and missing props are refused with pointers', () => {
  expect(
    validateComposition(registry, {
      root: { props: {} },
      content: [
        { type: 'Script', props: { id: 'a', src: '/x.js' } },
        { type: 'Heading', props: { id: 'b', text: 'x', level: 2, onClick: 'alert(1)' } },
        { type: 'Heading', props: { id: 'c', level: 2 } },
        { type: 'Heading', props: { id: 'd', text: 'x', level: 7 } },
      ],
    }),
  ).toEqual([
    { pointer: '/content/0/type', code: 'unknown_type' },
    { pointer: '/content/1/props/onClick', code: 'invalid' },
    { pointer: '/content/2/props/text', code: 'invalid' },
    { pointer: '/content/3/props/level', code: 'limit' },
  ]);
  expect(validateComposition(registry, { root: { props: { colour: 'red' } }, content: [] })).toEqual([
    { pointer: '/root/props/colour', code: 'invalid' },
  ]);
  expect(
    validateComposition(registry, {
      root: { props: {} },
      content: [{ type: 'Heading', props: { text: 'x', level: 2 } }],
    }),
  ).toEqual([{ pointer: '/content/0/props/id', code: 'invalid' }]);
});

for (const [kind, numeric] of [
  ['Integer', Type.Integer],
  ['Number', Type.Number],
] as const) {
  for (const { bounds, accepted, refused } of [
    { bounds: { minimum: 1, maximum: 24 }, accepted: [1, 24], refused: [0, 25] },
    { bounds: { exclusiveMinimum: 0, exclusiveMaximum: 2 }, accepted: [1], refused: [-1, 0, 2, 3] },
    { bounds: { minimum: 0, maximum: 0 }, accepted: [0], refused: [-1, 1] },
    { bounds: { exclusiveMaximum: 0 }, accepted: [-1], refused: [0, 1] },
    { bounds: { minimum: -3, maximum: -1 }, accepted: [-3, -1], refused: [-4, 0] },
    { bounds: { exclusiveMinimum: -3, exclusiveMaximum: -1 }, accepted: [-2], refused: [-4, -3, -1, 0] },
    ...(kind === 'Number'
      ? [{ bounds: { minimum: -1.5, maximum: 0.5 }, accepted: [-1.5, 0.25, 0.5], refused: [-1.75, 0.75] }]
      : []),
  ]) {
    test(`${kind} bounds ${JSON.stringify(bounds)} classify ranges at root and nested pointers`, () => {
      const closed = { additionalProperties: false } as const;
      const schema = numeric(bounds);
      const numericRegistry = defineRegistry({
        root: Type.Object({ value: schema }, closed),
        components: [
          { type: 'Stack', props: Type.Object({}, closed), slots: ['children'] },
          {
            type: 'Numeric',
            props: Type.Object({ readings: Type.Array(Type.Object({ value: schema }, closed)) }, closed),
          },
        ],
      });
      const document = (value: unknown) => ({
        root: { props: { value } },
        content: [
          {
            type: 'Stack',
            props: {
              id: 'stack',
              children: [{ type: 'Numeric', props: { id: 'number', readings: [{ value }] } }],
            },
          },
        ],
      });
      const violations = (code: 'limit' | 'invalid') => [
        { pointer: '/content/0/props/children/0/props/readings/0/value', code },
        { pointer: '/root/props/value', code },
      ];
      const generated = Compile(compositionSchema(numericRegistry) as never);
      for (const value of accepted) {
        expect(validateComposition(numericRegistry, document(value))).toEqual([]);
        expect(generated.Check(document(value))).toBe(true);
      }
      for (const value of refused) {
        expect(validateComposition(numericRegistry, document(value))).toEqual(violations('limit'));
        expect(generated.Check(document(value))).toBe(false);
      }
      for (const value of ['25', '1', null, true, {}, [], ...(kind === 'Integer' ? [0.5, 25.5] : [])]) {
        expect(validateComposition(numericRegistry, document(value))).toEqual(violations('invalid'));
        expect(generated.Check(document(value))).toBe(false);
      }
      // Nonfinite values fail the existing canonical JSON check before schema traversal.
      for (const value of [NaN, Infinity, -Infinity]) {
        expect(validateComposition(numericRegistry, document(value))).toEqual([{ pointer: '', code: 'invalid' }]);
      }
    });
  }
}

test('HTML, script and executable links are refused wherever text or links appear', () => {
  const link = (props: Record<string, string>) =>
    validateComposition(registry, {
      root: { props: {} },
      content: [{ type: 'Link', props: { id: 'l', label: 'ok', href: '/', ...props } }],
    });
  for (const label of [
    '<b>bold</b>',
    'a<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<!-- x -->',
    'x</p>',
    'bell\u0007',
  ])
    expect(link({ label })).toEqual([{ pointer: '/content/0/props/label', code: 'unsafe' }]);
  for (const target of [
    'javascript:alert(1)',
    ' JavaScript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<p>x</p>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'http://example.org/',
    '//evil.example/',
    '/\\evil.example',
    '/a b',
    'https://user:pass@example.org/',
    'https://example.org/"onmouseover="x',
  ])
    expect(link({ href: target })).toEqual([{ pointer: '/content/0/props/href', code: 'unsafe' }]);
  expect(link({ label: '3 < 4 and 5 > 2', href: '/subjects/abc?x=1#top' })).toEqual([]);
  expect(validateComposition(registry, { root: { props: { title: '<i>x</i>' } }, content: [] })).toEqual([
    { pointer: '/root/props/title', code: 'unsafe' },
  ]);
  const nested = structuredClone(valid);
  (nested.content[0]!.props.children[1]!.props as Record<string, string>).href = 'javascript:alert(1)';
  expect(validateComposition(registry, nested)).toEqual([
    { pointer: '/content/0/props/children/1/props/href', code: 'unsafe' },
  ]);
});

test('limits on size, node count and depth stop validation', () => {
  expect([MAX_COMPOSITION_BYTES, MAX_COMPOSITION_NODES, MAX_COMPOSITION_DEPTH]).toEqual([65_536, 256, 8]);
  const many = (count: number) => ({
    root: { props: {} },
    content: Array.from({ length: count }, (_, i) => heading(i)),
  });
  expect(validateComposition(registry, many(256))).toEqual([]);
  expect(validateComposition(registry, many(257))).toEqual([{ pointer: '/content', code: 'limit' }]);

  const nest = (levels: number) => {
    let node: object = heading(0);
    for (let i = 1; i < levels; i++) node = { type: 'Stack', props: { id: `s${i}`, gap: 'sm', children: [node] } };
    return { root: { props: {} }, content: [node] };
  };
  expect(validateComposition(registry, nest(8))).toEqual([]);
  expect(validateComposition(registry, nest(9))).toEqual([
    { pointer: `/content/0${'/props/children/0'.repeat(8)}`, code: 'limit' },
  ]);

  const large = {
    root: { props: {} },
    content: Array.from({ length: 200 }, (_, i) => ({
      type: 'Unknown',
      props: { id: `h${i}`, text: 'é'.repeat(200) },
    })),
  };
  expect(validateComposition(registry, large)).toEqual([{ pointer: '', code: 'limit' }]);
});

test('node ids are unique across the document', () => {
  expect(
    validateComposition(registry, {
      root: { props: {} },
      content: [heading(1), { type: 'Stack', props: { id: 'h2', gap: 'lg', children: [heading(1), heading(2)] } }],
    }),
  ).toEqual([
    { pointer: '/content/1/props/children/0/props/id', code: 'duplicate' },
    { pointer: '/content/1/props/children/1/props/id', code: 'duplicate' },
  ]);
});

test('zones and other keys outside the format are refused', () => {
  expect(validateComposition(registry, { root: { props: {} }, content: [], zones: {} })).toEqual([
    { pointer: '/zones', code: 'invalid' },
  ]);
  expect(validateComposition(registry, { root: { title: 'x', props: {} }, content: [] })).toEqual([
    { pointer: '/root/title', code: 'invalid' },
  ]);
  expect(
    validateComposition(registry, { root: { props: {} }, content: [{ ...heading(1), readOnly: { text: true } }] }),
  ).toEqual([{ pointer: '/content/0/readOnly', code: 'invalid' }]);
  expect(validateComposition(registry, { root: { props: {} } })).toEqual([{ pointer: '/content', code: 'invalid' }]);
  expect(validateComposition(registry, 'page')).toEqual([{ pointer: '', code: 'invalid' }]);
});

test('the generated JSON Schema accepts and refuses the same documents', () => {
  const schema = compositionSchema(registry);
  expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
  const validator = Compile(schema as never);
  expect(validator.Check(valid)).toBe(true);
  const unsafe = structuredClone(valid);
  (unsafe.content[0]!.props.children[1]!.props as Record<string, string>).href = 'javascript:alert(1)';
  expect(validator.Check(unsafe)).toBe(false);
  const html = structuredClone(valid);
  (html.content[0]!.props.children[0]!.props as Record<string, string>).text = '<b>x</b>';
  expect(validator.Check(html)).toBe(false);
  expect(validator.Check({ root: { props: {} }, content: [{ type: 'Script', props: { id: 'a' } }] })).toBe(false);
  expect(validator.Check({ root: { props: {} }, content: [], zones: {} })).toBe(false);
});

test('a registry refuses string props that are not plain text, links, CURIEs or literals', () => {
  const root = Type.Object({}, { additionalProperties: false });
  const closed = { additionalProperties: false } as const;
  const one = (type: string, props: ReturnType<typeof Type.Object>, slots?: string[]) => () =>
    defineRegistry({ root, components: [{ type, props, ...(slots ? { slots } : {}) }] });
  expect(one('Raw', Type.Object({ html: Type.String() }, closed))).toThrow('Raw.html');
  expect(one('List', Type.Object({ items: Type.Array(Type.String()) }, closed))).toThrow('List.items');
  expect(one('lower', Type.Object({}, closed))).toThrow();
  expect(one('A', Type.Object({ id: plainText({ maxLength: 9 }) }, closed))).toThrow();
  expect(one('A', Type.Object({ children: plainText({ maxLength: 9 }) }, closed), ['children'])).toThrow();
  expect(() =>
    defineRegistry({
      root,
      components: [
        { type: 'A', props: Type.Object({}, closed) },
        { type: 'A', props: Type.Object({}, closed) },
      ],
    }),
  ).toThrow();
  expect(one('A', Type.Object({ tags: Type.Array(curie(), { maxItems: 4 }) }, closed))).not.toThrow();
});

test('the platform registry has closed appearance tokens and named slots', () => {
  expect(APPEARANCE).toEqual({
    density: ['compact', 'comfortable'],
    radius: ['sm', 'md', 'lg'],
    surface: ['flat', 'cards'],
    cover: ['portrait', 'square', 'landscape'],
    headingScale: ['md', 'lg'],
  });
  expect(SLOT_NAMES).toEqual(['header', 'hero', 'entity', 'aside', 'footer', 'actions', 'personal']);
  const page = {
    root: { props: { appearance: { density: 'compact', surface: 'cards' } } },
    content: [
      {
        type: 'Slot',
        props: {
          id: 'header',
          name: 'header',
          children: [{ type: 'Heading', props: { id: 'title', text: 'Books', level: 2 } }],
        },
      },
      {
        type: 'Columns',
        props: {
          id: 'body',
          split: 'start',
          start: [{ type: 'Text', props: { id: 'intro', text: 'Shared catalogue.' } }],
          end: [{ type: 'Stack', props: { id: 'side', gap: 'md', children: [] } }],
        },
      },
    ],
  };
  expect(validateComposition(platformRegistry, page)).toEqual([]);
  const colour = structuredClone(page);
  (colour.root.props.appearance as Record<string, string>).accent = '#ff0000';
  expect(validateComposition(platformRegistry, colour)).toEqual([
    { pointer: '/root/props/appearance/accent', code: 'invalid' },
  ]);
  const slot = structuredClone(page);
  (slot.content[0]!.props as Record<string, unknown>).name = 'sidebar';
  expect(validateComposition(platformRegistry, slot)).toEqual([{ pointer: '/content/0/props/name', code: 'invalid' }]);
});
