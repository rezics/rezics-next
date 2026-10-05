import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ShowcaseImage, WorkShowcase } from '../features/api/showcase.ts';
import { workShowcaseArt } from '../features/realm/adapt.ts';
import { type Drafts, type ImageDraft, logoCoverage, logoSlot, previewArt, savedArt } from '../features/showcase-editor/art.ts';
import {
  type BackgroundRole, backgroundFrames, containRect, holdsFrame, initialFrame, percentArea, phoneView, pixelArea,
  resizeFrame, snapFrame,
} from '../features/showcase-editor/frame.ts';
import { declaresAlpha, fileProblem, IMAGE_LIMITS, pixelProblem } from '../features/showcase-editor/image-file.ts';
import { copyOf, englishMessages, messages } from '../features/showcase-editor/messages.ts';
import { refusalOf } from '../features/showcase-editor/refusal.ts';
import { trailerOpening, trailerProblem } from '../features/showcase-editor/trailer.ts';
import { uploadShowcaseImage } from '../features/showcase-editor/upload.ts';
import { ImageRefused } from '../features/communities/images.ts';
import { editHref, editSections } from '../features/work-levels-edit/route.ts';
import { copyOf as editCopy, messages as editMessages } from '../features/work-levels-edit/messages.ts';
import { uiLocales } from '../i18n/define.ts';

