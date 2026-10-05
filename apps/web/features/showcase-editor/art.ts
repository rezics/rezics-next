import { parseLanguage } from '@rezics/main/language';
import type { ZoneShowcaseArt, ZoneShowcaseImage, ZoneShowcaseLogo, ZoneShowcaseSlide, ZoneText, ZoneWork } from '@rezics/zone-sdk';
import { BFF_PREFIX } from '../api/browser.ts';
import type { ShowcaseImage, WorkShowcase } from '../api/showcase.ts';
import { logoFor } from '../showcase/stage.ts';
import { focalWithin, type PixelRect, pixelArea, type Size } from './frame.ts';

// The Work's showcase art as the editor holds it: what Main has selected, the changes a person has
// made and not yet saved, and the art the real showcase stage draws from both. Pure, so the tests
// and stories use it without a browser.

export type LogoTone = 'dark' | 'light';
export const logoTones = ['light', 'dark'] as const satisfies readonly LogoTone[];
export const logoAnchors = ['start-bottom', 'center-top', 'center-middle', 'center-bottom'] as const;
export type LogoAnchor = (typeof logoAnchors)[number];
/** The language key of a logo without words (BCP 47 "no linguistic content"). */
export const NEUTRAL_LANGUAGE = 'zxx';

/** One selection of the Work's showcase: a role, or a logo's language and tone. */
export type SlotKey = 'background-landscape' | 'background-portrait' | 'cutout' | `logo:${string}:${LogoTone}`;
export const logoSlot = (language: string, tone: LogoTone): SlotKey => `logo:${language}:${tone}`;
export function logoKey(slot: SlotKey): { language: string; tone: LogoTone } | null {
  const [kind, language, tone] = slot.split(':');
  return kind === 'logo' && language && (tone === 'dark' || tone === 'light') ? { language, tone } : null;
}

/** A language tag in the canonical form Main keys logos by (`zh-hant` becomes `zh-Hant`); null when it is not one. */
export function canonicalTag(value: string): string | null {
  const text = value.trim();
  return text && text.length <= 35 ? parseLanguage(text)?.tag ?? null : null;
}

/** A selected image as Main read it, with the frame and focal area in pixels of its oriented original. */
export interface SavedImage {
  slot: SlotKey;
  selection: string;
  asset: string;
  /** The oriented original, through the BFF; renditions already carry the frame. */
  url: string;
  size: Size;
  frame: PixelRect;
  focal: PixelRect | null;
  anchor: LogoAnchor | null;
  candidates: { url: string; width: number }[];
}
export interface SavedArt {
  images: Partial<Record<SlotKey, SavedImage>>;
  trailer: { selection: string; url: string; provider: 'youtube' | 'bilibili' | 'link' } | null;
}

/** Main's media path through the BFF, which sends the session's token; Main then needs the Agent the editor acts as. */
function throughBff(url: string, actingSubject: string | null) {
  if (!url.startsWith('/v1/')) return url;
  const path = new URL(url, 'https://rezics.invalid');
  if (actingSubject) path.searchParams.set('actingSubject', actingSubject);
  return `${BFF_PREFIX}${path.pathname}${path.search}`;
}

function slotOf(image: ShowcaseImage): SlotKey | null {
  if (image.role !== 'logo') return image.role;
  return image.language && image.tone ? logoSlot(image.language, image.tone) : null;
}

/** Main's batch read of one Work as editor state; nothing selected when Main could not read it. */
export function savedArt(item: WorkShowcase | null, actingSubject: string | null = null): SavedArt {
  const images: SavedArt['images'] = {};
  for (const image of item?.images ?? []) {
    const slot = slotOf(image);
    const size = { width: image.width, height: image.height };
    const frame = pixelArea(image.crop, size);
    if (!slot || !frame) continue;
    // Width candidates name their codec; one srcset cannot repeat a width for two codecs.
    const codec = image.srcset.some(candidate => candidate.type === 'image/webp') ? 'image/webp' : 'image/avif';
    images[slot] = { slot, selection: image.selection, asset: image.asset, url: throughBff(image.url, actingSubject), size, frame,
      focal: image.focalArea ? pixelArea(image.focalArea, size) : null, anchor: image.anchor ?? null,
      candidates: image.srcset.filter(candidate => candidate.type === codec)
        .map(candidate => ({ url: throughBff(candidate.url, actingSubject), width: candidate.width })) };
  }
  return { images, trailer: item?.trailer ? { selection: item.trailer.selection, url: item.trailer.url,
    provider: item.trailer.provider } : null };
}

/** An image a person has chosen or re-framed and not yet saved. */
export interface ImageDraft {
  kind: 'image';
  /** The selection this change was started from: Main refuses the save if the slot has moved since. */
  base: string | null;
  /** A new file to upload, or the saved asset when only its frame, focal area or anchor changes. */
  source: { url: string; size: Size; file: File | null; asset: string | null };
  /** Backgrounds only; logos and cutouts are used whole. */
  frame: PixelRect | null;
  focal: PixelRect | null;
  anchor: LogoAnchor | null;
  /** The author calls a new file adult content; unmarked, the check on their device decides. */
  adult?: boolean;
  /** The frame drawn at preview size, for the stage, which cannot crop; `key` names the source and frame it shows. */
  framed: { url: string; size: Size; key: string } | null;
  /** Retrying an upload replays the same reservation. */
  uploadKey: string | null;
  /** The selection Main recorded for this change; the draft gives way once the page reads it. */
  savedAs?: string;
}
export interface RemovalDraft { kind: 'remove'; base: string | null; savedAs?: string }
export type Draft = ImageDraft | RemovalDraft;
export type Drafts = Partial<Record<SlotKey, Draft>>;

