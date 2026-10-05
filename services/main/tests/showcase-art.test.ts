import { expect, test } from 'bun:test';
import sharp from 'sharp';
import {
  admitShowcaseImage,
  normalizeTrailer,
  showcaseSlot,
  ShowcaseRefused,
} from '../src/modules/media/showcase-contract.ts';
import { LocalImageTransformer } from '../src/modules/media-rendition/transform.ts';

test('logo slots canonically key BCP 47 language and tone independently of anchor', () => {
  expect(
    showcaseSlot({ role: 'logo', language: 'ZH-hant', tone: 'dark', anchor: 'center-top' }),
  ).toBe('showcase-logo:zh-Hant:dark');
  expect(
    showcaseSlot({ role: 'logo', language: 'zh-Hant', tone: 'dark', anchor: 'center-bottom' }),
  ).toBe('showcase-logo:zh-Hant:dark');
  expect(
    showcaseSlot({ role: 'logo', language: 'zxx', tone: 'light', anchor: 'start-bottom' }),
  ).toBe('showcase-logo:zxx:light');
  expect(
    showcaseSlot({ role: 'logo', language: 'x-studio', tone: 'light', anchor: 'center-middle' }),
  ).toBe('showcase-logo:x-studio:light');
  expect(
    showcaseSlot({ role: 'logo', language: 'i-klingon', tone: 'light', anchor: 'center-middle' }),
  ).toBe('showcase-logo:i-klingon:light');
  for (const input of [
    {
      role: 'logo' as const,
      language: 'en_US',
      tone: 'dark' as const,
      anchor: 'center-top' as const,
    },
    { role: 'logo' as const, language: 'en', anchor: 'center-top' as const },
    { role: 'logo' as const, language: 'en', tone: 'dark' as const },
    { role: 'cutout' as const, language: 'zxx' },
  ])
    expect(() => showcaseSlot(input)).toThrow();
});

function refused(code: ShowcaseRefused['code'], run: () => unknown) {
  try {
    run();
    throw new Error('expected refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(ShowcaseRefused);
    expect((error as ShowcaseRefused).code).toBe(code);
  }
}
test('background admission uses exact cropped oriented pixels, minima and bounded focal areas', () => {
  const landscape = { role: 'background-landscape' as const, crop: null, focalArea: null };
  expect(admitShowcaseImage(landscape, { width: 1280, height: 720 })).toEqual({
    width: 1280,
    height: 720,
  });
  expect(
    admitShowcaseImage(
      { ...landscape, crop: 'xywh=percent:0,0,100,50', focalArea: 'xywh=percent:10,10,20,20' },
      { width: 1280, height: 1440 },
    ),
  ).toEqual({ width: 1280, height: 720 });
  expect(
    admitShowcaseImage({ ...landscape, role: 'background-portrait' }, { width: 960, height: 1280 }),
  ).toEqual({ width: 960, height: 1280 });
  refused('showcase_ratio_mismatch', () =>
    admitShowcaseImage(landscape, { width: 1281, height: 720 }),
  );
  refused('showcase_resolution_too_small', () =>
    admitShowcaseImage(landscape, { width: 1264, height: 711 }),
  );
  refused('showcase_crop_invalid', () =>
    admitShowcaseImage(
      { ...landscape, crop: 'xywh=percent:0,0,101,100' },
      { width: 1280, height: 720 },
    ),
  );
  refused('showcase_crop_invalid', () =>
    admitShowcaseImage(
      { ...landscape, crop: 'xywh=percent:0,0,100,50', focalArea: 'xywh=percent:0,49,10,2' },
      { width: 1280, height: 1440 },
    ),
  );
  refused('showcase_alpha_required', () =>
    admitShowcaseImage(
      { ...landscape, role: 'cutout' },
      { width: 100, height: 100, hasAlpha: false },
    ),
  );
  expect(
    admitShowcaseImage({ ...landscape, role: 'logo' }, { width: 100, height: 100, hasAlpha: true }),
  ).toEqual({ width: 100, height: 100 });
});

test('the bounded inspector supplies real alpha and EXIF-oriented axes for showcase admission', async () => {
  const image = sharp({ create: { width: 1280, height: 960, channels: 3, background: '#123456' } });
  const jpeg = await image.jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const transformer = new LocalImageTransformer();
  const inspected = await transformer.inspect(jpeg, 'image/jpeg');
  expect(inspected).toMatchObject({ width: 960, height: 1280, hasAlpha: false });
  expect(
    admitShowcaseImage({ role: 'background-portrait', crop: null, focalArea: null }, inspected),
  ).toEqual({ width: 960, height: 1280 });
  const alpha = await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
  })
    .png()
    .toBuffer();
  expect(await transformer.inspect(alpha, 'image/png')).toMatchObject({ hasAlpha: true });
}, 20_000);

test('trailers normalize recognized watch forms, preserve Bilibili parts and leave other HTTPS links plain', () => {
  for (const url of [
    'https://youtu.be/dQw4w9WgXcQ?si=tracking',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=12',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
  ])
    expect(normalizeTrailer(url)).toEqual({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      provider: 'youtube',
    });
  expect(normalizeTrailer('https://m.bilibili.com/video/BV1La411N7Nd/?spm=track&p=2')).toEqual({
    url: 'https://www.bilibili.com/video/BV1La411N7Nd/?p=2',
    provider: 'bilibili',
  });
  expect(normalizeTrailer('https://player.bilibili.com/player.html?aid=123&page=1')).toEqual({
    url: 'https://www.bilibili.com/video/av123/',
    provider: 'bilibili',
  });
  expect(normalizeTrailer('https://studio.example/trailer?q=1#part')).toEqual({
    url: 'https://studio.example/trailer?q=1#part',
    provider: 'link',
  });
  expect(normalizeTrailer('https://youtube.com.studio.example/watch?v=not-youtube')?.provider).toBe(
    'link',
  );
  expect(normalizeTrailer(null)).toBeNull();
  for (const url of [
    'http://youtube.com/watch?v=dQw4w9WgXcQ',
    'javascript:alert(1)',
    'https://a:b@studio.example/t',
    'https://www.youtube.com/watch?v=bad',
    'https://www.bilibili.com/video/BV1La411N7Nd/?p=0',
  ])
    refused('showcase_trailer_invalid', () => normalizeTrailer(url));
});
