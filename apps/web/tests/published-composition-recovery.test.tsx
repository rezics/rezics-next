import { expect, test } from 'bun:test';
import { platformRegistry } from '@rezics/composition';
import platform from '@rezics/composition/profiles/platform.json';
import { type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompositionRender, type PageComponents } from '../src/features/pages/render';

const components: PageComponents = {
  Heading: ({ text }) => <h1>{(text as { en: string }).en}</h1>,
  Text: ({ text }) => <p>{String(text)}</p>,
  Stack: ({ children }) => <section>{children as ReactNode}</section>,
  Columns: ({ start, end }) => <div>{[start, end] as ReactNode}</div>,
  Slot: ({ children }) => <footer>{children as ReactNode}</footer>,
  LinkGrid: ({ links }) => {
    const [link] = links as [{ label: string; href: string }];
    return <a href={link.href}>{link.label}</a>;
  },
};

test('Published composition keeps supported sibling content usable beside unavailable components or malformed slots.', () => {
  const home = platform.routes[0]!.document;
  const definitions = platformRegistry.components.map(({ type, slots }) => ({ type, slots: [...slots] }));
  const node = (type: string, id: string, props = {}) => ({ type, props: { id, ...props } });
  const link = node('LinkGrid', 'navigation', { links: [{ label: 'Continue reading', href: '/reading' }] });
  for (const malformed of [undefined, null, 'broken', 42, { children: [link] }]) {
    const document = {
      ...home,
      content: [
        home.content[0]!,
        node('Stack', 'body', {
          gap: 'md',
          children: [
            node('Summary', 'unavailable', { children: [node('Text', 'hidden', { text: 'Hidden subtree' })] }),
            node('Columns', 'columns', { split: 'even', start: malformed, end: [link] }),
            node('Slot', 'footer', {
              name: 'footer',
              children: [null, node('Text', 'last', { text: 'Last sibling' })],
            }),
          ],
        }),
        ...home.content.slice(1),
      ],
    };
    const before = structuredClone(document);
    const html = renderToStaticMarkup(
      <CompositionRender definitions={definitions} components={components} document={document} />,
    );
    expect(html).toContain('href="/reading"');
    expect(html.match(/>Continue reading</g)).toHaveLength(1);
    const order = ['Home', 'Continue reading', 'Last sibling'].map((text) => html.indexOf(`>${text}<`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toMatch(/<footer[^>]*>.*Last sibling.*<\/footer>/s);
    expect(html).not.toMatch(/Hidden subtree|broken/);
    expect(document).toEqual(before);
  }
});