// The editor refreshes through the App Router after a save.
void mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh() {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
const { SlotStatusView } = await import('../features/showcase-editor/status.tsx');
const { LayerRow } = await import('../features/showcase-editor/cards.tsx');

const roles: BackgroundRole[] = ['background-landscape', 'background-portrait'];
const ratio = (role: BackgroundRole) => backgroundFrames[role].units;

describe('framing backgrounds as Main admits them', () => {
  test('the first frame is the largest exact frame, centred; an image too small for the role has none', () => {
    const frame = initialFrame('background-landscape', { width: 2400, height: 1500 })!;
    expect(frame).toEqual({ left: 0, top: 75, width: 2400, height: 1350 });
    expect(initialFrame('background-portrait', { width: 1200, height: 1700 })).toEqual({ left: 0, top: 50, width: 1200, height: 1600 });
    expect(initialFrame('background-landscape', { width: 1279, height: 2000 })).toBeNull();
    expect(holdsFrame('background-portrait', { width: 959, height: 4000 })).toBe(false);
    expect(holdsFrame('background-portrait', { width: 960, height: 1280 })).toBe(true);
  });

  test('every snapped or resized frame is exactly 16:9 or 3:4, at least the minimum, and inside the image', () => {
    const size = { width: 3001, height: 2203 };
    for (const role of roles) {
      const [w, h] = ratio(role);
      const { min } = backgroundFrames[role];
      for (const rect of [{ left: -50, top: 10, width: 2000, height: 50 }, { left: 2900, top: 2100, width: 9999, height: 9999 },
        { left: 400.6, top: 300.2, width: 1333.3, height: 777.7 }]) {
        for (const fixed of [undefined, 'nw', 'ne', 'sw', 'se'] as const) {
          const frame = snapFrame(role, size, rect, fixed);
          expect(frame.width * h).toBe(frame.height * w);
          expect(frame.width).toBeGreaterThanOrEqual(min.width);
          expect(frame.left).toBeGreaterThanOrEqual(0);
          expect(frame.top).toBeGreaterThanOrEqual(0);
          expect(frame.left + frame.width).toBeLessThanOrEqual(size.width);
          expect(frame.top + frame.height).toBeLessThanOrEqual(size.height);
          expect(Number.isInteger(frame.left) && Number.isInteger(frame.top)).toBe(true);
        }
      }
      const scale = Math.ceil(min.width / w) + 3;
      const resized = resizeFrame(role, size, initialFrame(role, size)!, scale);
      expect([resized.width, resized.height]).toEqual([w * scale, h * scale]);
    }
  });

  test('a corner drag keeps the opposite corner where it was', () => {
    const size = { width: 4000, height: 3000 };
    const start = { left: 1000, top: 800, width: 1600, height: 900 };
    const grown = snapFrame('background-landscape', size, { left: 1000, top: 800, width: 2000, height: 1000 }, 'nw');
    expect([grown.left, grown.top]).toEqual([1000, 800]);
    const fromSe = snapFrame('background-landscape', size, { left: 700, top: 500, width: 1900, height: 1200 }, 'se');
    expect(fromSe.left + fromSe.width).toBe(start.left + start.width);
    expect(fromSe.top + fromSe.height).toBe(start.top + start.height);
  });

  test('a percent fragment lands on exactly the chosen pixels when Main rounds it back', () => {
    let seed = 7;
    const next = (limit: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % limit;
    for (let run = 0; run < 3000; run += 1) {
      const size = { width: 300 + next(16_000), height: 300 + next(16_000) };
      const width = 1 + next(size.width);
      const height = 1 + next(size.height);
      const rect = { left: next(size.width - width + 1), top: next(size.height - height + 1), width, height };
      const area = percentArea(rect, size);
      expect(area).toMatch(/^xywh=percent:([0-9]{1,3}(\.[0-9]{1,3})?,){3}[0-9]{1,3}(\.[0-9]{1,3})?$/);
      expect(pixelArea(area, size)).toEqual(rect);
    }
    expect(pixelArea(null, { width: 10, height: 20 })).toEqual({ left: 0, top: 0, width: 10, height: 20 });
    expect(pixelArea('xywh=percent:50,0,60,10', { width: 10, height: 20 })).toBeNull();
  });

  test('the focal area stays inside its frame', () => {
    const frame = { left: 100, top: 100, width: 1600, height: 900 };
    expect(containRect({ left: 0, top: 950, width: 400, height: 400 }, frame)).toEqual({ left: 100, top: 600, width: 400, height: 400 });
    expect(containRect({ left: 0, top: 0, width: 5000, height: 100 }, frame).width).toBe(1600);
  });

  test('phones cut landscape art around a focal area that fits a 3:4 card, and show it whole otherwise', () => {
    const frame = { left: 0, top: 0, width: 1600, height: 900 };
    expect(phoneView(frame, null)).toEqual({ kind: 'whole', reason: 'no-focal' });
    expect(phoneView(frame, { left: 100, top: 100, width: 900, height: 300 })).toEqual({ kind: 'whole', reason: 'focal-too-wide' });
    const cut = phoneView(frame, { left: 1400, top: 200, width: 150, height: 300 });
    expect(cut.kind === 'cut' && [cut.window.left + cut.window.width, cut.window.width]).toEqual([1600, 675]);
  });
});

/** A PNG with the given colour type and, optionally, a tRNS chunk before its image data. */
function png(colourType: number, transparency = false) {
  const chunk = (type: string, data: number[]) => [0, 0, 0, data.length, ...[...type].map(c => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, colourType, 0, 0, 0]),
    ...(transparency ? chunk('tRNS', [0, 0]) : []), ...chunk('IDAT', [1, 2, 3]), ...chunk('IEND', [])]);
}
function webp(kind: 'VP8X' | 'VP8L' | 'VP8 ', alpha: boolean) {
  const header = [...'RIFF'].map(c => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map(c => c.charCodeAt(0)), [...kind].map(c => c.charCodeAt(0)), [10, 0, 0, 0]);
  const body = kind === 'VP8X' ? [alpha ? 0x10 : 0, 0, 0, 0] : kind === 'VP8L' ? [0x2f, 0, 0, 0, alpha ? 0x10 : 0] : [0, 0, 0, 0, 0];
  return new Uint8Array([...header, ...body, ...new Array(12).fill(0)]);
}

