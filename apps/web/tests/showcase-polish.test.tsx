import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ZoneShowcaseArt } from '@rezics/zone-sdk';
import { deliveredShowcaseImage } from '../features/realm/adapt.ts';
import { Background } from '../features/showcase/slide.tsx';
import { viewBox } from '../features/showcase/stage.ts';
import { messages } from '../features/work-page/messages.ts';
import { shelfWords } from '../features/work-page/shelf-words.ts';

const original = {
  url: '/v1/media/original.png', width: 4000, height: 3000, cropWidth: 2400, cropHeight: 1350,
  crop: 'xywh=percent:10,20,60,45', focalArea: 'xywh=percent:30,30,20,20',
};
const rendition = [{ url: '/v1/media/w800.webp', width: 800, type: 'image/webp' }];

test('art whose renditions are pending carries its crop to draw from the original', () => {
  const pending = deliveredShowcaseImage({ ...original, srcset: [] });
  expect([pending.width, pending.height]).toEqual([2400, 1350]);
  expect(pending.view).toEqual({ x: 0.1, y: 0.2, width: 0.6, height: 0.45 });
  expect(viewBox(pending)).toBe('inset(20% 30% 35% 10%)');
});

test('art with renditions, or whose crop is the whole image, draws as delivered', () => {
  expect(deliveredShowcaseImage({ ...original, srcset: rendition }).view).toBeUndefined();
  expect(deliveredShowcaseImage({ ...original, crop: 'xywh=percent:0,0,100,100', srcset: [] }).view).toBeUndefined();
  expect(deliveredShowcaseImage({ ...original, crop: null, srcset: [] }).view).toBeUndefined();
  expect(viewBox(deliveredShowcaseImage({ ...original, srcset: rendition }))).toBe('none');
});

test('the stage cuts each window from its own art', () => {
  const art: ZoneShowcaseArt = {
    landscape: deliveredShowcaseImage({ ...original, srcset: [] }),
    portrait: deliveredShowcaseImage({ ...original, crop: 'xywh=percent:25,0,50,100', srcset: [] }),
  };
  const html = renderToStaticMarkup(<Background art={art} first />);
  expect(html).toContain('--view-landscape:inset(20% 30% 35% 10%)');
  expect(html).toContain('--view-portrait:inset(0% 25% 0% 25%)');
});

test('the shelf words follow the Work kind and stay the reading words for a book', () => {
  const t = messages.en;
  const kind = (presentation: string, primaryAction: string, experience = 'plain') =>
    shelfWords({ kind: experience as 'plain', presentation: presentation as 'default', primaryAction: primaryAction as 'read' }, t);
  expect(kind('book', 'read', 'book')).toBeUndefined();
  expect(kind('game', 'visit')).toEqual({ wantToRead: 'Want to play', reading: 'Playing', read: 'Played' });
  expect(kind('default', 'install')).toEqual({ wantToRead: 'Want to use', reading: 'Using', read: 'Used' });
  expect(kind('prompt', 'copy', 'prompt')?.wantToRead).toBe('Want to use');
  expect(kind('recipe', 'read', 'recipe')).toEqual({ wantToRead: 'Want to cook', reading: 'Cooking', read: 'Cooked' });
});

test('a signed-in reader fetches art as their Agent, after any query the URL already has', () => {
  const query = '?actingSubject=https%3A%2F%2Frezics.com%2Fid%2Fagent';
  const image = deliveredShowcaseImage({ ...original, url: '/v1/media/representations/r/bytes?use=u',
    srcset: [{ url: '/v1/media/representations/s/bytes', width: 800, type: 'image/webp' }] }, query);
  expect(image.url).toBe(`/api/main/v1/media/representations/r/bytes?use=u&${query.slice(1)}`);
  expect(image.candidates?.[0]?.url).toBe(`/api/main/v1/media/representations/s/bytes${query}`);
  expect(deliveredShowcaseImage({ ...original, srcset: [] }).url).toBe('/api/main/v1/media/original.png');
});
