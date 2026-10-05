import type { ZoneTitleEffect } from '@rezics/zone-sdk';
import { type UiLocale, uiLocales } from '../../i18n/define.ts';
import { droppedOn, moved } from '../saved-filter/tabs.ts';
import { type LogoAnchor, logoKey, logoSlot, type LogoTone, type SlotKey } from '../showcase-editor/art.ts';
import { presetTokens } from '../zones/presentation.ts';

// A Zone's showcase as the editor holds it: the slides of a `zone-presentation-v2` document and the
// one title effect, arranged for editing. Everything else in the stored document (modules,
// navigation, the other tokens, an official theme) is kept as Main returned it. Main decides what
// is valid; the checks here only tell a person early what Main would refuse, and are never looser.

/** Main admits at most this many slides; the editor recommends fewer. */
export const MAX_SLIDES = 6;
export const RECOMMENDED_SLIDES = 5;
/** The stage draws at most this many live slides (`Showcase`); a sixth waits for an earlier one's schedule to end. */
export const STAGE_SLIDES = 5;
export const TEXT_LIMIT = 120;
export const LINK_LIMIT = 256;

export const titleEffects = ['plain', 'outline', 'gradient', 'glow'] as const satisfies readonly ZoneTitleEffect[];

export type Translations = Partial<Record<UiLocale, string>>;

/** A campaign image a slide uses: a Use of the Zone's Realm, as `POST /v1/zones/{id}/campaign-art` created it. */
export interface CampaignRef { use: string; alt?: string; focalArea?: string; anchor?: LogoAnchor }
/** A slide's own art by role, or by language and tone for logos: the keys the Work's art editor uses. */
export type SlideArt = Partial<Record<SlotKey, CampaignRef>>;

export type SlideTarget = { kind: 'work'; work: string } | { kind: 'link'; href: string };

/** One slide as it is edited. `key` is local and stable while slides move; `id` is the slide's identity in the document. */
export interface SlideDraft {
  key: string;
  id: string;
  target: SlideTarget;
  kicker: string;
  kickers: Translations;
  title: string;
  titles: Translations;
  startsAt: string | null;
  endsAt: string | null;
  art: SlideArt;
}

// ---- Main's stored shapes (services/main/src/modules/zone/presentation-format.ts) ----

export interface StoredImage { use: string; alt?: string; focalArea?: string }
export interface StoredLogo extends StoredImage { language: string; tone: LogoTone; anchor: LogoAnchor }
export interface StoredArt { landscape?: StoredImage; portrait?: StoredImage; cutout?: StoredImage; logos?: StoredLogo[] }
export type StoredSlide = {
  id: string; kicker?: string; kickers?: Translations; title?: string; titles?: Translations;
  startsAt?: string; endsAt?: string; art?: StoredArt;
} & ({ work: string; href?: never } | { href: string; work?: never });

/** The presentation document with only the parts the editor reads typed; the rest is carried through untouched. */
export type PresentationDocument = Record<string, unknown> & {
  slides: StoredSlide[];
  tokens: Record<string, unknown> & { titleEffect: ZoneTitleEffect };
  modules: { id: string; type: string }[];
};

