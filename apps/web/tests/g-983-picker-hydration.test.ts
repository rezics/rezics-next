import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EntityPicker } from '../../../packages/ui/src/components/entity-picker.tsx';
import { uiLocales } from '../i18n/define.ts';

for (const locale of uiLocales) {
  test(`G-983 ${locale}: a server-rendered picker cannot lose a search before hydration`, () => {
    let searches = 0;
    const html = renderToStaticMarkup(
      createElement(EntityPicker, {
        label: 'Find a community',
        locale,
        value: [],
        onValueChange() {},
        load: async () => {
          searches++;
          return { items: [], nextCursor: null, complete: true };
        },
      }),
    );
    const input = html.match(/<input\b[^>]*\brole="combobox"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).toMatch(/\bdisabled=""/);
    const trigger = html.match(/<button\b[^>]*data-part="trigger"[^>]*>/)?.[0];
    expect(trigger).toBeDefined();
    expect(trigger).toMatch(/\bdisabled=""/);
    expect(searches).toBe(0);
  });
}

test('G-983: server-rendered selection chips also wait for their handlers', () => {
  const html = renderToStaticMarkup(
    createElement(EntityPicker, {
      label: 'Topics',
      locale: 'en',
      allowExclude: true,
      name: 'topic',
      value: [{ item: { value: 'topic-1', label: 'Fantasy' }, mode: 'include' }],
      onValueChange() {},
      load: async () => ({ items: [], nextCursor: null, complete: true }),
    }),
  );
  for (const action of ['Exclude Fantasy', 'Remove Fantasy']) {
    const button = html.match(new RegExp(`<button\\b[^>]*aria-label="${action}"[^>]*>`))?.[0];
    expect(button).toBeDefined();
    expect(button).toMatch(/\bdisabled=""/);
  }
  // Hydration readiness must not erase a selection from the native form payload.
  expect(html).toContain('name="topic" value="topic-1"');
});
