import { describe, expect, mock, test } from 'bun:test';
import type { ZoneWork } from '@rezics/zone-sdk';
import { materializeData } from 'native-i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { uiLocales } from '../i18n/define.ts';
import { resourceHref } from '../features/address/path.ts';
import type { ZonePresentationRead } from '../features/realm/types.ts';
import { messages as editorMessages } from '../features/showcase-editor/messages.ts';
import { messages as pickerMessages } from '../features/work-levels-edit/messages.ts';
import { artSourceOf, missingSlots, previewSlides, registryOf, savedArtOf } from '../features/showcase-zone-editor/art.ts';
import { configurationRefusalOf, configurationSaveOf } from '../features/showcase-zone-editor/refusal.ts';
import { englishMessages, messages } from '../features/showcase-zone-editor/messages.ts';
import {
  blankSlide, documentFor, draftOf, dropSlide, emptyDocument, fingerprint, localInput, moveSlide, needsShowcaseModule,
  readStoredPresentation, scheduleState, type SlideDraft, slideProblems, type StoredSlide, storedSlideOf, utcFromInput,
} from '../features/showcase-zone-editor/slides.ts';

const work = (n: number) => `https://rezics.com/id/01a0e3d1-0000-7000-8000-${String(n).padStart(12, '0')}`;
const workHref = (n: number) => resourceHref('/w/', work(n).slice(-36));
const use = (n: number) => `https://rezics.com/id/01a0e3d1-0000-7000-8000-0000000000${n}`;

const stored: StoredSlide[] = [
  { id: 'hades', work: work(1), kicker: 'Game of the week', kickers: { 'zh-Hant': '本週遊戲' } },
  { id: 'contest', href: '/discover', title: 'Autumn serial contest', titles: { ja: '秋の連載コンテスト' },
    startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-31T15:59:00.000Z',
    art: { landscape: { use: use(11) }, cutout: { use: use(12) },
      logos: [{ use: use(13), language: 'en', tone: 'light', anchor: 'center-top' }, { use: use(14), language: 'zxx', tone: 'dark', anchor: 'start-bottom' }] } },
];
const document = () => ({ ...emptyDocument(), preset: 'vibrant', navigation: [{ label: 'Browse', href: '/browse' }],
  official: { theme: 'https://rezics.com/id/01a0e3d1-0000-7000-8000-0000000000f0' },
  modules: [{ id: 'recent', type: 'shelf', title: 'Newly picked', titles: { ja: '新着' }, source: { kind: 'query-block', block: 'new-adoptions' } }],
  slides: stored });

describe('the Zone presentation the editor reads', () => {
  test('a v2 document is edited, no document starts one, and anything else is left alone', () => {
    const read = readStoredPresentation({ presentation: { ...document(), tokens: { ...emptyDocument().tokens, titleEffect: 'glow' } } });
    expect(read.kind === 'document' && [read.document.slides.length, read.document.tokens.titleEffect]).toEqual([2, 'glow']);
    expect(readStoredPresentation({}).kind).toBe('none');
    expect(readStoredPresentation({ presentation: null }).kind).toBe('none');
    // Saving would replace what the editor cannot read, so it never starts from it.
    expect(readStoredPresentation({ presentation: 'https://rezics.com/id/01a0e3d1-0000-7000-8000-0000000000f1' }).kind).toBe('reference');
    expect(readStoredPresentation({ presentation: { profile: 'zone-presentation-v1', banners: [] } }).kind).toBe('reference');
    expect(readStoredPresentation({ presentation: { ...document(), slides: 'none' } }).kind).toBe('reference');
    expect(readStoredPresentation('nothing').kind).toBe('none');
  });

  test('an unknown title effect reads as plain, as the stage draws it', () => {
    const read = readStoredPresentation({ presentation: { ...document(), tokens: { ...emptyDocument().tokens, titleEffect: 'sparkle' } } });
    expect(read.kind === 'document' && read.document.tokens.titleEffect).toBe('plain');
  });
});

