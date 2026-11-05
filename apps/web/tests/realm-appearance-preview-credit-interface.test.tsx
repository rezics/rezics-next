import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImageCredit } from '../src/community/community-presentation-parts';
import { image } from '../src/kernel/fake/community';

const credited = {
  ...image,
  credit: {
    rightsHolder: 'A. Maker',
    via: { name: 'Openverse', url: 'https://images.example/photo' },
    license: 'CC BY 4.0',
  },
};

test('appearance image credit preserves its admitted source and waits for a loaded preview', () => {
  const markup = renderToStaticMarkup(createElement(ImageCredit, { image: credited, loaded: true }));
  expect(markup).toContain('© A. Maker');
  expect(markup).toContain('href="https://images.example/photo" rel="noopener noreferrer nofollow"');
  expect(markup).toContain('>Openverse</a>');
  expect(markup).toContain('CC BY 4.0');
  expect(renderToStaticMarkup(createElement(ImageCredit, { image: credited, loaded: false }))).toBe('');
  expect(renderToStaticMarkup(createElement(ImageCredit, { image, loaded: true }))).toBe('');
});
