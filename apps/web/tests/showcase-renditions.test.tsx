import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { deliveredShowcaseImage } from '../features/realm/adapt.ts';
import { Background } from '../features/showcase/slide.tsx';
import { cropGeometry, pictureSources } from '../features/showcase/stage.ts';

const original = {
  url: '/v1/media/original.png',
  width: 1200,
  height: 800,
  crop: 'xywh=percent:50,25,40,33.75',
  cropWidth: 480,
  cropHeight: 270,
};

test('each window selects AVIF before its WebP ladder and retains its own crop', () => {
  const image = deliveredShowcaseImage({
    ...original,
    srcset: [
      { url: '/v1/media/w320.avif', width: 320, type: 'image/avif' },
      { url: '/v1/media/w480.avif', width: 480, type: 'image/avif' },
      { url: '/v1/media/w320.webp', width: 320, type: 'image/webp' },
      { url: '/v1/media/w480.webp', width: 480, type: 'image/webp' },
    ],
  });
  expect(image.view).toBeUndefined();
  expect(pictureSources({ landscape: image }).map((source) => [source.shape, source.type])).toEqual(
    [
      ['portrait', 'image/avif'],
      ['portrait', undefined],
      ['landscape', 'image/avif'],
      ['landscape', undefined],
    ],
  );
  const html = renderToStaticMarkup(<Background art={{ landscape: image }} first />);
  expect(html.indexOf('type="image/avif"')).toBeLessThan(html.indexOf('w320.webp'));
  expect(html).toContain('w480.avif 480w');
  expect(html).toContain('w480.webp 480w');
});

test('an AVIF-only complete ladder is served without mounting an original crop fallback', () => {
  const image = deliveredShowcaseImage({
    ...original,
    srcset: [{ url: '/v1/media/frame.avif', width: 480, type: 'image/avif' }],
  });
  expect(image.view).toBeUndefined();
  expect(image.avifCandidates).toHaveLength(1);
  expect(image.candidates).toHaveLength(1);
});

test('pending geometry expands and offsets the original inside the authored frame in both axes', () => {
  const image = deliveredShowcaseImage({ ...original, srcset: [] });
  const geometry = cropGeometry(image, 16 / 9);
  expect(geometry).toMatchObject({
    ratio: 16 / 9,
    fit: 'max',
    x: '50%',
    y: '50%',
    width: '250%',
    left: '-125%',
  });
  expect(parseFloat(geometry.height)).toBeCloseTo(100 / 0.3375);
  expect(parseFloat(geometry.top)).toBeCloseTo(-25 / 0.3375);
  // The image origin maps the crop origin to zero and its far edge to the frame edge.
  expect(parseFloat(geometry.left) + 0.5 * parseFloat(geometry.width)).toBeCloseTo(0);
  expect(parseFloat(geometry.top) + 0.25 * parseFloat(geometry.height)).toBeCloseTo(0);
  expect(parseFloat(geometry.left) + 0.9 * parseFloat(geometry.width)).toBeCloseTo(100);
  expect(parseFloat(geometry.top) + 0.5875 * parseFloat(geometry.height)).toBeCloseTo(100);
  expect(cropGeometry({ ...image, framed: false }, 3 / 4).fit).toBe('min');
  expect(cropGeometry({ ...image, framed: false }, 3 / 4, true).fit).toBe('max');
  expect(cropGeometry({ ...image, view: undefined }, 16 / 9)).toMatchObject({
    width: '100%',
    height: '100%',
    left: '0%',
    top: '0%',
  });
});

test('pending originals use the same pixel rounding as the encoded crop at subpixel boundaries', () => {
  const image = deliveredShowcaseImage({
    url: '/original.png',
    width: 100,
    height: 101,
    cropWidth: 1,
    cropHeight: 1,
    crop: 'xywh=percent:29,99.999,1,0.001',
    srcset: [],
  });
  expect(image.view).toEqual({ x: 0.29, y: 100 / 101, width: 0.01, height: 1 / 101 });
});
