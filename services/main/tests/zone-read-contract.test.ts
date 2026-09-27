import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { checkZoneConfiguration, ZONE_CONFIG_FORMAT, ZONE_PROFILE }
  from '../src/modules/zone/config-format.ts';
import { DEFAULT_ZONE_PRESENTATION, type ZonePresentation }
  from '../src/modules/zone/presentation-format.ts';
import { readZoneBannerMedia } from '../src/modules/zone/publication.ts';
import { zonePackageExecution, type FirstPartyView }
  from '../src/modules/theme/first-party-lifecycle.ts';
import { discoveryCredit } from '../src/modules/discovery/contract.ts';
import { displayZoneCredits } from '../src/modules/zone-modules/read.ts';

const id = (value: string) => `https://rezics.com/id/${value}`;
const zone = id('00000000-0000-4000-8000-000000000001');
const realm = id('00000000-0000-4000-8000-000000000002');
const use = id('00000000-0000-4000-8000-000000000003');
const bundleDigest = `sha256:${'a'.repeat(64)}`;
const config = (presentation: unknown, queryBlocks: unknown[] = []) => Buffer.from(JSON.stringify({
  format: ZONE_CONFIG_FORMAT, zone, space: realm, navigation: use, state: 'active',
  disclosure: 'public', presentation, queryBlocks, budget: { timeMs: 2000, rows: 1000 }, model: ZONE_PROFILE,
}));

test('Zone public read names are explicit and ranking metrics match the ranking API', () => {
  const presentation: ZonePresentation = { ...DEFAULT_ZONE_PRESENTATION, modules: [{ id: 'latest', type: 'shelf',
    title: 'Latest', titles: { fr: 'Nouveautés', 'zh-Hans': '最新' },
    source: { kind: 'query-block', block: 'new-adoptions' } },
  { id: 'chart', type: 'ranking', title: 'Chart', source: { kind: 'query-block', block: 'rankings' },
    options: { metric: 'finished-chapters', interval: 'week' } }] };
  expect(checkZoneConfiguration(config(presentation)).presentation).toEqual(presentation);
  expect(() => checkZoneConfiguration(config({ ...presentation, modules: [{
    ...presentation.modules[1], options: { metric: 'views', interval: 'week' },
  }] }))).toThrow('Zone configuration format differs');
  expect(() => checkZoneConfiguration(config(presentation, [{ block: 'rankings',
    definition: zone, maxRows: 10 }]))).toThrow('public Zone read source is reserved');
});

test('Zone banner metadata exposes only deliverable Realm media with actual dimensions', async () => {
  const banners = [{ id: 'hero', image: use }];
  const store = { itemDelivery: async () => ({ target: realm, availability: 'available',
    disclosure: 'public', moderation: 'none', lifecycle: 'active',
    width: 1440, height: 540, mediaType: 'image/webp' }) };
  expect(await readZoneBannerMedia(store as never, realm, banners)).toEqual([{ id: 'hero',
    image: { url: '/v1/media/uses/00000000-0000-4000-8000-000000000003',
      width: 1440, height: 540, mediaType: 'image/webp' } }]);
  expect((await readZoneBannerMedia({ itemDelivery: async () => ({ ...await store.itemDelivery(),
    disclosure: 'private' }) } as never, realm, banners))[0]!.image).toBeNull();
});

test('reviewed source digest is reported only by an effective package activation', () => {
  const view = { theme: zone, hostZone: zone, revision: use, activation: use,
    activationRevision: use, decision: 'approved', submitter: zone,
    reviewer: realm, submitterPrincipal: zone, reviewerPrincipal: realm,
    activationControl: 'urn:rezics:theme:control:initial', control: null,
    approvalExpiresAt: '2999-01-01T00:00:00.000Z', globallyDisabled: false,
    revoked: false, bundle: { packageDigest: bundleDigest } } as unknown as FirstPartyView;
  expect(zonePackageExecution(view, zone)).toMatchObject({ state: 'package', packageDigest: bundleDigest });
  expect(zonePackageExecution({ ...view, revoked: true }, zone)).toMatchObject({
    state: 'fallback', reason: 'revoked' });
});

test('Zone cards name public Agent credits and suppress undisclosed Agent identities', () => {
  const publicAgent = id('00000000-0000-4000-8000-000000000004');
  const privateAgent = id('00000000-0000-4000-8000-000000000005');
  const credits = [{ id: use, role: 'author' as const, participantKind: 'agent' as const,
    provider: null, key: null, ordinal: null, agent: publicAgent, displayName: null, handle: null },
  { id: zone, role: 'author' as const, participantKind: 'agent' as const,
    provider: null, key: null, ordinal: null, agent: privateAgent, displayName: null, handle: null }];
  const shown = displayZoneCredits(credits, new Map([[publicAgent,
    { displayName: 'Ada Writer', handle: 'ada' }]]));
  expect(shown).toHaveLength(1);
  expect(shown[0]).toMatchObject({ agent: publicAgent, displayName: 'Ada Writer', handle: 'ada' });
  expect(shown.every(credit => Value.Check(discoveryCredit, credit))).toBe(true);
});