describe('checking a file before upload', () => {
  test('an alpha channel is read from the header as Main\'s decoder reads it', () => {
    expect(declaresAlpha(png(6))).toBe(true);
    expect(declaresAlpha(png(4))).toBe(true);
    expect(declaresAlpha(png(2))).toBe(false);
    expect(declaresAlpha(png(2, true))).toBe(true);
    expect(declaresAlpha(png(3, true))).toBe(true);
    expect(declaresAlpha(png(3))).toBe(false);
    expect(declaresAlpha(webp('VP8X', true))).toBe(true);
    expect(declaresAlpha(webp('VP8X', false))).toBe(false);
    expect(declaresAlpha(webp('VP8L', true))).toBe(true);
    expect(declaresAlpha(webp('VP8L', false))).toBe(false);
    expect(declaresAlpha(webp('VP8 ', false))).toBe(false);
    expect(declaresAlpha(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)]))).toBe(false);
  });

  test('type, bytes and pixels are refused within Main\'s limits', () => {
    expect(fileProblem({ type: 'image/jpeg', size: 10 }, 'layer')).toBe('type');
    expect(fileProblem({ type: 'image/gif', size: 10 }, 'background')).toBe('type');
    expect(fileProblem({ type: 'image/png', size: IMAGE_LIMITS.bytes + 1 }, 'layer')).toBe('bytes');
    expect(fileProblem({ type: 'image/webp', size: 1 }, 'background')).toBeNull();
    expect(pixelProblem({ width: 16_385, height: 10 })).toBe('pixels');
    expect(pixelProblem({ width: 8000, height: 5000 })).toBe('pixels');
    expect(pixelProblem({ width: 4000, height: 3000 })).toBeNull();
  });
});

let serial = 0;
const id = () => `01a0e3d1-0000-7000-8000-${String(++serial).padStart(12, '0')}`;
function image(role: ShowcaseImage['role'], extra: Partial<ShowcaseImage> = {}): ShowcaseImage {
  return { role, selection: id(), asset: id(), use: id(), representation: id(), context: 'urn:rezics:media:context:default',
    url: `/v1/media/representations/${id()}/bytes?use=${id()}`, mediaType: 'image/png', width: 2400, height: 1500,
    cropWidth: 2400, cropHeight: 1350, crop: 'xywh=percent:0,5,100,90', focalArea: 'xywh=percent:60,20,20,40',
    srcset: [{ url: '/v1/media/representations/r/bytes?use=u&w=1280', type: 'image/webp', width: 1280, height: 720 },
      { url: '/v1/media/representations/r/bytes?use=u&w=1280a', type: 'image/avif', width: 1280, height: 720 }], ...extra };
}
const item: WorkShowcase = { reference: 'https://rezics.com/id/01a0e3d1-0000-7000-8000-000000000001', status: 'available', trailer: null,
  images: [image('background-landscape'), image('logo', { language: 'zxx', tone: 'light', anchor: 'center-top', crop: null, focalArea: null }),
    image('logo', { language: 'ja', tone: 'dark', anchor: 'start-bottom', crop: null, focalArea: null })] };
const acting = 'https://rezics.com/id/01a0e3d1-0000-7000-8000-0000000000aa';

