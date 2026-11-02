import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { CompositionRender } from '../src/features/pages/render';
const definitions = [
    { type: 'Stack', slots: ['children'] },
    { type: 'Heading' },
    { type: 'Unavailable', slots: ['children'] },
  ],
  components = {
    Stack: ({ children }: { children: any }) => createElement('section', null, children),
    Heading: ({ text, items }: { text: string; items?: unknown }) =>
      createElement('h2', { 'data-items': Array.isArray(items) ? items.length : 0 }, text),
  },
  heading = (id: string, text: string, items?: unknown) => ({ type: 'Heading', props: { id, text, items } });
test('published composition keeps siblings through unavailable nodes and malformed slots', () => {
  const document = {
      root: { props: {} },
      content: [
        {
          type: 'Stack',
          props: {
            id: 'outer',
            children: [
              heading('before', 'Before', ['data']),
              { type: 'Unavailable', props: { id: 'missing', children: [heading('orphan', 'Gone')] } },
              { type: 'Stack', props: { id: 'broken', children: heading('bad', 'Lost') } },
              heading('after', 'After'),
            ],
          },
        },
      ],
    },
    original = structuredClone(document),
    html = renderToString(createElement(CompositionRender, { document, definitions, components } as never)),
    first = html.indexOf('>Before</h2>'),
    last = html.indexOf('>After</h2>');
  expect(first).toBeGreaterThanOrEqual(0);
  expect(last).toBeGreaterThan(first);
  expect(html).not.toContain('Gone');
  expect(html).not.toContain('Lost');
  expect(html).toContain('data-items="1"');
  expect(document).toEqual(original);
});