/** How a Zone keeps its presentation: a document the editor changes, an external reference it cannot, or none yet. */
export type StoredPresentation =
  | { kind: 'document'; document: PresentationDocument }
  | { kind: 'reference' }
  | { kind: 'none' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The presentation in a Zone configuration as Main's read returned it; Main has already adapted a v1 document to v2. */
export function readStoredPresentation(configuration: unknown): StoredPresentation {
  const presentation = isRecord(configuration) ? configuration.presentation : undefined;
  if (typeof presentation === 'string') return { kind: 'reference' };
  if (!isRecord(presentation) || presentation.profile !== 'zone-presentation-v2' || !Array.isArray(presentation.slides)
    || !isRecord(presentation.tokens) || !Array.isArray(presentation.modules)) return { kind: 'none' };
  const effect = presentation.tokens.titleEffect;
  return { kind: 'document', document: { ...presentation, slides: presentation.slides as StoredSlide[],
    modules: presentation.modules as PresentationDocument['modules'],
    tokens: { ...presentation.tokens, titleEffect: titleEffects.find(item => item === effect) ?? 'plain' } } };
}

/** What a Zone with no presentation document saves slides into: Main's `clean` preset, which the Zone already renders. */
export function emptyDocument(): PresentationDocument {
  return { profile: 'zone-presentation-v2', preset: 'clean', tokens: { ...presetTokens.clean }, navigation: [], modules: [], slides: [] };
}

export const documentOf = (stored: StoredPresentation): PresentationDocument => stored.kind === 'document' ? stored.document : emptyDocument();

// ---- Slides ----

const translationsOf = (value: Translations | undefined): Translations =>
  Object.fromEntries(uiLocales.flatMap(locale => value?.[locale] ? [[locale, value[locale]]] : []));

/** The art slots a slide's stored art fills. */
export function slideArtOf(art: StoredArt | undefined): SlideArt {
  const slots: SlideArt = {};
  const take = (slot: SlotKey, image: StoredImage | undefined, extra: Partial<CampaignRef> = {}) => {
    if (image?.use) slots[slot] = { use: image.use, ...(image.alt ? { alt: image.alt } : {}),
      ...(image.focalArea ? { focalArea: image.focalArea } : {}), ...extra };
  };
  take('background-landscape', art?.landscape);
  take('background-portrait', art?.portrait);
  take('cutout', art?.cutout);
  for (const logo of art?.logos ?? []) take(logoSlot(logo.language, logo.tone), logo, { anchor: logo.anchor });
  return slots;
}

/** Stored art from the slots; absent when the slide has none, so the Work's art serves. */
export function storedArtOf(slots: SlideArt): StoredArt | undefined {
  const image = (slot: SlotKey): StoredImage | undefined => {
    const ref = slots[slot];
    return ref ? { use: ref.use, ...(ref.alt ? { alt: ref.alt } : {}), ...(ref.focalArea ? { focalArea: ref.focalArea } : {}) } : undefined;
  };
  const logos = (Object.keys(slots) as SlotKey[]).flatMap((slot): StoredLogo[] => {
    const key = logoKey(slot);
    const ref = slots[slot];
    return key && ref ? [{ ...image(slot)!, language: key.language, tone: key.tone, anchor: ref.anchor ?? 'start-bottom' }] : [];
  }).sort((a, b) => `${a.language}:${a.tone}`.localeCompare(`${b.language}:${b.tone}`));
  const art: StoredArt = { ...image('background-landscape') ? { landscape: image('background-landscape')! } : {},
    ...image('background-portrait') ? { portrait: image('background-portrait')! } : {},
    ...image('cutout') ? { cutout: image('cutout')! } : {}, ...logos.length ? { logos } : {} };
  return Object.keys(art).length ? art : undefined;
}

let serial = 0;
export const newKey = () => `slide-draft-${++serial}-${Math.random().toString(36).slice(2, 8)}`;

/** A fresh slide id: a slug no other slide of the document uses. */
export function newSlideId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (;;) {
    const id = `slide-${Math.random().toString(36).slice(2, 8)}`;
    if (!used.has(id) && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) return id;
  }
}

export function draftOf(slide: StoredSlide, key: string = newKey()): SlideDraft {
  return { key, id: slide.id, target: slide.work !== undefined ? { kind: 'work', work: slide.work } : { kind: 'link', href: slide.href! },
    kicker: slide.kicker ?? '', kickers: translationsOf(slide.kickers), title: slide.title ?? '', titles: translationsOf(slide.titles),
    startsAt: slide.startsAt ?? null, endsAt: slide.endsAt ?? null, art: slideArtOf(slide.art) };
}

export function blankSlide(taken: Iterable<string>, target: SlideTarget): SlideDraft {
  return { key: newKey(), id: newSlideId(taken), target, kicker: '', kickers: {}, title: '', titles: {}, startsAt: null, endsAt: null, art: {} };
}

const trimmed = (translations: Translations): Translations =>
  Object.fromEntries(uiLocales.flatMap(locale => translations[locale]?.trim() ? [[locale, translations[locale]!.trim()]] : []));

/** The slide as Main stores it: empty text and an unset schedule are left out. */
export function storedSlideOf(slide: SlideDraft): StoredSlide {
  const kickers = trimmed(slide.kickers);
  const titles = trimmed(slide.titles);
  const art = storedArtOf(slide.art);
  const text = { ...slide.kicker.trim() ? { kicker: slide.kicker.trim() } : {}, ...Object.keys(kickers).length ? { kickers } : {},
    ...slide.title.trim() ? { title: slide.title.trim() } : {}, ...Object.keys(titles).length ? { titles } : {},
    ...slide.startsAt ? { startsAt: slide.startsAt } : {}, ...slide.endsAt ? { endsAt: slide.endsAt } : {}, ...art ? { art } : {} };
  return slide.target.kind === 'work' ? { id: slide.id, work: slide.target.work, ...text } : { id: slide.id, href: slide.target.href.trim(), ...text };
}

