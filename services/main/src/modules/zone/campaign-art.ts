import { MediaInvalid, type MediaStore } from '../media/store.ts';
import { canonicalLanguage } from '../display-language/tag.ts';
import { pixelCrop, RENDITION_LIMITS, type RenditionCandidate } from '../media-rendition/policy.ts';
import { zoneCampaignUses, type ZoneCampaignArt, type ZoneSlide } from './presentation-format.ts';

export const ZONE_CAMPAIGN_ART_COST = { maxSlides: 6, maxCampaignUses: RENDITION_LIMITS.batch,
  maxCampaignMediaReads: 2 } as const;
type CampaignMediaStore = Pick<MediaStore, 'itemDeliveryBatch'>
  & { renditions: Pick<MediaStore['renditions'], 'candidatesBatch'> };

/** One exact, live publication-item/campaign-art batch for all slide Uses. */
export async function readZoneCampaignItems(store: Pick<MediaStore, 'itemDeliveryBatch'> | undefined,
  realm: string | null, slides: readonly ZoneSlide[]) {
  const uses = zoneCampaignUses(slides);
  if (slides.length > ZONE_CAMPAIGN_ART_COST.maxSlides || uses.length > RENDITION_LIMITS.batch) {
    throw new MediaInvalid('Zone campaign art exceeds its batch bound');
  }
  const items: Awaited<ReturnType<MediaStore['itemDeliveryBatch']>> = store && realm && uses.length ? await store.itemDeliveryBatch(uses) : new Map();
  const eligible = uses.filter(use => {
    const item = items.get(use);
    return item && item.target === realm && item.availability === 'available'
      && item.disclosure === 'public' && item.moderation === 'none' && item.lifecycle === 'active'
      && Number.isSafeInteger(item.width) && item.width > 0
      && Number.isSafeInteger(item.height) && item.height > 0;
  });
  return new Map(eligible.map(use => [use, items.get(use)!]));
}

/** Two exact Content batches, O(B log M) lookups and O(B + S) output:
 * at most 64 distinct campaign Uses for six slides, independent of corpus,
 * memberships and history. Text and target survive every missing art role. */
export async function readZoneCampaignArt(store: CampaignMediaStore | undefined,
  realm: string | null, slides: readonly ZoneSlide[]) {
  const items = await readZoneCampaignItems(store, realm, slides);
  const candidates: Map<string, RenditionCandidate[]> = store && items.size
    ? await store.renditions.candidatesBatch([...items.keys()]) : new Map();
  const resolve = (image: ZoneCampaignArt['landscape'], role: string) => {
    if (!image) return null;
    const use = image.use.slice(-36);
    const item = items.get(use);
    if (!item || (item.role?.startsWith('campaign-') && item.role !== `campaign-${role}`)) return null;
    const region = pixelCrop(item.crop ?? null, item);
    return { ...image, ...(item.focalArea && !image.focalArea ? { focalArea: item.focalArea } : {}),
      crop: item.crop ?? null, cropWidth: region.width, cropHeight: region.height, url: `/v1/media/uses/${use}`,
      width: item.width, height: item.height, mediaType: item.mediaType,
      srcset: candidates.get(use) ?? [] };
  };
  return slides.map(slide => ({ id: slide.id, art: {
    landscape: resolve(slide.art?.landscape, 'background-landscape'), portrait: resolve(slide.art?.portrait, 'background-portrait'),
    cutout: resolve(slide.art?.cutout, 'cutout'),
    logos: (slide.art?.logos ?? []).flatMap(logo => {
      const image = resolve(logo, `logo:${canonicalLanguage(logo.language)}:${logo.tone}`);
      return image ? [{ ...image, language: logo.language, tone: logo.tone, anchor: logo.anchor }] : [];
    }),
  } }));
}
