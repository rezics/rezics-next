import { t } from 'elysia';
import { canonicalLanguage } from '../display-language/tag.ts';
import { pixelCrop, type ImageSize, type RenditionCandidate } from '../media-rendition/policy.ts';
import { DEFAULT_MEDIA_CONTEXT, MediaInvalid } from './contract.ts';

export const SHOWCASE_ROLES = [
  'background-landscape',
  'background-portrait',
  'logo',
  'cutout',
] as const;
export const LOGO_ANCHORS = [
  'start-bottom',
  'center-top',
  'center-middle',
  'center-bottom',
] as const;

// Literal tuples, not a mapped array, so typed clients see the exact values
// instead of `never`.
const showcaseRole = t.Union([t.Literal('background-landscape'), t.Literal('background-portrait'),
  t.Literal('logo'), t.Literal('cutout')]);
const logoAnchor = t.Union([t.Literal('start-bottom'), t.Literal('center-top'), t.Literal('center-middle'),
  t.Literal('center-bottom')]);

export type ShowcaseRole = (typeof SHOWCASE_ROLES)[number];
export type LogoAnchor = (typeof LOGO_ANCHORS)[number];
export type LogoTone = 'dark' | 'light';
export type ShowcaseSlot =
  | `showcase-${Exclude<ShowcaseRole, 'logo'>}`
  | `showcase-logo:${string}:${LogoTone}`
  | 'showcase-trailer';
export class ShowcaseRefused extends MediaInvalid {
  constructor(
    readonly code:
      | 'showcase_crop_invalid'
      | 'showcase_ratio_mismatch'
      | 'showcase_resolution_too_small'
      | 'showcase_alpha_required'
      | 'showcase_trailer_invalid',
  ) {
    super(code);
  }
}
export interface ShowcaseSelectionInput {
  target: string;
  context: string;
  expectedSelection: string | null;
  role: ShowcaseRole;
  language?: string;
  tone?: LogoTone;
  anchor?: LogoAnchor;
  asset: string | null;
  crop: string | null;
  focalArea: string | null;
}
export interface ShowcaseTrailerInput {
  target: string;
  context: string;
  expectedSelection: string | null;
  url: string | null;
}
/** Campaign Uses are immutable slide-local bindings, independent of Work slots. */
export type CampaignArtInput = Omit<ShowcaseSelectionInput, 'expectedSelection' | 'asset'> & {
  zone: string;
  asset: string;
};
export interface ShowcaseImage {
  role: ShowcaseRole;
  selection: string;
  asset: string;
  use: string;
  representation: string;
  context: string;
  url: string;
  mediaType: string;
  width: number;
  height: number;
  cropWidth: number;
  cropHeight: number;
  crop: string | null;
  focalArea: string | null;
  language?: string;
  tone?: LogoTone;
  anchor?: LogoAnchor;
  srcset: RenditionCandidate[];
}
export interface ShowcaseArt {
  reference: string;
  status: 'available';
  images: ShowcaseImage[];
  trailer: {
    selection: string;
    context: string;
    url: string;
    provider: 'youtube' | 'bilibili' | 'link';
  } | null;
}

export function showcaseSlot(
  input: Pick<ShowcaseSelectionInput, 'role' | 'language' | 'tone' | 'anchor'>,
): ShowcaseSlot {
  if (!SHOWCASE_ROLES.includes(input.role)) throw new MediaInvalid('invalid showcase role');
  if (input.role !== 'logo') {
    if (input.language !== undefined || input.tone !== undefined || input.anchor !== undefined)
      throw new MediaInvalid('only logos carry language, tone and anchor');
    return `showcase-${input.role}`;
  }
  const language =
    input.language && input.language.length <= 255 ? canonicalLanguage(input.language) : null;
  if (
    !language ||
    !['dark', 'light'].includes(input.tone ?? '') ||
    !LOGO_ANCHORS.includes(input.anchor!)
  )
    throw new MediaInvalid('invalid showcase logo key or anchor');
  return `showcase-logo:${language}:${input.tone!}`;
}

/** Admission and the rendition worker share the same oriented pixel rounding. */
export function admitShowcaseImage(
  input: Pick<ShowcaseSelectionInput, 'role' | 'crop' | 'focalArea'>,
  inspected: ImageSize & { hasAlpha?: boolean },
): ImageSize {
  let region: ImageSize;
  try {
    region = pixelCrop(input.crop, inspected);
    if (input.focalArea !== null) {
      const focal = pixelCrop(input.focalArea, inspected);
      const crop = pixelCrop(input.crop, inspected);
      if (
        focal.left < crop.left ||
        focal.top < crop.top ||
        focal.left + focal.width > crop.left + crop.width ||
        focal.top + focal.height > crop.top + crop.height
      )
        throw new Error('focal area outside crop');
    }
  } catch {
    throw new ShowcaseRefused('showcase_crop_invalid');
  }
  if (input.role === 'background-landscape' || input.role === 'background-portrait') {
    const landscape = input.role === 'background-landscape';
    if (region.width * (landscape ? 9 : 4) !== region.height * (landscape ? 16 : 3))
      throw new ShowcaseRefused('showcase_ratio_mismatch');
    if (region.width < (landscape ? 1280 : 960) || region.height < (landscape ? 720 : 1280))
      throw new ShowcaseRefused('showcase_resolution_too_small');
  } else if (inspected.hasAlpha !== true) throw new ShowcaseRefused('showcase_alpha_required');
  return { width: region.width, height: region.height };
}

/** Normalize recognized watch forms without fetching redirects or caller URLs.
 * Multipart Bilibili links keep their positive part number. Other HTTPS links
 * retain their path/query/fragment and are always plain links. */
