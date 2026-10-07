import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { languageTagSchema } from '../display-language/schema.ts';
import { canonicalLanguage } from '../display-language/tag.ts';
import { pixelCrop, RENDITION_LIMITS } from '../media-rendition/policy.ts';

export const ZONE_PRESENTATION_V1_PROFILE = 'https://rezics.com/definition/zone-presentation-v1';
export const ZONE_PRESENTATION_PROFILE = 'https://rezics.com/definition/zone-presentation-v2';
const id = Type.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const slug = Type.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 });
const label = Type.String({ minLength: 1, maxLength: 120 });
const link = Type.String({ pattern: '^/(?!/)[^\\s]{0,255}$' });
const colour = Type.String({ pattern: '^#[0-9a-fA-F]{6}$' });
export const ZONE_PUBLIC_READ_SOURCES = [
  'new-adoptions', 'latest-chapters', 'recently-completed', 'recent-decisions',
  'rankings', 'rising', 'reader-quotes', 'discussions',
] as const;
const publicReadSources = new Set<string>(ZONE_PUBLIC_READ_SOURCES);
const localizedTitles = Type.Partial(Type.Object({ en: label, 'zh-Hant': label,
  'zh-Hans': label, ja: label, ko: label, de: label, fr: label, es: label },
{ additionalProperties: false }), { additionalProperties: false });

const moduleSource = Type.Union([
  Type.Object({ kind: Type.Literal('query-block'), block: slug }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('collection'), collection: id }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('context'), context: id }, { additionalProperties: false }),
]);
/** A tab's `label` is its default; `labels` gives it in the reader's language, as `titles` does for a module. */
const moduleTab = Type.Object({ id: slug, label, labels: Type.Optional(localizedTitles), source: moduleSource },
  { additionalProperties: false });

export const ZonePresentationV1 = Type.Object({
  profile: Type.Literal('zone-presentation-v1'),
  preset: Type.Union([Type.Literal('clean'), Type.Literal('editorial'),
    Type.Literal('vibrant'), Type.Literal('serial')]),
  tokens: Type.Object({
    colorScheme: Type.Union([Type.Literal('system'), Type.Literal('light'), Type.Literal('dark')]),
    accent: colour,
    density: Type.Union([Type.Literal('compact'), Type.Literal('comfortable')]),
    cardRadius: Type.Union([Type.Literal('sm'), Type.Literal('md'), Type.Literal('lg')]),
    headingFontScale: Type.Union([Type.Literal('md'), Type.Literal('lg')]),
    surfaceTint: Type.Union([Type.Literal('none'), Type.Literal('subtle'), Type.Literal('accent')]),
    fontPairing: Type.Union([Type.Literal('sans'), Type.Literal('serif'), Type.Literal('rounded')]),
    pageSurface: Type.Union([Type.Literal('flat'), Type.Literal('cards')]),
    coverStyle: Type.Union([Type.Literal('portrait'), Type.Literal('square'), Type.Literal('landscape')]),
  }, { additionalProperties: false }),
  navigation: Type.Array(Type.Object({ label, href: link }, { additionalProperties: false }),
    { maxItems: 12 }),
  banners: Type.Array(Type.Object({ id: slug, title: label,
    alt: Type.String({ maxLength: 180 }), image: id, href: link,
    startsAt: Type.Optional(Type.String({ format: 'date-time' })),
    endsAt: Type.Optional(Type.String({ format: 'date-time' })) },
  { additionalProperties: false }), { maxItems: 6 }),
  modules: Type.Array(Type.Object({
    id: slug,
    // docs/contracts/api.md "Platform exposure": introducing a third-party block
    // representation requires requireSelectedPlatformCapability and a refusal test.
    type: Type.Union([Type.Literal('hero-carousel'), Type.Literal('chip-nav'),
      Type.Literal('announcement'), Type.Literal('shelf'), Type.Literal('ranking'),
      Type.Literal('editorial-list'), Type.Literal('quote-stream'), Type.Literal('people'),
      Type.Literal('rising'), Type.Literal('decision-log'), Type.Literal('discussion-list')]),
    title: label,
    titles: Type.Optional(localizedTitles),
    source: moduleSource,
    tabs: Type.Optional(Type.Array(moduleTab, { maxItems: 8 })),
    options: Type.Optional(Type.Object({
      layout: Type.Optional(Type.Union([Type.Literal('covers'), Type.Literal('rows')])),
      shuffle: Type.Optional(Type.Boolean()),
      rail: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })),
      metric: Type.Optional(Type.Union([Type.Literal('reads'), Type.Literal('finished-chapters')])),
      interval: Type.Optional(Type.Union([Type.Literal('day'), Type.Literal('week'), Type.Literal('month')])),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }), { maxItems: 24 }),
  official: Type.Optional(Type.Object({ theme: Type.Optional(id) }, { additionalProperties: false })),
}, { additionalProperties: false });

