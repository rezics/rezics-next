import { direction } from '@rezics/main/language';
import type { ZoneShowcaseArt, ZoneText, ZoneWork } from '@rezics/zone-sdk';
import type { ZonePresentationRead } from '../realm/types.ts';
import { resourceHref } from '../address/path.ts';
import { drawnFile } from '../showcase-editor/fixtures.ts';
import cutoutUrl from '../showcase/art/cutout.svg?url&no-inline';
import landscapeUrl from '../showcase/art/landscape.svg?url&no-inline';
import englishLight from '../showcase/art/logo-en-light.svg?url&no-inline';
import portraitUrl from '../showcase/art/portrait.svg?url&no-inline';
import type { CampaignArtResult, LatestShowcase } from './actions.ts';
import { type Registry, registryOf } from './art.ts';
import type { ConfigurationSave } from './refusal.ts';
import { emptyDocument, type PresentationDocument, type StoredSlide } from './slides.ts';
import type { WorkChoice } from '../work-levels-edit/work-picker.tsx';

// A Zone's showcase as Main returns it, for stories and tests: the Zone, its Realm, the Works the
// slides name and the campaign art delivered for them. The art is the showcase feature's own
// fixture SVGs, described at the sizes a real upload would have.

export { drawnFile };
const text = (value: string, lang = 'en'): ZoneText => ({ value, lang, dir: direction(lang, value) });
let serial = 0;
const uuid = () => `01a0e3d1-0000-7000-8000-${String(++serial).padStart(12, '0')}`;
const iri = (id: string) => `https://rezics.com/id/${id}`;

export const zone = '5a1d0000-0000-4000-8000-000000000001';
export const realm = iri('5a1d0000-0000-4000-8000-0000000000aa');
export const actingSubject = iri('01a0e3d1-0000-7000-8000-0000000000aa');
export const revision = iri('5a1d0000-0000-4000-8000-0000000000e1');
export const nextRevision = iri('5a1d0000-0000-4000-8000-0000000000e2');

const card = (id: string, title: string, kind: ZoneWork['kind'], tagline: string, art: ZoneShowcaseArt | null = null): ZoneWork =>
  ({ id: iri(id), href: resourceHref('/w/', id), title: text(title), cover: null, kind, author: null, tagline: text(tagline), status: null,
    chapters: null, words: null, updatedAt: null, decision: '#why-here', showcaseArt: art });
const ownArt: ZoneShowcaseArt = { landscape: { url: landscapeUrl, width: 1920, height: 1080, framed: true },
  portrait: { url: portraitUrl, width: 1500, height: 2000, framed: true }, cutout: { url: cutoutUrl, width: 420, height: 700, framed: true },
  logos: [{ url: englishLight, width: 600, height: 200, framed: true, tone: 'light', anchor: 'start-bottom', language: 'en' }] };

export const hades = '01a0e3d1-0000-7000-8000-000000000011';
export const krita = '01a0e3d1-0000-7000-8000-000000000012';
export const pride = '01a0e3d1-0000-7000-8000-000000000013';
export const tide = '01a0e3d1-0000-7000-8000-000000000014';
export const lost = '01a0e3d1-0000-7000-8000-000000000015';

/** The Works as the stage draws them: Hades has art of its own, the others are built from their covers. */
export const works: Record<string, ZoneWork | null> = {
  [iri(hades)]: card(hades, 'Hades', 'game', 'Fight your way out of the underworld.', ownArt),
  [iri(krita)]: card(krita, 'Krita', 'package', 'A free painting program for artists.'),
  [iri(pride)]: card(pride, 'Pride and Prejudice', 'book', 'First impressions begin to unravel.'),
  [iri(tide)]: card(tide, 'Astral Tide', 'book', 'A lighthouse between worlds.'),
  [iri(lost)]: null,
};
export const choices: WorkChoice[] = [
  { id: tide, title: 'Astral Tide', language: 'en' }, { id: pride, title: 'Pride and Prejudice', language: 'en' },
  { id: hades, title: 'Hades', language: 'en' },
];
export const loadWorks = async (prefix: string) => choices.filter(choice => choice.title.toLowerCase().includes(prefix.toLowerCase()));