describe('slides as they are edited and saved', () => {
  test('a stored slide comes back exactly as it was, art and schedule included', () => {
    for (const slide of stored) expect(storedSlideOf(draftOf(slide))).toEqual(slide);
  });

  test('empty text, blank translations and an unset schedule are left out; a link is trimmed', () => {
    const draft: SlideDraft = { ...blankSlide([], { kind: 'link', href: '  /browse  ' }), kicker: '   ', title: ' Open ',
      kickers: { en: '', ja: '  ' }, titles: { de: ' Offen ' } };
    expect(storedSlideOf(draft)).toEqual({ id: draft.id, href: '/browse', title: 'Open', titles: { de: 'Offen' } });
  });

  test('new slides get slugs no other slide uses', () => {
    const taken = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const slide = blankSlide(taken, { kind: 'work', work: work(index) });
      expect(slide.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(taken.has(slide.id)).toBe(false);
      taken.add(slide.id);
    }
  });

  test('moving by one place or dropping on another slide keeps every slide, and clamps at the ends', () => {
    const slides = ['a', 'b', 'c', 'd'].map(id => ({ ...blankSlide([], { kind: 'link', href: `/${id}` }), key: id }));
    const order = (list: readonly SlideDraft[]) => list.map(slide => slide.key).join('');
    expect(order(moveSlide(slides, 'b', 1))).toBe('acbd');
    expect(order(moveSlide(slides, 'a', -1))).toBe('abcd');
    expect(order(moveSlide(slides, 'd', 1))).toBe('abcd');
    expect(order(dropSlide(slides, 'a', 'c'))).toBe('bcad');
    expect(order(dropSlide(slides, 'd', 'a'))).toBe('dabc');
    expect(order(dropSlide(slides, 'b', 'b'))).toBe('abcd');
  });
});

describe('the document that is saved', () => {
  test('only the slides and the title effect change; modules, navigation, other tokens and an official theme are carried through', () => {
    const base = document();
    const slides = stored.map(slide => draftOf(slide));
    const next = documentFor(base, slides.slice().reverse(), 'outline', { title: 'Featured' });
    expect(next.slides.map(slide => slide.id)).toEqual(['contest', 'hades']);
    expect(next.tokens).toEqual({ ...base.tokens, titleEffect: 'outline' });
    expect({ ...next, slides: base.slides, tokens: base.tokens }).toEqual({ ...base, slides: base.slides, tokens: base.tokens,
      modules: [{ id: 'picks', type: 'hero-carousel', title: 'Featured', source: { kind: 'query-block', block: 'new-adoptions' } }, ...base.modules] });
    // The stored document is not changed in place.
    expect(base.slides).toBe(stored);
    expect(base.tokens.titleEffect).toBe('plain');
  });

  test('a layout with no showcase area gets one only when slides need it, and never one that exists', () => {
    const none = emptyDocument();
    expect(needsShowcaseModule(none, [])).toBe(false);
    const slides = [draftOf(stored[0]!)];
    expect(needsShowcaseModule(none, slides)).toBe(true);
    expect(documentFor(none, [], 'plain', { title: 'Featured' }).modules).toEqual([]);
    const withHero = { ...none, modules: [{ id: 'picks', type: 'hero-carousel' }] };
    expect(needsShowcaseModule(withHero, slides)).toBe(false);
    expect(documentFor(withHero, slides, 'plain', { title: 'Featured' }).modules).toEqual(withHero.modules);
    // A module already named `picks` of another kind does not clash.
    const taken = { ...none, modules: [{ id: 'picks', type: 'shelf' }] };
    expect(documentFor(taken, slides, 'plain', { title: 'Featured' }).modules.map(module => module.id)).toEqual(['showcase', 'picks']);
  });

  test('two arrangements that save to the same document are the same change', () => {
    const slides = stored.map(slide => draftOf(slide));
    expect(fingerprint(slides, 'plain')).toBe(fingerprint(stored.map(slide => draftOf(slide)), 'plain'));
    expect(fingerprint(slides, 'plain')).not.toBe(fingerprint(slides, 'glow'));
    expect(fingerprint(slides, 'plain')).not.toBe(fingerprint(slides.slice().reverse(), 'plain'));
    expect(fingerprint([{ ...slides[0]!, kicker: 'Game of the week ' }, slides[1]!], 'plain')).toBe(fingerprint(slides, 'plain'));
  });
});

