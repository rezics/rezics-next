import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import '../../tests/support/official-package-fixture.ts';
import { fromPlainText } from '@rezics/document';
import { direction } from '@rezics/main/language';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { RealmView } from '../realm/realm-page.tsx';
import type { ZonePresentationRead } from '../realm/types.ts';
import { fictionZone, zoneMessagesFor } from './fixtures.ts';
import { messages } from '../realm/messages.ts';
import { addressKey } from '../address/path.ts';
import { ZoneHomeContent } from '../zone-editor/home-content.tsx';
import { ZoneFrame } from './zone-frame.tsx';

const zone = '00000000-0000-4000-8000-000000000701';
const canonical = { prefix: '/z/' as const, key: zone, suffixSource: 'Publication B' };
const context = { locale: 'en' as const, ref: addressKey(canonical), realm: zone, zone };
const presentation = {
  zone, revision: 'publication-b', name: 'Publication B', language: 'en', direction: direction('en', 'Publication B'), official: null,
  presentation: { profile: 'zone-presentation-v2', preset: 'clean', tokens: fictionZone('en').tokens,
    modules: [], slides: [], navigation: [{ label: 'B link', href: '/b' }] },
  navigation: Array.from({ length: 51 }, (_, index) => ({ occurrence: `b-${index}`, segment: `b-${index}`,
    target: `target-${index}`, name: { value: `B mount ${index + 1}`, language: 'en', direction: direction('en', `B mount ${index + 1}`) } })),
  moduleData: [{ id: 'b-source', sources: [] }], slideMedia: [],
  home: { document: fromPlainText('Publication B prose', 'blocks'), blocks: [], showcases: [],
    showcaseData: { slides: [], sources: [], slideMedia: [] } },
} as unknown as ZonePresentationRead;
let attached = true;
let refused = false;
let routeReads = 0;
const view = () => ({ kind: 'view', publication: presentation, presentation: presentation.presentation,
  slideMedia: presentation.slideMedia, mounts: presentation.navigation, context,
  realm: { kind: 'realm', ref: context.ref, realm: zone, zone: { id: zone, segment: null },
    header: { id: zone, visibility: 'public', listing: 'listed',
      membership: { count: { kind: 'exact', value: 0 } } } },
  zone: fictionZone('en'), pkg: null, data: null, zoneMessages: zoneMessagesFor('en'), messages,
  execution: { state: 'fallback', reason: 'none_approved' }, lookEnabled: true,
  reader: { signedIn: false, actingSubject: null, avatarQuery: '' }, membership: null, ban: null }) as unknown as RealmView;

const originalHeaders = { ...(await import('next/headers')) };
const reads = { ...(await import('../realm/read.ts')) };
const i18n = { ...(await import('../../i18n/server.ts')) };
void mock.module('next/headers', () => ({ ...originalHeaders, cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers() }));

void mock.module('../realm/read.ts', () => ({ ...reads,
  resolveSite: async () => ({ kind: 'site', zone, realm: attached ? zone : null, address: { canonical } }),
  readZoneRoute: async () => {
    routeReads += 1;
    return { ok: true, data: { kind: 'home', page: { document: fromPlainText('Publication A prose', 'blocks') } } };
  },
  readCompletePresentation: async () => refused ? { ok: false, failure: 'unavailable' }
    : { ok: true, data: presentation },
}));
void mock.module('../../i18n/server.ts', () => ({
  ...i18n,
  getMessages: async (namespace: string) => namespace === 'realm' ? messages : zoneMessagesFor('en'),
  getTranslation: async () => ({ t: {} }),
}));
const frames = { ...(await import('../realm/realm-page.tsx')) };
void mock.module('../realm/realm-page.tsx', () => ({ ...frames,
  loadRealmView: async () => refused ? { kind: 'unavailable', failure: 'unavailable' } : view(),
}));
afterAll(async () => {
  await mock.module('../realm/realm-page.tsx', () => frames);
  await mock.module('../../i18n/server.ts', () => i18n);
  await mock.module('../realm/read.ts', () => reads);
  await mock.module('next/headers', () => originalHeaders);
});
const { ZoneSiteRoute, StandaloneZoneSiteFrame } = await import('./site-route.tsx');

function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) return node.map(child => find(child, type)).find(Boolean) ?? null;
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  return node.type === type ? node as ReactElement<Record<string, unknown>> : find(node.props.children, type);
}

test('both public frame boundaries retain the 51st link from the complete response', async () => {
  const realm = await frames.RealmFrame({ view: view(), tab: null, locale: 'en', search: {}, children: null });
  const standalone = await StandaloneZoneSiteFrame({ zone: fictionZone('en'), zoneId: zone,
    address: context.ref, locale: 'en', messages, presentation, children: null });
  for (const frame of [realm, standalone]) {
    const rendered = find(frame, ZoneFrame)!;
    const site = rendered.props.site as { links: Array<{ href: string; label: { value: string } }> };
    expect(site.links.at(-1)?.label.value).toBe('B mount 51');
    expect(site.links.at(-1)?.href).toContain('/b-50');
  }
});
beforeEach(() => { routeReads = 0; refused = false; });

for (const realm of [true, false]) {
  test(`the ${realm ? 'Realm' : 'standalone'} home retains one complete presentation selection`, async () => {
    attached = realm;
    const result = await ZoneSiteRoute({ params: Promise.resolve({ locale: 'en', space: zone }),
      searchParams: Promise.resolve({}) });
    const home = find(result, ZoneHomeContent)!;
    expect(home.props.page).toBe(presentation.home);
    expect(home.props.presentation).toBe(presentation.presentation);
    expect(home.props.slideMedia).toBe(presentation.slideMedia);
    expect(home.props.moduleData).toBe(presentation.moduleData);
    if (realm) expect((result as ReactElement<{ view: RealmView }>).props.view.publication).toBe(presentation);
    else expect((result as ReactElement<{ presentation: ZonePresentationRead }>).props.presentation).toBe(presentation);
    expect(routeReads).toBe(0);
    expect(presentation.navigation[50]?.name.value).toBe('B mount 51');
  });

  test(`an unavailable ${realm ? 'Realm' : 'standalone'} presentation refuses the home instead of using route A`, async () => {
    attached = realm;
    refused = true;
    const result = await ZoneSiteRoute({ params: Promise.resolve({ locale: 'en', space: zone }),
      searchParams: Promise.resolve({}) });
    expect(find(result, ZoneHomeContent)).toBeNull();
    expect(routeReads).toBe(0);
  });
}