const campaignUse = iri('01a0e3d1-0000-7000-8000-0000000000c1');
const logoUse = iri('01a0e3d1-0000-7000-8000-0000000000c2');
type Media = ZonePresentationRead['slideMedia'];
const image = (use: string, url: string, width: number, height: number, extra: Record<string, unknown> = {}) =>
  ({ use, crop: 'xywh=percent:0,0,100,100', cropWidth: width, cropHeight: height, url, width, height, mediaType: 'image/svg+xml',
    srcset: [{ url, width, height, type: 'image/webp' as const }], ...extra });
/** What Main delivers for the contest slide's campaign art. */
export const slideMedia = [{ id: 'autumn-contest', art: { landscape: image(campaignUse, landscapeUrl, 1920, 1080, { focalArea: 'xywh=percent:60,22,20,46' }),
  portrait: null, cutout: null,
  logos: [{ ...image(logoUse, englishLight, 600, 200), language: 'en', tone: 'light' as const, anchor: 'start-bottom' as const }] } }] as unknown as Media;
export const registry: Registry = registryOf(slideMedia);

const slide = (id: string, extra: Partial<StoredSlide> & ({ work: string } | { href: string })): StoredSlide => ({ id, ...extra }) as StoredSlide;

/** The Zone's document by case: no slides, a full showcase with a link slide and campaign art, or one with schedules. */
export function documentOf(kind: 'empty' | 'full' | 'scheduled' | 'six'): PresentationDocument {
  const base: PresentationDocument = { ...emptyDocument(), preset: 'vibrant', modules: [
    { id: 'picks', type: 'hero-carousel', title: 'Featured', source: { kind: 'query-block', block: 'new-adoptions' } },
    { id: 'recent', type: 'shelf', title: 'Newly picked', source: { kind: 'query-block', block: 'new-adoptions' } }] };
  base.tokens = { ...base.tokens, titleEffect: 'glow' };
  if (kind === 'empty') return base;
  const hadesSlide = slide('hades', { work: iri(hades), kicker: 'Game of the week', kickers: { 'zh-Hant': '本週遊戲', ja: '今週のゲーム' } });
  const contest = slide('autumn-contest', { href: '/discover', kicker: 'Open until October 31', title: 'Autumn serial contest',
    titles: { 'zh-Hant': '秋季連載徵文', ja: '秋の連載コンテスト' }, art: { landscape: { use: campaignUse },
      logos: [{ use: logoUse, language: 'en', tone: 'light', anchor: 'start-bottom' }] } });
  if (kind === 'scheduled') return { ...base, slides: [hadesSlide, slide('season', { work: iri(krita), startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2030-01-01T00:00:00.000Z' }),
    slide('later', { work: iri(pride), startsAt: '2030-02-01T00:00:00.000Z' }), contest] };
  const slides = [hadesSlide, slide('krita', { work: iri(krita) }), contest, slide('pride', { work: iri(pride) }), slide('tide', { work: iri(tide) })];
  return { ...base, slides: kind === 'six' ? [...slides, slide('lost', { work: iri(lost) })] : slides };
}

/** Stand-ins for Main's answers to the editor's reads and writes. */
export const answers = {
  saved: async (): Promise<ConfigurationSave> => ({ status: 'done', revision: nextRevision, replayed: false }),
  refused: (refusal: Extract<ConfigurationSave, { status: 'refused' }>['refusal'], detail: string | null = null) =>
    async (): Promise<ConfigurationSave> => ({ status: 'refused', refusal, code: null, detail }),
  art: async (): Promise<CampaignArtResult> => ({ status: 'done', use: iri(uuid()), replayed: false }),
  artRefused: (refusal: Extract<CampaignArtResult, { status: 'refused' }>['refusal'], detail: string | null = null) =>
    async (): Promise<CampaignArtResult> => ({ status: 'refused', refusal, code: null, detail, current: null }),
  works: async (input: { works: string[] }) => Object.fromEntries(input.works.map(work => [work, works[work] ?? null])),
  /** The Zone as someone else left it: another slide order and a different title effect. */
  latest: (kind: 'empty' | 'full' | 'scheduled' = 'scheduled') => async (): Promise<LatestShowcase> => ({ status: 'read', registry,
    state: { zone, revision: nextRevision, realm, presentation: { kind: 'document', document: { ...documentOf(kind),
      tokens: { ...documentOf(kind).tokens, titleEffect: 'outline' } } } } }),
};