export function normalizeTrailer(
  value: string | null,
): { url: string; provider: 'youtube' | 'bilibili' | 'link' } | null {
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ShowcaseRefused('showcase_trailer_invalid');
  }
  if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password)
    throw new ShowcaseRefused('showcase_trailer_invalid');
  const host = url.hostname.toLowerCase();
  const youtube = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(
    host,
  );
  if (youtube || host === 'youtu.be' || host === 'www.youtu.be') {
    const id = host.endsWith('youtu.be')
      ? /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1]
      : url.pathname === '/watch'
        ? url.searchParams.get('v')
        : /^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id) || url.port)
      throw new ShowcaseRefused('showcase_trailer_invalid');
    return { url: `https://www.youtube.com/watch?v=${id}`, provider: 'youtube' };
  }
  if (
    ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'player.bilibili.com'].includes(host)
  ) {
    const id =
      /^\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10}|av[1-9][0-9]*)\/?$/.exec(url.pathname)?.[1] ??
      (host === 'player.bilibili.com' && url.pathname === '/player.html'
        ? (url.searchParams.get('bvid') ??
          (url.searchParams.get('aid') ? `av${url.searchParams.get('aid')}` : null))
        : null);
    const part = url.searchParams.get('p') ?? url.searchParams.get('page');
    if (
      !id ||
      !/^(BV[1-9A-HJ-NP-Za-km-z]{10}|av[1-9][0-9]*)$/.test(id) ||
      url.port ||
      (part !== null && !/^[1-9][0-9]{0,5}$/.test(part))
    )
      throw new ShowcaseRefused('showcase_trailer_invalid');
    return {
      url: `https://www.bilibili.com/video/${id}/${part && part !== '1' ? `?p=${part}` : ''}`,
      provider: 'bilibili',
    };
  }
  return { url: url.href, provider: 'link' };
}

const uuid = t.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const context = t.Union([t.Literal(DEFAULT_MEDIA_CONTEXT), native]);
const area = t.Nullable(t.String({ maxLength: 64 }));
export const campaignArtCommand = t.Object({
  profile: t.Literal('zone-campaign-art-v1'),
  realm: native,
  asset: uuid,
  role: showcaseRole,
  language: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
  tone: t.Optional(t.Union([t.Literal('dark'), t.Literal('light')])),
  anchor: t.Optional(logoAnchor),
  crop: t.Optional(area),
  focalArea: t.Optional(area),
  actingSubject: native,
}, { additionalProperties: false });
export const showcaseSelectionCommand = t.Object(
  {
    profile: t.Literal('work-showcase-selection-v1'),
    context: t.Optional(context),
    expectedSelection: t.Nullable(uuid),
    role: showcaseRole,
    language: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
    tone: t.Optional(t.Union([t.Literal('dark'), t.Literal('light')])),
    anchor: t.Optional(logoAnchor),
    asset: t.Nullable(uuid),
    crop: t.Optional(area),
    focalArea: t.Optional(area),
    actingSubject: native,
  },
  { additionalProperties: false },
);
export const showcaseTrailerCommand = t.Object(
  {
    profile: t.Literal('work-showcase-trailer-v1'),
    context: t.Optional(context),
    expectedSelection: t.Nullable(uuid),
    url: t.Nullable(t.String({ maxLength: 2048 })),
    actingSubject: native,
  },
  { additionalProperties: false },
);
export const showcaseBatchCommand = t.Object(
  {
    profile: t.Literal('work-showcase-batch-v1'),
    targets: t.Array(native, { minItems: 1, maxItems: 64 }),
    context: t.Optional(context),
    actingSubject: t.Optional(native),
  },
  { additionalProperties: false },
);

const showcaseImage = t.Object({
  role: showcaseRole,
  selection: uuid,
  asset: uuid,
  use: uuid,
  representation: uuid,
  context,
  url: t.String(),
  mediaType: t.String(),
  width: t.Integer(),
  height: t.Integer(),
  cropWidth: t.Integer(),
  cropHeight: t.Integer(),
  crop: area,
  focalArea: area,
  language: t.Optional(t.String()),
  tone: t.Optional(t.Union([t.Literal('dark'), t.Literal('light')])),
  anchor: t.Optional(logoAnchor),
  srcset: t.Array(
    t.Object({
      url: t.String(),
      type: t.Union([t.Literal('image/avif'), t.Literal('image/webp')]),
      width: t.Integer(),
      height: t.Integer(),
    }),
    { maxItems: 12 },
  ),
});
export const showcaseBatchResult = t.Object({
  profile: t.Literal('work-showcase-batch-v1'),
  complete: t.Literal(true),
  items: t.Array(
    t.Union([
      t.Object({ reference: native, status: t.Literal('unavailable') }),
      t.Object({
        reference: native,
        status: t.Literal('available'),
        images: t.Array(showcaseImage),
        trailer: t.Nullable(
          t.Object({
            selection: uuid,
            context,
            url: t.String(),
            provider: t.Union([t.Literal('youtube'), t.Literal('bilibili'), t.Literal('link')]),
          }),
        ),
      }),
    ]),
    { maxItems: 64 },
  ),
  generation: t.Object({
    graph: t.String(),
    media: t.Nullable(t.String()),
    addresses: t.Optional(t.String()),
  }),
  cost: t.Object({
    graphQueries: t.Integer(),
    mediaQueries: t.Integer(),
    accessQueries: t.Integer(),
    accessChecks: t.Integer(),
    disclosureQueries: t.Integer(),
  }),
});
export const showcaseSelectionResult = t.Object({
  target: native,
  selection: uuid,
  predecessor: t.Nullable(uuid),
  position: t.Object({ owner: t.Literal('content'), dataEpoch: uuid, sequence: t.String() }),
  replayed: t.Boolean(),
});
