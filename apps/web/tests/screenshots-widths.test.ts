import { expect, test } from 'bun:test';
import { parseOptions, screenshotFilename } from '../scripts/screenshots.ts';

test('one Storybook run can capture selected stories at multiple widths', () => {
  const options = parseOptions(['--story', 'pages-space--*', '--width', '390', '--width', '1280', '--width', '390']);
  expect(options.widths).toEqual([390, 1280]);
  expect(
    screenshotFilename({
      id: 'pages-space--signed-out',
      locale: 'en',
      theme: 'light',
      width: 390,
      widthSuffix: true,
    }),
  ).toBe('pages-space--signed-out.en.light.390px.png');
});

test('the default single-width filename stays compatible with existing screenshot reviews', () => {
  expect(screenshotFilename({ id: 'pages-space--signed-out', locale: 'en', theme: 'light', width: 1280 })).toBe(
    'pages-space--signed-out.en.light.png',
  );
  expect(parseOptions([]).widths).toEqual([1280]);
});
