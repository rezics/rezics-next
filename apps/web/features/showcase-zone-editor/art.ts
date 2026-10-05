import { direction } from '@rezics/main/language';
import type { ZoneShowcaseSlide, ZoneText, ZoneWork } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import type { ShowcaseImage, WorkShowcase } from '../api/showcase.ts';
import type { ZonePresentationRead } from '../realm/types.ts';
import {
  type Drafts, type Framed, previewArt, type SavedArt, type SavedImage, savedArt, type SlotKey,
} from '../showcase-editor/art.ts';
import { slideArt } from '../showcase/stage.ts';
import type { SlideArt, SlideDraft } from './slides.ts';

// A slide's campaign art as the editor shows it. Main's presentation read returns each slide's art
// as delivered images; the Work art editor already turns such images into editable state and into
// the art the real stage draws, so a campaign image is mapped onto the same shape and goes through
// the same functions. Pure, so the tests and stories use it without a browser.

type CampaignMedia = ZonePresentationRead['slideMedia'][number]['art'];
type CampaignImage = NonNullable<CampaignMedia['landscape']>;
type CampaignLogo = CampaignMedia['logos'][number];

/** Every campaign image Main delivers, by the Use it is (an IRI), as the editor holds a saved image. */
export type Registry = Record<string, SavedImage>;

const asShowcaseImage = (role: ShowcaseImage['role'], image: CampaignImage, extra: Partial<ShowcaseImage> = {}): ShowcaseImage =>
  ({ role, selection: image.use, asset: image.use, use: image.use, representation: image.use, context: '', url: image.url,
    mediaType: image.mediaType, width: image.width, height: image.height, cropWidth: image.cropWidth, cropHeight: image.cropHeight,
    crop: image.crop ?? 'xywh=percent:0,0,100,100', focalArea: image.focalArea ?? null, srcset: image.srcset, ...extra }) as ShowcaseImage;

/** The campaign images of Main's presentation read, keyed by Use. */
/** `actingSubject` names the Agent whose session fetches the images through the BFF; Main refuses a signed-in read without one. */
export function registryOf(slideMedia: ZonePresentationRead['slideMedia'], actingSubject: string | null = null): Registry {
  const registry: Registry = {};
  for (const { art } of slideMedia) {
    const images: ShowcaseImage[] = [
      ...art.landscape ? [asShowcaseImage('background-landscape', art.landscape)] : [],
      ...art.portrait ? [asShowcaseImage('background-portrait', art.portrait)] : [],
      ...art.cutout ? [asShowcaseImage('cutout', art.cutout)] : [],
      ...art.logos.map((logo: CampaignLogo) => asShowcaseImage('logo', logo, { language: logo.language, tone: logo.tone, anchor: logo.anchor })),
    ];
    const item: WorkShowcase = { reference: '', status: 'available', images, trailer: null } as unknown as WorkShowcase;
    for (const image of Object.values(savedArt(item, actingSubject).images)) if (image) registry[image.selection] = image;
  }
  return registry;
}

/** The art slots of a slide that Main can deliver now, as the editor's saved art. */
export function savedArtOf(art: SlideArt, registry: Registry): SavedArt {
  const images: SavedArt['images'] = {};
  for (const slot of Object.keys(art) as SlotKey[]) {
    const image = registry[art[slot]!.use];
    if (image) images[slot] = { ...image, slot, anchor: art[slot]!.anchor ?? image.anchor };
  }
  return { images, trailer: null };
}

/** The slots a slide's art names that nothing can be shown for: not delivered yet, or hidden since. */
export const missingSlots = (art: SlideArt, registry: Registry) =>
  (Object.keys(art) as SlotKey[]).filter(slot => !registry[art[slot]!.use]);

/** Which art a slide shows, as the stage decides: its own, the Work's, the cover composed into a slide, or none. */
export type ArtSource = 'campaign' | 'work' | 'cover' | 'none';

export function artSourceOf(slide: ZoneShowcaseSlide): ArtSource {
  const art = slideArt(slide);
  if (art?.landscape || art?.portrait) return art === slide.art ? 'campaign' : 'work';
  return slide.work ? 'cover' : 'none';
}

const text = (value: string, lang: string): ZoneText => ({ value, lang, dir: direction(lang, value) });

/** A slide's text in the reader's language: its translation, else its default, else nothing. */
export const slideText = (translations: Partial<Record<UiLocale, string>>, fallback: string, reader: UiLocale) =>
  translations[reader]?.trim() || fallback.trim();

export interface PreviewInput {
  slides: readonly SlideDraft[];
  /** The Works the slides name, by IRI; absent while loading, and null when Main cannot show the Work to readers. */
  works: Readonly<Record<string, ZoneWork | null | undefined>>;
  registry: Registry;
  /** Unsaved images, by slide. */
  drafts: Readonly<Record<string, Drafts>>;
  framed: Framed;
  reader: UiLocale;
}

/** The slides the stage draws for these edits: the Zone's reader view, minus schedules and the stage's own five-slide limit. */
export function previewSlides(input: PreviewInput): ZoneShowcaseSlide[] {
  return input.slides.flatMap((slide): ZoneShowcaseSlide[] => {
    const work = slide.target.kind === 'work' ? input.works[slide.target.work] : null;
    // Readers see no slide for a Work Main cannot show, and the editor says which one that is.
    if (slide.target.kind === 'work' && !work) return [];
    const kicker = slideText(slide.kickers, slide.kicker, input.reader);
    const title = slideText(slide.titles, slide.title, input.reader);
    const art = previewArt(savedArtOf(slide.art, input.registry), input.drafts[slide.key] ?? {}, input.framed);
    return [{ id: slide.id, href: work ? work.href : slide.target.kind === 'link' ? slide.target.href : '#',
      work: work ?? null, title: title ? text(title, input.reader) : work?.title ?? text('', input.reader),
      kicker: kicker ? text(kicker, input.reader) : null, tagline: work?.tagline ?? null, art }];
  });
}