const slideTarget = Type.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const campaignImage = Type.Object({ use: slideTarget,
  alt: Type.Optional(Type.String({ maxLength: 180 })),
  focalArea: Type.Optional(Type.String({ maxLength: 80,
    pattern: '^xywh=percent:([0-9]{1,3}(\\.[0-9]{1,3})?,){3}[0-9]{1,3}(\\.[0-9]{1,3})?$' })),
}, { additionalProperties: false });
export const ZoneCampaignArt = Type.Object({
  landscape: Type.Optional(campaignImage), portrait: Type.Optional(campaignImage),
  cutout: Type.Optional(campaignImage),
  logos: Type.Optional(Type.Array(Type.Object({ ...campaignImage.properties,
    language: languageTagSchema(64),
    tone: Type.Union([Type.Literal('dark'), Type.Literal('light')]),
    anchor: Type.Union([Type.Literal('start-bottom'), Type.Literal('center-top'),
      Type.Literal('center-middle'), Type.Literal('center-bottom')]),
  }, { additionalProperties: false }), { maxItems: 32 })),
}, { additionalProperties: false });

const slideFields = {
  id: slug, kicker: Type.Optional(label), kickers: Type.Optional(localizedTitles),
  title: Type.Optional(label), titles: Type.Optional(localizedTitles),
  startsAt: Type.Optional(Type.String({ format: 'date-time' })),
  endsAt: Type.Optional(Type.String({ format: 'date-time' })),
  art: Type.Optional(ZoneCampaignArt),
};
export const ZonePresentation = Type.Object({
  ...Type.Omit(ZonePresentationV1, ['banners']).properties,
  profile: Type.Literal('zone-presentation-v2'),
  tokens: Type.Object({ ...ZonePresentationV1.properties.tokens.properties,
    titleEffect: Type.Union([Type.Literal('plain'), Type.Literal('outline'),
      Type.Literal('gradient'), Type.Literal('glow')]),
  }, { additionalProperties: false }),
  slides: Type.Array(Type.Union([
    Type.Object({ ...slideFields, work: slideTarget }, { additionalProperties: false }),
    Type.Object({ ...slideFields, href: link }, { additionalProperties: false }),
  ]), { maxItems: 6 }),
}, { additionalProperties: false });

export type ZoneCampaignArt = Static<typeof ZoneCampaignArt>;
export type ZoneSlide = Static<typeof ZonePresentation>['slides'][number];

/** One bounded list feeds both publication delivery and rendition candidates. */
export function zoneCampaignImages(art: ZoneCampaignArt | undefined) {
  return art ? [art.landscape, art.portrait, art.cutout, ...(art.logos ?? [])]
    .filter((image): image is NonNullable<typeof image> => !!image) : [];
}

export function zoneCampaignUses(slides: readonly ZoneSlide[]) {
  return [...new Set(slides.flatMap(slide => zoneCampaignImages(slide.art).map(image => image.use.slice(-36))))];
}

/** Historical JSON stays authoritative; adapters return a new v2 value. */
export function readStoredZonePresentation(value: unknown, queryBlocks: readonly { block: string }[]) {
  if (Value.Check(ZonePresentationV1, value)) {
    const { banners, profile: _profile, ...rest } = value;
    return checkZonePresentation({ ...rest, profile: 'zone-presentation-v2',
      tokens: { ...rest.tokens, titleEffect: ZONE_PRESETS[rest.preset].titleEffect },
      slides: banners.map(({ image, alt, ...banner }) => ({ ...banner,
        art: { landscape: { use: image, alt } } })),
    }, queryBlocks);
  }
  return checkZonePresentation(value, queryBlocks);
}

export type ZonePresentation = Static<typeof ZonePresentation>;

