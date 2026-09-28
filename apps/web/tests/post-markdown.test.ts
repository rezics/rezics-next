import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownBody } from '../features/post-composer/markdown.tsx';

const render = (text: string) => renderToStaticMarkup(createElement(MarkdownBody,
  { text, showSpoiler: 'Show spoiler' }));

test('post and reply Markdown render text, formatting and safe links without HTML execution', () => {
  const html = render('**Bold** *italic* `code` [safe](https://example.org/read)\n\n'
    + '> a quote\n\n- one\n- two\n\n1. first\n\n<script>alert(1)</script> '
    + '[unsafe](javascript:alert(1))');
  expect(html).toContain('<strong>Bold</strong>');
  expect(html).toContain('<em>italic</em>');
  expect(html).toContain('<code');
  expect(html).toContain('href="https://example.org/read"');
  expect(html).toContain('<blockquote');
  expect(html).toContain('<ul');
  expect(html).toContain('<ol');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('href="javascript:');
});

test('inline spoiler words are absent until the reader reveals them', () => {
  const html = render('Visible >!the secret!< text');
  expect(html).toContain('Show spoiler');
  expect(html).not.toContain('the secret');
  expect(html).toContain('aria-expanded="false"');
});