describe('the art the stage draws', () => {
  test('saved art reads frames in pixels and names the acting Agent on media it loads through the BFF', () => {
    const saved = savedArt(item, acting);
    const landscape = saved.images['background-landscape']!;
    expect(landscape.frame).toEqual({ left: 0, top: 75, width: 2400, height: 1350 });
    expect(landscape.focal).toEqual({ left: 1440, top: 300, width: 480, height: 600 });
    expect(landscape.url).toStartWith('/api/main/v1/media/representations/');
    expect(new URL(landscape.url, 'https://x').searchParams.get('actingSubject')).toBe(acting);
    expect(landscape.candidates.map(candidate => candidate.width)).toEqual([1280]);
    expect(Object.keys(saved.images).sort()).toEqual(['background-landscape', 'logo:ja:dark', 'logo:zxx:light']);
  });

  test('with nothing unsaved, the preview draws what a Zone draws from the same read', () => {
    const zone = workShowcaseArt(item);
    const preview = previewArt(savedArt(item, acting), {});
    for (const side of ['x', 'y', 'width', 'height'] as const) expect(preview.landscape!.focal![side]).toBeCloseTo(zone.landscape!.focal![side], 12);
    expect([preview.landscape?.width, preview.landscape?.height, preview.landscape?.framed])
      .toEqual([zone.landscape?.width, zone.landscape?.height, zone.landscape?.framed]);
    expect(preview.logos?.map(logo => [logo.language, logo.tone, logo.anchor]).sort())
      .toEqual(zone.logos?.map(logo => [logo.language, logo.tone, logo.anchor]).sort());
    expect(zone.logos?.find(logo => logo.tone === 'light')?.language).toBe('');
  });

  test('unsaved changes win over the saved selection: a removal hides it, a new image shows its drawn frame', () => {
    const saved = savedArt(item, acting);
    const logo: ImageDraft = { kind: 'image', base: null, source: { url: 'blob:logo', size: { width: 900, height: 300 }, file: null, asset: null },
        frame: null, focal: null, anchor: 'center-bottom', framed: null, uploadKey: null };
    const drafts: Drafts = {
      'background-landscape': { kind: 'remove', base: saved.images['background-landscape']!.selection },
      [logoSlot('en', 'light')]: logo,
      'background-portrait': { kind: 'image', base: null, source: { url: 'blob:portrait', size: { width: 1200, height: 1600 }, file: null, asset: null },
        frame: { left: 0, top: 0, width: 1200, height: 1600 }, focal: { left: 300, top: 400, width: 600, height: 800 }, anchor: null,
        framed: { url: 'blob:framed', size: { width: 1200, height: 1600 }, key: 'k' }, uploadKey: null },
    };
    const art = previewArt(saved, drafts);
    expect(art.landscape).toBeNull();
    expect(art.portrait).toEqual({ url: 'blob:framed', width: 1200, height: 1600, framed: true, focal: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
    expect(art.logos?.find(logo => logo.language === 'en')).toMatchObject({ url: 'blob:logo', anchor: 'center-bottom', tone: 'light' });
  });

  test('coverage names each title language\'s logo; a dark logo alone leaves the live title', () => {
    const art = previewArt(savedArt(item, acting), {});
    const rows = logoCoverage(art, ['en', 'ja']);
    expect(rows[0]).toMatchObject({ language: 'en', darkOnly: false });
    expect(rows[0]!.logo?.language).toBe('');
    // A neutral light logo covers Japanese too: the dark Japanese one is never drawn on the dark scrim.
    expect(rows[1]!.logo?.language).toBe('');
    const withoutNeutral = previewArt(savedArt({ ...item, images: item.images.filter(entry => entry.language !== 'zxx') }, acting), {});
    expect(logoCoverage(withoutNeutral, ['ja'])[0]).toMatchObject({ logo: null, darkOnly: true });
  });
});

describe('what a save came to', () => {
  test('each Main problem is sorted into what the person can do about it', () => {
    const refusal = (status: number, code?: string, extra: object = {}) => {
      const result = refusalOf({ status, value: { code, ...extra } });
      return result.status === 'refused' ? result.refusal : null;
    };
    expect(refusal(422, 'showcase_crop_invalid')).toBe('crop');
    expect(refusal(422, 'showcase_ratio_mismatch')).toBe('ratio');
    expect(refusal(422, 'showcase_resolution_too_small')).toBe('resolution');
    expect(refusal(422, 'showcase_alpha_required')).toBe('alpha');
    expect(refusal(422, 'showcase_trailer_invalid')).toBe('trailer');
    expect(refusal(409, 'stale_head')).toBe('conflict');
    expect(refusal(409, 'idempotency_conflict')).toBe('repeat');
    expect(refusal(404, 'media_unavailable')).toBe('missing');
    expect(refusal(404, 'resource_unavailable')).toBe('gone');
    expect(refusal(403, 'authority_denied')).toBe('denied');
    expect(refusal(401)).toBe('sign-in');
    expect(refusal(429)).toBe('limited');
    expect(refusal(503, 'media_unavailable')).toBe('unavailable');
    expect(refusalOf({ status: 409, value: { code: 'stale_head', current: 'sel-2' } })).toMatchObject({ current: 'sel-2' });
  });

  test('every refusal and upload outcome is said in words, and a conflict offers a reload', () => {
    const t = copyOf('en');
    const html = (status: Parameters<typeof SlotStatusView>[0]['status']) =>
      renderToStaticMarkup(createElement(SlotStatusView, { status, t, onReload() {} }));
    expect(html({ kind: 'refused', refusal: 'conflict', detail: null, current: null })).toContain(t.reloadLatest);
    expect(html({ kind: 'refused', refusal: 'alpha', detail: 'Showcase media does not meet the selected role', current: null }))
      .toContain('Showcase media does not meet the selected role');
    expect(html({ kind: 'busy', stage: 'held' })).toContain(t.stageHeld);
    expect(html({ kind: 'upload', reason: 'rejected' })).toContain(t.uploadRejected);
    expect(html({ kind: 'file', problem: 'small', size: { width: 600, height: 800 }, min: { width: 960, height: 1280 } }))
      .toContain('600 × 800');
    expect(html({ kind: 'file', problem: 'alpha' })).toContain('alpha channel');
  });
});

describe('the trailer link', () => {
  test('a link that cannot be a trailer is caught before Main is asked', () => {
    expect(trailerProblem(' ')).toBe('empty');
    expect(trailerProblem('http://example.com')).toBe('not-https');
    expect(trailerProblem('https://user:secret@example.com/v')).toBe('credentials');
    expect(trailerProblem(`https://example.com/${'a'.repeat(2050)}`)).toBe('too-long');
    expect(trailerProblem('https://youtu.be/aqz-KE-bpKQ')).toBeNull();
  });

  test('the editor says how the stage will open it', () => {
    expect(trailerOpening('https://www.youtube.com/watch?v=aqz-KE-bpKQ')).toEqual({ kind: 'player', provider: 'youtube' });
    expect(trailerOpening('https://www.bilibili.com/video/BV1GJ411x7h7/')).toEqual({ kind: 'player', provider: 'bilibili' });
    // A Bilibili part opens on its own site, so the reader lands on that exact part.
    expect(trailerOpening('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2')).toEqual({ kind: 'tab', host: 'www.bilibili.com' });
    expect(trailerOpening('https://vimeo.com/76979871')).toEqual({ kind: 'tab', host: 'vimeo.com' });
  });
});

describe('uploading and screening', () => {
  const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
  const run = (clearances: (string | null)[], first = 'screening', fail?: unknown) => {
    const stages: string[] = [];
    let looked = 0;
    const result = uploadShowcaseImage({ file, actingSubject: acting, key: 'k', onStage: stage => stages.push(stage) }, {
      store: async () => { if (fail) throw fail; return { asset: 'asset-1', upload: 'upload-1', representation: 'r', clearance: first as 'screening' }; },
      check: async () => (clearances[looked++] ?? null) as never,
      wait: async () => {},
      markAdult: async () => {},
    });
    return { result, stages };
  };

  test('the image is selected only once screening clears it', async () => {
    const { result, stages } = run(['screening', 'cleared']);
    expect(await result).toEqual({ status: 'cleared', asset: 'asset-1' });
    expect(stages).toEqual(['uploading', 'screening', 'screening']);
  });

  test('a held image is explained and never selected; a rejected one is refused', async () => {
    const held = run(new Array(30).fill('held'), 'held');
    expect(await held.result).toEqual({ status: 'refused', reason: 'held' });
    expect(held.stages.slice(0, 2)).toEqual(['uploading', 'held']);
    expect(await run(['rejected']).result).toEqual({ status: 'refused', reason: 'rejected' });
    expect(await run([], 'screening', new ImageRefused('limited', 120)).result).toEqual({ status: 'refused', reason: 'limited', retryAfter: 120 });
    expect(await run([], 'screening', new Error('network')).result).toEqual({ status: 'refused', reason: 'failed' });
  });
});

describe('an author calling an upload adult content', () => {
  const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
  const upload = (adult: boolean, markAdult: () => Promise<void>, clearance: 'cleared' | 'rejected' = 'cleared') => {
    const marked: unknown[] = [];
    const result = uploadShowcaseImage({ file, actingSubject: acting, key: 'k', adult, onStage: () => {} }, {
      store: async () => ({ asset: 'asset-1', upload: 'upload-1', representation: 'rep-1', clearance }),
      check: async () => null, wait: async () => {},
      markAdult: async input => { marked.push(input); await markAdult(); },
    });
    return { result, marked };
  };

  test('a marked upload is labelled NSFW as its author on the stored representation, then selected', async () => {
    const { result, marked } = upload(true, async () => {});
    expect(await result).toEqual({ status: 'cleared', asset: 'asset-1' });
    expect(marked).toEqual([{ representation: 'rep-1', actingSubject: acting }]);
  });

  test('an unmarked upload is left to the classification recorded on this device', async () => {
    const { result, marked } = upload(false, async () => {});
    expect(await result).toEqual({ status: 'cleared', asset: 'asset-1' });
    expect(marked).toEqual([]);
  });

  test('when the label cannot be set the image is not used, so adult art never shows unmasked', async () => {
    const { result } = upload(true, async () => { throw new Error('image-control-unavailable'); });
    expect(await result).toEqual({ status: 'refused', reason: 'failed' });
  });

  test('an image screening rejected is refused before anything is labelled', async () => {
    const { result, marked } = upload(true, async () => {}, 'rejected');
    expect(await result).toEqual({ status: 'refused', reason: 'rejected' });
    expect(marked).toEqual([]);
  });
});

describe('the adult-content choice on a file waiting to be uploaded', () => {
  const t = copyOf('en');
  const chosen = (adult?: boolean, file: File | null = new File([new Uint8Array([1])], 'cutout.png', { type: 'image/png' })): ImageDraft =>
    ({ kind: 'image', base: null, source: { url: 'blob:cutout', size: { width: 900, height: 1200 }, file, asset: null }, frame: null, focal: null,
      anchor: null, framed: null, uploadKey: null, ...(adult === undefined ? {} : { adult }) });
  const card = (draft: ImageDraft | undefined) => renderToStaticMarkup(createElement(LayerRow, { title: 'Cutout', tone: null, saved: undefined,
    draft, status: undefined, busy: false, anchor: null,
    actions: { onFile() {}, onRemove() {}, onDiscard() {}, onSave() {}, onReload() {}, onAdult() {} }, t }));

  test('a new file offers it, and says what readers see either way', () => {
    expect(card(chosen())).toContain(t.adultLabel);
    expect(card(chosen())).toContain(t.adultUnmarked);
    expect(card(chosen(true))).toContain(t.adultMarked);
    expect(card(chosen(true))).not.toContain(t.adultUnmarked);
  });

  test('a slot with nothing chosen, or only re-framed, does not', () => {
    expect(card(undefined)).not.toContain(t.adultLabel);
    expect(card(chosen(undefined, null))).not.toContain(t.adultLabel);
  });
});

describe('the showcase edit section and its catalogs', () => {
  test('the edit pages link the showcase beside parts, relations and editions', () => {
    expect(editSections).toContain('showcase');
    expect(editHref('01a0e3d1-0000-7000-8000-000000000001', 'showcase')).toEndWith('/edit/showcase');
    for (const locale of uiLocales) expect(editCopy(locale).tabShowcase).toBeTruthy();
    expect(Object.keys(editMessages['zh-Hant'])).toContain('tabShowcase');
  });

  test('every locale supplies every key English does, with the same placeholders', () => {
    const english = Object.keys(englishMessages).sort();
    const placeholders = (value: unknown) => [...String(typeof value === 'string' ? value
      : (value as { pattern?: string }).pattern ?? '').matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort();
    for (const locale of uiLocales) {
      expect(Object.keys(messages[locale]).sort()).toEqual(english);
      for (const key of english) {
        expect(placeholders(messages[locale][key as keyof typeof englishMessages]), `${locale}.${key}`)
          .toEqual(placeholders(englishMessages[key as keyof typeof englishMessages]));
      }
    }
  });
});