export function checkZonePresentation(value: unknown, queryBlocks: readonly { block: string }[])
  : ZonePresentation {
  if (!Value.Check(ZonePresentation, value)) throw new Error('Zone presentation format differs');
  const blockIds = new Set(queryBlocks.map(block => block.block));
  const ids = new Set<string>();
  for (const module of value.modules) {
    if (ids.has(module.id)) throw new Error('duplicate Zone module');
    ids.add(module.id);
    const sources = [module.source, ...(module.tabs ?? []).map(tab => tab.source)];
    const tabs = new Set<string>();
    for (const tab of module.tabs ?? []) {
      if (tabs.has(tab.id)) throw new Error('duplicate Zone module tab');
      tabs.add(tab.id);
    }
    for (const source of sources) {
      if (source.kind === 'query-block' && !blockIds.has(source.block)
        && !publicReadSources.has(source.block)) {
        throw new Error('Zone module refers to a missing query block');
      }
    }
    if (module.type === 'ranking' && (!module.options?.metric || !module.options.interval)) {
      throw new Error('Zone ranking needs a metric and interval');
    }
  }
  const slides = new Set<string>();
  for (const slide of value.slides) {
    if (slides.has(slide.id)) throw new Error('duplicate Zone slide');
    slides.add(slide.id);
    const logos = new Set<string>();
    for (const logo of slide.art?.logos ?? []) {
      const key = `${canonicalLanguage(logo.language)}\0${logo.tone}`;
      if (logos.has(key)) throw new Error('duplicate Zone logo language and tone');
      logos.add(key);
    }
    for (const image of zoneCampaignImages(slide.art)) {
      if (image.focalArea) pixelCrop(image.focalArea, { width: 1000, height: 1000 });
    }
    for (const timestamp of [slide.startsAt, slide.endsAt]) {
      if (timestamp && (!Number.isFinite(Date.parse(timestamp))
        || new Date(timestamp).toISOString() !== timestamp)) {
        throw new Error('Zone slide schedule needs exact UTC timestamps');
      }
    }
    if (slide.startsAt && slide.endsAt && Date.parse(slide.startsAt) >= Date.parse(slide.endsAt)) {
      throw new Error('Zone slide schedule is empty');
    }
  }
  if (zoneCampaignUses(value.slides).length > RENDITION_LIMITS.batch) {
    throw new Error('Zone campaign art exceeds its Use batch bound');
  }
  return value;
}

export const ZONE_PRESETS: Record<ZonePresentation['preset'], ZonePresentation['tokens']> = {
  clean: { colorScheme: 'system', accent: '#2563eb', density: 'comfortable',
    cardRadius: 'md', headingFontScale: 'md', surfaceTint: 'none',
    fontPairing: 'sans', pageSurface: 'flat', coverStyle: 'portrait', titleEffect: 'plain' },
  editorial: { colorScheme: 'light', accent: '#a16207', density: 'comfortable',
    cardRadius: 'sm', headingFontScale: 'lg', surfaceTint: 'subtle',
    fontPairing: 'serif', pageSurface: 'cards', coverStyle: 'portrait', titleEffect: 'outline' },
  vibrant: { colorScheme: 'dark', accent: '#7c3aed', density: 'comfortable',
    cardRadius: 'lg', headingFontScale: 'lg', surfaceTint: 'accent',
    fontPairing: 'rounded', pageSurface: 'cards', coverStyle: 'square', titleEffect: 'glow' },
  serial: { colorScheme: 'light', accent: '#ff8674', density: 'compact',
    cardRadius: 'sm', headingFontScale: 'lg', surfaceTint: 'subtle',
    fontPairing: 'sans', pageSurface: 'cards', coverStyle: 'portrait', titleEffect: 'gradient' },
};

/** Accent text is derived so an editor cannot accidentally select low contrast. */
export function zoneRenderTokens(tokens: ZonePresentation['tokens']) {
  const rgb = [1, 3, 5].map(index => Number.parseInt(tokens.accent.slice(index, index + 2), 16) / 255);
  const luminance = rgb.map(channel => channel <= 0.04045 ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  const light = 0.2126 * luminance[0]! + 0.7152 * luminance[1]! + 0.0722 * luminance[2]!;
  return { ...tokens, textOnAccent: light >= 0.179 ? '#000000' : '#ffffff' };
}

export const DEFAULT_ZONE_PRESENTATION: ZonePresentation = {
  profile: 'zone-presentation-v2', preset: 'clean', tokens: ZONE_PRESETS.clean,
  navigation: [], slides: [], modules: [],
};
