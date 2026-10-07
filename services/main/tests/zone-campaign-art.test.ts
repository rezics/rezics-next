import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { baselineTarget } from '../src/modules/access/baseline.ts';
import { admissionAuthorityAction } from '../src/modules/access/policy-decisions.ts';
import { findPlatformPermission, type PlatformPermission } from '../src/modules/access/platform-permissions.ts';
import { admitShowcaseImage, ShowcaseRefused } from '../src/modules/media/showcase-contract.ts';
import { mediaError } from '../src/routes/media.ts';
import { rateLimitFamily } from '../src/modules/rate-limit/budgets.ts';
import { readZoneCampaignArt } from '../src/modules/zone/campaign-art.ts';
import type { MediaStore } from '../src/modules/media/store.ts';

test('campaign art inherits only Zone configuration authority and has an explicit write budget', () => {
  const zone = `https://rezics.com/id/${randomUUID()}`;
  const zoneScope = `zone:edit:${zone}`;
  expect(baselineTarget('media.campaign', zoneScope)).toEqual(baselineTarget('zone.edit', zoneScope));
  expect(admissionAuthorityAction('media.campaign', zoneScope)).toBe('zone.edit');
  // A platform-administrator match is syntactic and grants nothing by itself.
  // Campaign art is authorized only by a Zone edit grant: the seeded resource
  // grant is that prefix, so avatar, publish and owner scopes do not cover it.
  const seeded = [...readFileSync(new URL('../migrations/access/1290_platform_grants.sql', import.meta.url), 'utf8')
    .matchAll(/\('platform:resource:media\.campaign','([^']*)'\)/g)].map(match => match[1]);
  expect(seeded).toEqual(['zone:edit:*']);
  const grant: PlatformPermission = {
    id: 'campaign', action: 'platform:resource:media.campaign', scope_id: seeded[0]!,
    generation: '1', valid_until: null, witness: 'seed',
  };
  expect(findPlatformPermission([grant], grant.action, zoneScope)?.scope_id).toBe('zone:edit:*');
  for (const scope of [`media:avatar:${zone}`, `content:publish:${zone}`, `media:owner:${zone}`]) {
    expect(baselineTarget('media.campaign', scope)).toBeNull();
    expect(admissionAuthorityAction('media.campaign', scope)).toBe('media.campaign');
    expect(findPlatformPermission([grant], grant.action, scope)).toBeNull();
  }
  expect(rateLimitFamily('POST', `/v1/zones/${zone.slice(-36)}/campaign-art`)).toBe('write');
});

test('campaign admission shares exact showcase pixel/alpha refusals and typed HTTP problems', async () => {
  for (const [role, size, code] of [
    ['background-landscape', { width: 1281, height: 720, hasAlpha: true }, 'showcase_ratio_mismatch'],
    ['background-portrait', { width: 480, height: 640, hasAlpha: true }, 'showcase_resolution_too_small'],
    ['logo', { width: 100, height: 100, hasAlpha: false }, 'showcase_alpha_required'],
    ['cutout', { width: 100, height: 100, hasAlpha: false }, 'showcase_alpha_required'],
  ] as const) {
    let refusal: unknown;
    try { admitShowcaseImage({ role, crop: null, focalArea: null }, size); }
    catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(ShowcaseRefused);
    expect((refusal as ShowcaseRefused).code).toBe(code);
    const response = mediaError(refusal);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code });
  }
});

test('campaign reads retain crop and focal metadata, gate the role and preserve legacy Realm publication Uses', async () => {
  const realm = `https://rezics.com/id/${randomUUID()}`;
  const use = randomUUID();
  let reads = 0;
  const item = { target: realm, role: 'campaign-background-landscape', crop: 'xywh=percent:0,0,100,50',
    focalArea: 'xywh=percent:10,10,20,20', width: 1280, height: 1440, availability: 'available',
    disclosure: 'public', moderation: 'none', lifecycle: 'active', mediaType: 'image/png' };
  const store = { itemDeliveryBatch: async () => { reads++; return new Map([[use, item]]); },
    renditions: { candidatesBatch: async () => new Map() } } as unknown as Pick<MediaStore, 'itemDeliveryBatch' | 'renditions'>;
  const image = { use: `https://rezics.com/id/${use}` };
  const slides = [{ id: 'link', href: '/campaign', art: { landscape: image, cutout: image } }];
  const result = await readZoneCampaignArt(store, realm, slides);
  expect(reads).toBe(1);
  expect(result[0]?.art.landscape).toMatchObject({ crop: item.crop, focalArea: item.focalArea,
    width: 1280, height: 1440, cropWidth: 1280, cropHeight: 720 });
  expect(result[0]?.art.cutout).toBeNull();
  item.role = 'publication-item';
  expect((await readZoneCampaignArt(store, realm, slides))[0]?.art.cutout).not.toBeNull();
});