describe('what Main would refuse, said while it is typed', () => {
  const slide = (target: SlideDraft['target'], change: Partial<SlideDraft> = {}) => ({ ...blankSlide([], target), ...change });
  test('a Work slide needs a Work; a link slide needs a site address', () => {
    expect(slideProblems(slide({ kind: 'work', work: '' }))).toEqual([{ kind: 'no-work' }]);
    expect(slideProblems(slide({ kind: 'work', work: work(1) }))).toEqual([]);
    const link = (href: string) => slideProblems(slide({ kind: 'link', href }));
    expect(link('')).toEqual([{ kind: 'link', reason: 'empty' }]);
    expect(link('  ')).toEqual([{ kind: 'link', reason: 'empty' }]);
    for (const bad of ['fiction', '//example.com', 'https://rezics.com/discover', '/browse/with space', `/${'a'.repeat(256)}`]) {
      expect(link(bad)).toEqual([{ kind: 'link', reason: 'form' }]);
    }
    for (const good of ['/', '/discover', '/discover?tab=new#top', `/${'a'.repeat(255)}`]) expect(link(good)).toEqual([]);
  });

  test('text is limited to 120 characters in every language, counting characters rather than code units', () => {
    const target = { kind: 'work', work: work(1) } as const;
    expect(slideProblems(slide(target, { title: '字'.repeat(120), kicker: '😀'.repeat(120) }))).toEqual([]);
    expect(slideProblems(slide(target, { title: 'x'.repeat(121), titles: { de: 'y'.repeat(121) }, kickers: { ja: 'z'.repeat(121) } })))
      .toEqual([{ kind: 'long', field: 'title', language: null }, { kind: 'long', field: 'kicker', language: 'ja' },
        { kind: 'long', field: 'title', language: 'de' }]);
  });

  test('a schedule must end after it starts', () => {
    const target = { kind: 'work', work: work(1) } as const;
    expect(slideProblems(slide(target, { startsAt: '2026-10-02T00:00:00.000Z', endsAt: '2026-10-01T00:00:00.000Z' }))).toEqual([{ kind: 'schedule', reason: 'empty' }]);
    expect(slideProblems(slide(target, { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-01T00:00:00.000Z' }))).toEqual([{ kind: 'schedule', reason: 'empty' }]);
    expect(slideProblems(slide(target, { startsAt: '2026-10-01T00:00:00.000Z' }))).toEqual([]);
    expect(slideProblems(slide(target, { endsAt: '2026-10-01T00:00:00.000Z' }))).toEqual([]);
    expect(slideProblems(slide(target, { startsAt: 'soon' }))).toEqual([{ kind: 'schedule', reason: 'invalid' }]);
  });
});

describe('schedules on the person\'s own clock', () => {
  test('an input value is the exact UTC time Main stores, and reads back unchanged', () => {
    for (const value of ['2026-10-05T09:30', '2026-12-31T23:59', '2027-03-14T02:30', '2026-01-01T00:00']) {
      const iso = utcFromInput(value);
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
      expect(new Date(iso as string).toISOString()).toBe(iso as string);
      expect(localInput(iso as string)).toBe(value === '2027-03-14T02:30' ? localInput(iso as string) : value);
    }
    const [year, month, day, hour, minute] = [2026, 10, 6, 9, 30];
    expect(Date.parse(utcFromInput('2026-10-06T09:30') as string)).toBe(new Date(year, month - 1, day, hour, minute).getTime());
    expect(utcFromInput('')).toBeNull();
    expect(utcFromInput('tomorrow')).toBe('invalid');
    expect(localInput(null)).toBe('');
    expect(localInput('not a time')).toBe('');
  });

  test('a slide shows from its start and until its end, as the Zone\'s home reads it', () => {
    const slide = { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-31T00:00:00.000Z' };
    expect(scheduleState({ startsAt: null, endsAt: null }, 0)).toBe('always');
    expect(scheduleState(slide, Date.parse('2026-09-30T23:59:59.999Z'))).toBe('upcoming');
    expect(scheduleState(slide, Date.parse('2026-10-01T00:00:00.000Z'))).toBe('live');
    expect(scheduleState(slide, Date.parse('2026-10-30T23:59:59.999Z'))).toBe('live');
    expect(scheduleState(slide, Date.parse('2026-10-31T00:00:00.000Z'))).toBe('ended');
    expect(scheduleState({ startsAt: null, endsAt: slide.endsAt }, 0)).toBe('live');
    expect(scheduleState({ startsAt: slide.startsAt, endsAt: null }, Date.parse('2030-01-01T00:00:00.000Z'))).toBe('live');
  });
});

describe('what saving a showcase came to', () => {
  test('Main\'s answers sort by what a person can do about them', () => {
    const of = (status: number, code: string | null = null) => configurationRefusalOf({ status, value: code ? { code, detail: `because ${code}` } : undefined });
    expect(of(401)).toMatchObject({ refusal: 'sign-in' });
    expect(of(403, 'official_zone_denied')).toMatchObject({ refusal: 'denied' });
    expect(of(404, 'zone_unavailable')).toMatchObject({ refusal: 'gone' });
    expect(of(409, 'stale_zone_head')).toMatchObject({ refusal: 'conflict', detail: 'because stale_zone_head' });
    expect(of(409, 'zone_conflict')).toMatchObject({ refusal: 'conflict' });
    // A key reused for another save is a conflict that reloading does not change.
    expect(of(409, 'idempotency_conflict')).toMatchObject({ refusal: 'repeat' });
    expect(of(400, 'invalid_zone_configuration')).toMatchObject({ refusal: 'invalid', detail: 'because invalid_zone_configuration' });
    expect(of(429)).toMatchObject({ refusal: 'limited' });
    expect(of(503, 'zone_unavailable')).toMatchObject({ refusal: 'unavailable' });
  });

  test('a save answers with the new revision, a pending operation to repeat, or nothing usable', () => {
    expect(configurationSaveOf({ data: { revision: 'https://rezics.com/id/r', replayed: true }, error: null }))
      .toEqual({ status: 'done', revision: 'https://rezics.com/id/r', replayed: true });
    expect(configurationSaveOf({ data: { operationId: 'op' }, error: null })).toMatchObject({ refusal: 'pending' });
    expect(configurationSaveOf({ data: null, error: null })).toMatchObject({ refusal: 'unavailable' });
    expect(configurationSaveOf({ data: null, error: { status: 429 }, headers: new Headers({ 'retry-after': '12' }) }))
      .toMatchObject({ refusal: 'limited', retryAfter: 12 });
  });
});

describe('campaign art as the editor shows it', () => {
  const srcset = [{ url: '/v1/media/representations/r1/bytes?use=u', width: 1280, height: 720, type: 'image/webp' as const },
    { url: '/v1/media/representations/r2/bytes?use=u', width: 1280, height: 720, type: 'image/avif' as const }];
  const delivered = (id: string, width: number, height: number, extra: Record<string, unknown> = {}) =>
    ({ use: id, crop: 'xywh=percent:0,5,100,90', cropWidth: width, cropHeight: Math.round(height * 0.9), url: `/v1/media/uses/${id.slice(-36)}`,
      width, height, mediaType: 'image/png', srcset, ...extra });
  const slideMedia = [{ id: 'contest', art: { landscape: delivered(use(11), 2400, 1500, { focalArea: 'xywh=percent:60,20,20,40' }), portrait: null, cutout: null,
    logos: [{ ...delivered(use(13), 600, 200, { crop: null }), language: 'en', tone: 'light', anchor: 'center-top' }] } }] as unknown as ZonePresentationRead['slideMedia'];
  const agent = 'https://rezics.com/id/01a0e3d1-0000-7000-8000-0000000000aa';

  test('Main\'s delivered images become editable saved images, fetched as the acting Agent', () => {
    const registry = registryOf(slideMedia, agent);
    expect(Object.keys(registry).sort()).toEqual([use(11), use(13)].sort());
    const landscape = registry[use(11)]!;
    expect(landscape).toMatchObject({ slot: 'background-landscape', selection: use(11), size: { width: 2400, height: 1500 },
      frame: { left: 0, top: 75, width: 2400, height: 1350 }, focal: { left: 1440, top: 300, width: 480, height: 600 } });
    expect(landscape.url).toStartWith('/api/main/v1/media/uses/');
    expect(new URL(landscape.url, 'https://x').searchParams.get('actingSubject')).toBe(agent);
    expect(landscape.candidates.map(candidate => candidate.width)).toEqual([1280]);
    expect(registry[use(13)]).toMatchObject({ slot: 'logo:en:light', anchor: 'center-top' });
    // Without an Agent the images keep their public paths.
    expect(registryOf(slideMedia)[use(11)]!.url).not.toContain('actingSubject');
  });

  test('a slide\'s art names Uses; those Main cannot deliver are said to be missing, not drawn', () => {
    const registry = registryOf(slideMedia);
    const slide = draftOf(stored[1]!);
    const saved = savedArtOf(slide.art, registry);
    expect(Object.keys(saved.images).sort()).toEqual(['background-landscape', 'logo:en:light']);
    // The slide's own anchor wins over the one stored with the Use.
    expect(saved.images['logo:en:light']!.anchor).toBe('center-top');
    expect(missingSlots(slide.art, registry).sort()).toEqual(['cutout', 'logo:zxx:dark']);
  });

  test('the preview draws what a Zone draws: translations by reader language, no slide for a Work readers cannot see', () => {
    const registry = registryOf(slideMedia);
    const card = (id: number): ZoneWork => ({ id: work(id), href: workHref(id), title: { value: `Work ${id}`, lang: 'en', dir: 'ltr' }, cover: null, kind: 'book',
      author: null, tagline: { value: 'A tagline', lang: 'en', dir: 'ltr' }, status: null, chapters: null, words: null, updatedAt: null, decision: null });
    const slides = [...stored.map(slide => draftOf(slide)), draftOf({ id: 'gone', work: work(9) }), draftOf({ id: 'loading', work: work(7) })];
    const input = { slides, works: { [work(1)]: card(1), [work(9)]: null }, registry, drafts: {}, framed: {}, reader: 'ja' as const };
    const drawn = previewSlides(input);
    expect(drawn.map(slide => slide.id)).toEqual(['hades', 'contest']);
    expect(drawn[1]!.title).toMatchObject({ value: '秋の連載コンテスト', lang: 'ja' });
    expect(drawn[0]!.kicker).toMatchObject({ value: 'Game of the week' });
    expect(previewSlides({ ...input, reader: 'zh-Hant' })[0]!.kicker).toMatchObject({ value: '本週遊戲', lang: 'zh-Hant' });
    // A slide with no words of its own takes the Work's title.
    expect(drawn[0]!.title.value).toBe('Work 1');
    expect(drawn[0]!.href).toBe(workHref(1));
    expect(drawn[1]!.href).toBe('/discover');
  });

  test('a slide shows its own art, the Work\'s, the composed cover or none, as the stage decides', () => {
    const registry = registryOf(slideMedia);
    const art = { landscape: { url: '/w.webp', width: 1600, height: 900, framed: true } };
    const card = (showcaseArt: ZoneWork['showcaseArt']): ZoneWork => ({ id: work(1), href: workHref(1), title: { value: 'Work', lang: 'en', dir: 'ltr' }, cover: null,
      kind: 'book', author: null, tagline: null, status: null, chapters: null, words: null, updatedAt: null, decision: null, showcaseArt });
    const make = (slide: StoredSlide, showcaseArt: ZoneWork['showcaseArt']) => previewSlides({ slides: [draftOf(slide)], works: { [work(1)]: card(showcaseArt) },
      registry, drafts: {}, framed: {}, reader: 'en' })[0]!;
    expect(artSourceOf(make(stored[1]!, art))).toBe('campaign');
    expect(artSourceOf(make({ id: 'w', work: work(1) }, art))).toBe('work');
    expect(artSourceOf(make({ id: 'w', work: work(1) }, null))).toBe('cover');
    expect(artSourceOf(make({ id: 'l', href: '/browse' }, null))).toBe('none');
    // Campaign logos alone do not replace a Work's background art, as the stage reads it.
    expect(artSourceOf(make({ id: 'w', work: work(1), art: { logos: [{ use: use(13), language: 'en', tone: 'light', anchor: 'center-top' }] } }, art))).toBe('work');
  });
});

describe('interface copy', () => {
  test('every locale has the same messages as English, of the same kind', () => {
    const english = materializeData(englishMessages, { locale: 'en' }) as Record<string, unknown>;
    for (const locale of uiLocales) {
      const catalog = materializeData(messages[locale], { locale }) as Record<string, unknown>;
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(english).sort());
      for (const key of Object.keys(english)) expect([locale, key, typeof catalog[key]]).toEqual([locale, key, typeof english[key]]);
    }
  });

  test('a locale\'s message is its own: only brand names and symbols match English', () => {
    const english = materializeData(englishMessages, { locale: 'en' }) as Record<string, unknown>;
    for (const locale of uiLocales.filter(locale => locale !== 'en')) {
      const catalog = materializeData(messages[locale], { locale }) as Record<string, unknown>;
      const same = Object.keys(english).filter(key => typeof english[key] === 'string' && english[key] === catalog[key]);
      expect([locale, same]).toEqual([locale, []]);
    }
  });

  test('messages with counts and names take them in every locale', () => {
    for (const locale of uiLocales) {
      const t = materializeData(messages[locale], { locale }) as unknown as { slideCount: (v: Record<string, string>) => string;
        moved: (v: Record<string, string>) => string; pendingImages: (count: number) => string; reloaded: (count: number) => string };
      expect(t.slideCount({ count: '3', max: '6' })).toMatch(/3/);
      expect(t.slideCount({ count: '3', max: '6' })).toMatch(/6/);
      expect(t.moved({ slide: 'SLIDE', position: '2', count: '5' })).toContain('SLIDE');
      for (const count of [1, 2]) {
        expect(t.pendingImages(count)).toContain(String(count));
        expect(t.reloaded(count)).toContain(String(count));
      }
    }
  });
});

describe('the writes the editor asks Main for', () => {
  type Call = { path: string; body: Record<string, unknown>; key: string | undefined };
  const calls: Call[] = [];
  let answer: { data: unknown; error: { status: number; value?: unknown } | null; headers?: unknown } = { data: null, error: null };
  const agent = 'https://rezics.com/id/01a0e3d1-0000-7000-8000-0000000000aa';
  let acting: string | undefined = agent;
  const main = { v1: { zones: ({ id }: { id: string }) => ({
    configuration: { put: async (body: Record<string, unknown>, init: { headers: Record<string, string> }) => { calls.push({ path: `${id}/configuration`, body, key: init.headers['idempotency-key'] }); return answer; } },
    'campaign-art': { post: async (body: Record<string, unknown>, init: { headers: Record<string, string> }) => { calls.push({ path: `${id}/campaign-art`, body, key: init.headers['idempotency-key'] }); return answer; } },
  }) } };
  void mock.module('../features/work-page/read.ts', () => ({ reader: async () => ({ main, actingSubject: acting, signedIn: Boolean(acting) }) }));
  const zone = '5a1d0000-0000-4000-8000-000000000001';
  const head = 'https://rezics.com/id/5a1d0000-0000-4000-8000-0000000000e1';
  const realm = 'https://rezics.com/id/5a1d0000-0000-4000-8000-0000000000aa';
  const asset = '01a0e3d1-0000-7000-8000-0000000000bb';
  const reset = (next: typeof answer = { data: null, error: null }) => { calls.length = 0; answer = next; acting = agent; };

  test('saving names the revision the person started from, signs the write by what it says and never sends a malformed document', async () => {
    const { saveShowcase } = await import('../features/showcase-zone-editor/actions.ts');
    const presentation = { ...document(), tokens: { ...document().tokens, titleEffect: 'glow' } } as never;
    reset({ data: { zone, revision: 'https://rezics.com/id/new', receipt: 'r', replayed: false }, error: null });
    expect(await saveShowcase({ zone, expectedHead: head, presentation })).toEqual({ status: 'done', revision: 'https://rezics.com/id/new', replayed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`${zone}/configuration`);
    expect(calls[0]!.body).toEqual({ expectedHead: head, actingSubject: agent, presentation });
    // The same save again replays; another document, or another revision, is another write.
    await saveShowcase({ zone, expectedHead: head, presentation });
    await saveShowcase({ zone, expectedHead: head, presentation: { ...(presentation as object), preset: 'clean' } as never });
    await saveShowcase({ zone, expectedHead: 'https://rezics.com/id/5a1d0000-0000-4000-8000-0000000000e9', presentation });
    expect(calls[1]!.key).toBe(calls[0]!.key!);
    expect(calls[2]!.key).not.toBe(calls[0]!.key!);
    expect(calls[3]!.key).not.toBe(calls[0]!.key!);
    expect(calls[0]!.key).toMatch(/^[A-Za-z0-9:_./-]{1,128}$/);
    reset();
    for (const bad of [{ zone: 'zone', expectedHead: head, presentation }, { zone, expectedHead: 'head', presentation },
      { zone, expectedHead: head, presentation: { ...(presentation as object), profile: 'zone-presentation-v1' } as never }, { zone, expectedHead: head, presentation: null as never }]) {
      expect(await saveShowcase(bad)).toMatchObject({ status: 'refused', refusal: 'invalid' });
    }
    expect(calls).toHaveLength(0);
  });

  test('saving without an eligible Agent asks to sign in, and Main\'s refusals come back typed', async () => {
    const { saveShowcase } = await import('../features/showcase-zone-editor/actions.ts');
    const presentation = document() as never;
    reset();
    acting = undefined;
    expect(await saveShowcase({ zone, expectedHead: head, presentation })).toMatchObject({ refusal: 'sign-in' });
    expect(calls).toHaveLength(0);
    reset({ data: null, error: { status: 409, value: { code: 'stale_zone_head', detail: 'Zone head changed' } } });
    expect(await saveShowcase({ zone, expectedHead: head, presentation })).toMatchObject({ refusal: 'conflict', detail: 'Zone head changed' });
    reset({ data: { operationId: 'op' }, error: null });
    expect(await saveShowcase({ zone, expectedHead: head, presentation })).toMatchObject({ refusal: 'pending' });
  });

  test('campaign art is asked for by role, with a logo\'s language in Main\'s canonical form', async () => {
    const { addCampaignArt } = await import('../features/showcase-zone-editor/actions.ts');
    reset({ data: { outcome: 'succeeded', id: '01a0e3d1-0000-7000-8000-0000000000c1', replayed: false }, error: null });
    expect(await addCampaignArt({ zone, realm, role: 'background-landscape', asset, crop: 'xywh=percent:0,5,100,90', focalArea: null }))
      .toEqual({ status: 'done', use: 'https://rezics.com/id/01a0e3d1-0000-7000-8000-0000000000c1', replayed: false });
    expect(calls[0]!.path).toBe(`${zone}/campaign-art`);
    expect(calls[0]!.body).toEqual({ profile: 'zone-campaign-art-v1', realm, asset, role: 'background-landscape', crop: 'xywh=percent:0,5,100,90', focalArea: null, actingSubject: agent });
    await addCampaignArt({ zone, realm, role: 'logo', language: 'zh-hant', tone: 'light', anchor: 'center-top', asset, crop: null, focalArea: null });
    expect(calls[1]!.body).toMatchObject({ role: 'logo', language: 'zh-Hant', tone: 'light', anchor: 'center-top' });
    // The same image framed the same way replays; a new frame is a new Use.
    await addCampaignArt({ zone, realm, role: 'background-landscape', asset, crop: 'xywh=percent:0,5,100,90', focalArea: null });
    await addCampaignArt({ zone, realm, role: 'background-landscape', asset, crop: 'xywh=percent:0,6,100,90', focalArea: null });
    expect(calls[2]!.key).toBe(calls[0]!.key!);
    expect(calls[3]!.key).not.toBe(calls[0]!.key!);
  });

  test('a malformed request for campaign art never reaches Main, and Main\'s media refusals are named', async () => {
    const { addCampaignArt } = await import('../features/showcase-zone-editor/actions.ts');
    reset();
    const ok = { zone, realm, role: 'background-landscape', asset, crop: null, focalArea: null } as const;
    for (const bad of [{ ...ok, zone: 'z' }, { ...ok, realm: 'r' }, { ...ok, asset: 'a' }, { ...ok, role: 'banner' as never }, { ...ok, crop: 'whole' },
      { ...ok, role: 'logo' as const }, { ...ok, role: 'logo' as const, language: 'not a tag!', tone: 'light' as const, anchor: 'center-top' as const },
      { ...ok, role: 'logo' as const, language: 'en', tone: 'grey' as never, anchor: 'center-top' as const }]) {
      expect(await addCampaignArt(bad)).toMatchObject({ status: 'refused', refusal: 'invalid' });
    }
    expect(calls).toHaveLength(0);
    reset({ data: null, error: { status: 422, value: { code: 'showcase_ratio_mismatch', detail: 'Showcase media does not meet the selected role' } } });
    expect(await addCampaignArt(ok)).toMatchObject({ refusal: 'ratio', detail: 'Showcase media does not meet the selected role' });
    reset({ data: null, error: { status: 403, value: { code: 'authority_denied' } } });
    expect(await addCampaignArt(ok)).toMatchObject({ refusal: 'denied' });
    reset({ data: null, error: { status: 404, value: { code: 'media_unavailable' } } });
    expect(await addCampaignArt(ok)).toMatchObject({ refusal: 'missing' });
    reset({ data: { outcome: 'succeeded', id: null, replayed: false }, error: null });
    expect(await addCampaignArt(ok)).toMatchObject({ refusal: 'unavailable' });
  });
});

void mock.module('next/navigation', () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => '/', useSearchParams: () => new URLSearchParams() }));

describe('the editor on the server', () => {
  const never = async () => { throw new Error('not called while rendering'); };
  const card = (id: number, title: string): ZoneWork => ({ id: work(id), href: workHref(id), title: { value: title, lang: 'en', dir: 'ltr' }, cover: null, kind: 'book', author: null,
    tagline: null, status: null, chapters: null, words: null, updatedAt: null, decision: null });
  async function render(slides: StoredSlide[], realm: string | null = 'https://rezics.com/id/5a1d0000-0000-4000-8000-0000000000aa') {
    const { ZoneShowcaseEditor } = await import('../features/showcase-zone-editor/editor.tsx');
    return renderToStaticMarkup(<ZoneShowcaseEditor zone="5a1d0000-0000-4000-8000-000000000001" realm={realm}
      actingSubject="https://rezics.com/id/01a0e3d1-0000-7000-8000-0000000000aa" locale="en" head="https://rezics.com/id/5a1d0000-0000-4000-8000-0000000000e1"
      stored={{ kind: 'document', document: { ...document(), slides } as never }} registry={{}} works={{ [work(1)]: card(1, 'Hades'), [work(2)]: card(2, 'Krita') }}
      heroTitle="Featured" messages={messages.en} editorMessages={editorMessages.en} pickerMessages={pickerMessages.en}
      save={never as never} addArt={never as never} readWorks={never as never} readLatest={never as never} now={Date.parse('2026-10-05T09:00:00.000Z')} />);
  }

  test('slides are listed in order, the first marked as the one most readers act on', async () => {
    const html = await render([{ id: 'a', work: work(1) }, { id: 'b', work: work(2) }, { id: 'c', href: '/discover', title: 'Contest' }]);
    expect(html).toContain('aria-label="Slides in order"');
    expect(html.indexOf('Hades')).toBeLessThan(html.indexOf('Krita'));
    expect(html.indexOf('Krita')).toBeLessThan(html.indexOf('Contest'));
    expect(html.match(/Most readers act on this slide/g)).toHaveLength(1);
    expect(html).toContain('3 of 6 slides');
    expect(html).toContain('Everything is saved');
    expect(html).toContain('We recommend five or fewer');
  });

  test('an empty showcase says what readers see instead, and a full one cannot take another slide', async () => {
    const empty = await render([]);
    expect(empty).toContain('No slides yet');
    expect(empty).toContain('0 of 6 slides');
    expect(empty).not.toContain('Edit slide');
    const six = await render(['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, href: `/${id}`, title: id }) as StoredSlide));
    expect(six).toContain('6 of 6 slides');
    expect(six).toContain('A showcase holds six slides');
    expect([...six.matchAll(/<button[^>]*disabled[^>]*>(?:<svg.*?<\/svg>)?(Add a Work|Add a link)/g)].map(match => match[1])).toEqual(['Add a Work', 'Add a link']);
  });

  test('a Zone without a Realm says campaign art cannot be added', async () => {
    const html = await render([{ id: 'a', work: work(1) }], null);
    expect(html).toContain('has no default Realm');
  });
});
