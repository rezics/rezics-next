import { DEFAULT_MEDIA_CONTEXT, MediaInvalid, type MediaStore } from '../media/store.ts';
import { canonicalLanguage } from '../display-language/tag.ts';
import { pixelCrop, RENDITION_LIMITS, type RenditionCandidate } from '../media-rendition/policy.ts';
import { zoneCampaignUses, type ZoneCampaignArt, type ZoneSlide } from './presentation-format.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { currentDisclosureViewer } from '../disclosure/viewer.ts';
import type { MediaDependencies } from '../media/commands.ts';
import { requestUseRenditions } from '../media-rendition/request.ts';

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

/** Optional post-commit work cannot change a saved Zone's result. At most one
 * media batch and one bounded inspection per newly referenced publication Use. */
export async function requestNewZoneCampaignRenditions(media: Pick<MediaDependencies, 'store' | 'objects'>,
  realm: string | null, slides: readonly ZoneSlide[], added: readonly string[]) {
  if (!added.length) return;
  try {
    const items = await readZoneCampaignItems(media.store, realm, slides);
    for (const use of added) {
      if (items.get(use)?.role !== 'publication-item') continue;
      try { await requestUseRenditions(media.store.renditions, media.objects, use); }
      catch { /* The saved configuration remains usable with its source image. */ }
    }
  } catch { /* Media storage is optional after the Zone receipt is sealed. */ }
}

/** Two exact Content batches, O(B log M) lookups and O(B + S) output:
 * at most 64 distinct campaign Uses for six slides, independent of corpus,
 * memberships and history. Text and target survive every missing art role. */
export async function readZoneCampaignArt(store: CampaignMediaStore | undefined,
  realm: string | null, slides: readonly ZoneSlide[], disclosure?: {
    environment: WorkActivationEnvironment; zone: string;
  }) {
  const items = await readZoneCampaignItems(store, realm, slides);
  if (disclosure && items.size) {
    const uses = [...items.keys()];
    const decisions = await discloseInventory(disclosure.environment, uses.flatMap(use => [
      { owner: 'media' as const, resource: `https://rezics.com/id/${items.get(use)!.asset}`,
        component: 'cover' as const, context: items.get(use)!.context ?? DEFAULT_MEDIA_CONTEXT, work: realm },
      { owner: 'media' as const, resource: `https://rezics.com/id/${use}`,
        component: 'media_use' as const, context: items.get(use)!.context ?? DEFAULT_MEDIA_CONTEXT, work: realm },
    ]), currentDisclosureViewer(), 'media');
    uses.forEach((use, index) => {
      if (decisions[index * 2] !== 'visible' || decisions[index * 2 + 1] !== 'visible') items.delete(use);
    });
  }
  const candidates: Map<string, RenditionCandidate[]> = store && items.size
    ? await store.renditions.candidatesBatch([...items.keys()]) : new Map();
  const resolve = (image: ZoneCampaignArt['landscape'], role: string) => {
    if (!image) return null;
    const use = image.use.slice(-36);
    const item = items.get(use);
    if (!item || (item.role?.startsWith('campaign-') && item.role !== `campaign-${role}`)) return null;
    const region = pixelCrop(item.crop ?? null, item);
    return { ...image, ...(item.focalArea && !image.focalArea ? { focalArea: item.focalArea } : {}),
      crop: item.crop ?? null, cropWidth: region.width, cropHeight: region.height,
      // The exact representation and Use, as Work art and candidates are named, so readers' image policy applies.
      url: `/v1/media/representations/${item.representation}/bytes?use=${use}`,
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