/** A saved image's frame drawn for the stage when Main has no width renditions yet. */
export type Framed = Partial<Record<string, { url: string; size: Size }>>;

function backgroundImage(saved: SavedImage | undefined, draft: Draft | undefined, framed: Framed): ZoneShowcaseImage | null {
  if (draft?.kind === 'remove') return null;
  if (draft?.kind === 'image' && draft.frame) {
    const focal = draft.focal ? { focal: focalWithin(draft.focal, draft.frame) } : {};
    if (draft.framed) return { url: draft.framed.url, ...draft.framed.size, framed: true, ...focal };
    // Until the new frame is drawn, a re-framed selection shows as saved; a new file shows nothing yet.
    if (draft.source.file || !saved) return null;
  }
  if (!saved) return null;
  const local = framed[saved.selection];
  const focal = saved.focal ? { focal: focalWithin(saved.focal, saved.frame) } : {};
  if (!saved.candidates.length) return local ? { url: local.url, ...local.size, framed: true, ...focal } : null;
  return { url: saved.candidates.at(-1)!.url, width: saved.frame.width, height: saved.frame.height, framed: true,
    candidates: saved.candidates, ...focal };
}

function layerImage(saved: SavedImage | undefined, draft: Draft | undefined): (ZoneShowcaseImage & { anchor: LogoAnchor | null }) | null {
  if (draft?.kind === 'remove') return null;
  if (draft?.kind === 'image') return { url: draft.source.url, ...draft.source.size, framed: true, anchor: draft.anchor };
  if (!saved) return null;
  return { url: saved.candidates.at(-1)?.url ?? saved.url, width: saved.frame.width, height: saved.frame.height, framed: true,
    anchor: saved.anchor, ...(saved.candidates.length ? { candidates: saved.candidates } : {}) };
}

/** Every slot that holds or will hold something: saved slots and slots with a draft. */
export const slotsOf = (saved: SavedArt, drafts: Drafts) =>
  [...new Set([...Object.keys(saved.images), ...Object.keys(drafts)])] as SlotKey[];

/** The art the stage draws: each slot's unsaved change where there is one, Main's selection otherwise. */
export function previewArt(saved: SavedArt, drafts: Drafts, framed: Framed = {}): ZoneShowcaseArt {
  const logos: ZoneShowcaseLogo[] = [];
  for (const slot of slotsOf(saved, drafts)) {
    const key = logoKey(slot);
    if (!key) continue;
    const image = layerImage(saved.images[slot], drafts[slot]);
    if (image) logos.push({ ...image, anchor: image.anchor ?? 'start-bottom', tone: key.tone,
      language: key.language === NEUTRAL_LANGUAGE ? '' : key.language });
  }
  const cutout = layerImage(saved.images.cutout, drafts.cutout);
  return {
    landscape: backgroundImage(saved.images['background-landscape'], drafts['background-landscape'], framed),
    portrait: backgroundImage(saved.images['background-portrait'], drafts['background-portrait'], framed),
    cutout: cutout ? { url: cutout.url, width: cutout.width, height: cutout.height, framed: true,
      ...(cutout.candidates ? { candidates: cutout.candidates } : {}) } : null,
    logos,
  };
}

/**
 * Which logo the stage draws for a title in each language, or none (the styled live title). The
 * stage looks for a light logo, since its scrim is dark: a dark one alone is kept but not drawn.
 */
export function logoCoverage(art: ZoneShowcaseArt, languages: readonly string[]) {
  return languages.map(language => {
    const logo = logoFor(art, language);
    const dark = logoFor(art, language, 'dark');
    return { language, logo, darkOnly: !logo && Boolean(dark) };
  });
}

/** The two slides beside the Work's, so the preview shows the next card peeking and the wide stage's list. */
export function previewSlides(input: { work: ZoneWork; title: ZoneText; tagline: ZoneText | null; art: ZoneShowcaseArt;
  trailer: string | null; neighbours: readonly [ZoneText, ZoneText] }): ZoneShowcaseSlide[] {
  const work = { ...input.work, title: input.title, tagline: input.tagline, showcaseArt: input.art };
  const neighbour = (title: ZoneText, index: number): ZoneShowcaseSlide => ({ id: `preview-neighbour-${index}`, href: '#',
    title, work: { ...input.work, id: `${input.work.id}#neighbour-${index}`, href: '#', title, tagline: null, cover: null,
      decision: null, showcaseArt: null } });
  return [{ id: 'preview-work', href: work.href, title: input.title, tagline: input.tagline, work,
    trailer: input.trailer ? { href: input.trailer } : null }, ...input.neighbours.map(neighbour)];
}
