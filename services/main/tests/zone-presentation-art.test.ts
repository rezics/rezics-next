import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readZoneCampaignArt, ZONE_PUBLICATION_COST } from '../src/modules/zone/publication.ts';
import type { MediaStore } from '../src/modules/media/store.ts';

test('six layered slides resolve repeated Uses in two batches and preserve logo metadata and srcset', async () => {
  const realm = `https://rezics.com/id/${randomUUID()}`;
  const uses = Array.from({ length: 64 }, () => randomUUID());
  let itemReads = 0;
  let renditionReads = 0;
  const store = {
    itemDeliveryBatch: async (ids: readonly string[]) => {
      itemReads++;
      expect(ids).toEqual(uses);
      return new Map(ids.map(use => [use, { target: realm, availability: 'available',
        disclosure: 'public', moderation: 'none', lifecycle: 'active', width: 1280, height: 720,
        mediaType: 'image/png' }]));
    },
    renditions: { candidatesBatch: async (ids: readonly string[]) => {
      renditionReads++;
      expect(ids).toEqual(uses);
      return new Map(ids.map(use => [use, [{ url: `/renditions/${use}`, width: 640,
        height: 360, type: 'image/avif' as const }]]));
    } },
  } as unknown as Pick<MediaStore, 'itemDeliveryBatch' | 'renditions'>;
  const slides = Array.from({ length: 6 }, (_, index) => ({ id: `slide-${index}`, href: '/',
    art: { logos: uses.slice(index * 11, (index + 1) * 11).map((use, logo) => ({
      use: `https://rezics.com/id/${use}`, language: `en-x-logo${logo}`, tone: 'dark' as const,
      anchor: 'center-top' as const, focalArea: 'xywh=percent:0,0,100,100',
    })) },
  }));
  const result = await readZoneCampaignArt(store, realm, slides);
  expect(itemReads).toBe(1);
  expect(renditionReads).toBe(1);
  expect(ZONE_PUBLICATION_COST.maxCampaignMediaReads).toBe(2);
  expect(result.map(slide => slide.id)).toEqual(slides.map(slide => slide.id));
  expect(result[0]?.art.logos[0]).toMatchObject({ language: 'en-x-logo0', tone: 'dark',
    anchor: 'center-top', focalArea: 'xywh=percent:0,0,100,100', srcset: [{ width: 640, height: 360 }] });
  await expect(readZoneCampaignArt(store, realm, [...slides, slides[0]!])).rejects.toThrow('batch bound');
  expect(itemReads).toBe(1);
  const duplicate = [{ ...slides[0]!, art: { landscape: slides[0]!.art.logos[0], logos: slides[0]!.art.logos } }];
  const duplicateStore = { ...store, itemDeliveryBatch: async (ids: readonly string[]) => {
    expect(ids).toHaveLength(11); return new Map();
  } };
  expect((await readZoneCampaignArt(duplicateStore, realm, duplicate))[0]?.art.logos).toEqual([]);
});