/** The document to save: the stored one with these slides and title effect, and a showcase module to show them in. */
export function documentFor(base: PresentationDocument, slides: readonly SlideDraft[], effect: ZoneTitleEffect,
  hero: { title: string }): PresentationDocument {
  const next: PresentationDocument = { ...base, slides: slides.map(storedSlideOf), tokens: { ...base.tokens, titleEffect: effect } };
  if (slides.length && !next.modules.some(module => module.type === 'hero-carousel')) {
    const ids = new Set(next.modules.map(module => module.id));
    const id = ['picks', 'showcase'].find(candidate => !ids.has(candidate)) ?? newSlideId(ids);
    next.modules = [{ id, type: 'hero-carousel', title: hero.title, source: { kind: 'query-block', block: 'new-adoptions' } } as PresentationDocument['modules'][number],
      ...next.modules];
  }
  return next;
}

/** Whether saving would add a showcase module because the Zone's layout has none (so its slides would never show). */
export const needsShowcaseModule = (base: PresentationDocument, slides: readonly SlideDraft[]) =>
  slides.length > 0 && !base.modules.some(module => module.type === 'hero-carousel');

// ---- Order ----

export const moveSlide = (slides: readonly SlideDraft[], key: string, offset: number): SlideDraft[] => {
  const order = moved(slides.map(slide => slide.key), key, offset);
  return order.map(item => slides.find(slide => slide.key === item)!);
};

export const dropSlide = (slides: readonly SlideDraft[], key: string, target: string): SlideDraft[] => {
  const order = droppedOn(slides.map(slide => slide.key), key, target);
  return order.map(item => slides.find(slide => slide.key === item)!);
};

// ---- Checks Main would also make ----

export type SlideProblem =
  | { kind: 'no-work' }
  | { kind: 'link'; reason: 'empty' | 'form' }
  | { kind: 'long'; field: 'kicker' | 'title'; language: UiLocale | null }
  | { kind: 'schedule'; reason: 'invalid' | 'empty' };

/** A link names a page on this site: one slash, no spaces, at most 256 characters (Main's `link`). */
export const linkProblem = (href: string): 'empty' | 'form' | null => {
  const text = href.trim();
  if (!text) return 'empty';
  return /^\/(?!\/)[^\s]{0,255}$/.test(text) ? null : 'form';
};

export function slideProblems(slide: SlideDraft): SlideProblem[] {
  const problems: SlideProblem[] = [];
  if (slide.target.kind === 'work') {
    if (!slide.target.work) problems.push({ kind: 'no-work' });
  } else {
    const reason = linkProblem(slide.target.href);
    if (reason) problems.push({ kind: 'link', reason });
  }
  const long = (text: string) => [...text.trim()].length > TEXT_LIMIT;
  if (long(slide.kicker)) problems.push({ kind: 'long', field: 'kicker', language: null });
  if (long(slide.title)) problems.push({ kind: 'long', field: 'title', language: null });
  for (const locale of uiLocales) {
    if (long(slide.kickers[locale] ?? '')) problems.push({ kind: 'long', field: 'kicker', language: locale });
    if (long(slide.titles[locale] ?? '')) problems.push({ kind: 'long', field: 'title', language: locale });
  }
  const start = slide.startsAt ? Date.parse(slide.startsAt) : null;
  const end = slide.endsAt ? Date.parse(slide.endsAt) : null;
  if ((start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end))) problems.push({ kind: 'schedule', reason: 'invalid' });
  else if (start !== null && end !== null && start >= end) problems.push({ kind: 'schedule', reason: 'empty' });
  return problems;
}

// ---- Schedule ----

const two = (value: number) => String(value).padStart(2, '0');

/** An exact UTC timestamp as the `datetime-local` value of the person's own clock. */
export function localInput(iso: string | null): string {
  const date = iso ? new Date(iso) : null;
  if (!date || !Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** A `datetime-local` value as the exact UTC timestamp Main stores: null when empty, `invalid` when it is not a time. */
export function utcFromInput(text: string): string | null | 'invalid' {
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!match) return 'invalid';
  const [, year, month, day, hour, minute] = match.map(Number) as [number, number, number, number, number, number];
  const date = new Date(year, month - 1, day, hour, minute);
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'invalid';
}

export type ScheduleState = 'always' | 'upcoming' | 'live' | 'ended';

/** Whether the schedule shows the slide at `now` (the readers' rule: from the start, until the end). */
export function scheduleState(slide: Pick<SlideDraft, 'startsAt' | 'endsAt'>, now: number): ScheduleState {
  if (!slide.startsAt && !slide.endsAt) return 'always';
  if (slide.startsAt && Date.parse(slide.startsAt) > now) return 'upcoming';
  if (slide.endsAt && now >= Date.parse(slide.endsAt)) return 'ended';
  return 'live';
}

// ---- Changes ----

/** The slides as a comparable string: two arrangements are the same change when they save to the same document. */
export const fingerprint = (slides: readonly SlideDraft[], effect: ZoneTitleEffect) => JSON.stringify([slides.map(storedSlideOf), effect]);
