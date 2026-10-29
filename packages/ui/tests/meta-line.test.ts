import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MetaLine, metaText } from '../src/components/meta-line.tsx';

test('MetaLine skips empty values and inserts a decorative separator between visible items', () => {
  expect(renderToStaticMarkup(createElement(MetaLine, { items: ['one', null, '', false, undefined, 'two'] }))).toBe(
    '<span><span>one</span><span> <span aria-hidden="true">·</span> two</span></span>',
  );
});

test('metaText uses matching break-before separator spacing', () => {
  expect(metaText(['one', false, '', null, 'two'])).toBe('one · two');
  expect(metaText([false, '', null])).toBe('');
});
