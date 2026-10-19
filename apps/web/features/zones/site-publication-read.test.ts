import { replaceModule } from '../../tests/support/module-replacement.ts';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import '../../tests/support/official-package-fixture.ts';
import { fromPlainText } from '@rezics/document';
import { direction } from '@rezics/main/language';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { RealmView } from '../realm/realm-page.tsx';
import type { ZonePresentationRead } from '../realm/types.ts';
import { fictionZone, zoneMessagesFor } from './fixtures.ts';
import { messages } from '../realm/messages.ts';
import { addressKey, spaceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { ZoneHomeContent } from '../zone-editor/home-content.tsx';
import { ZoneFrame } from './zone-frame.tsx';
import { serverDocumentResponse, withServerRequest } from '../api/server-read.ts';
import { RealmUnavailable } from '../realm/states.tsx';
import LocalizedLink from '../shell/localized-link.tsx';

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
let missing = false;
let routeRefused = false;
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
const restoreOriginalHeaders = replaceModule(import.meta.resolve('next/headers'), originalHeaders, { cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers() });

const restoreReads = replaceModule(import.meta.resolve('../realm/read.ts'), reads, {
  resolveSite: async () => ({ kind: 'site', zone, realm: attached ? zone : null, address: { canonical } }),
  resolveRealm: async () => view().realm,
  readZoneRoute: async () => {
    routeReads += 1;
    if (routeRefused) return { ok: false, failure: 'unavailable' };
    return { ok: true, data: { kind: 'home', page: { document: fromPlainText('Publication A prose', 'blocks') } } };
  },
  readCompletePresentation: async () => missing ? { ok: false, failure: 'missing' }
    : refused ? { ok: false, failure: 'unavailable' }
    : { ok: true, data: presentation },
});
const restoreI18n = replaceModule(import.meta.resolve('../../i18n/server.ts'), i18n, {
  getMessages: async (namespace: string) => namespace === 'realm' ? messages : zoneMessagesFor('en'),
  getTranslation: async () => ({ t: messages }),
});
const frames = { ...(await import('../realm/realm-page.tsx')) };
const restoreFrames = replaceModule(import.meta.resolve('../realm/realm-page.tsx'), frames, {
  loadRealmView: async () => missing ? { kind: 'missing' }
    : refused ? { kind: 'unavailable', failure: 'unavailable' } : view(),
});
afterAll(async () => {
  restoreFrames();
  restoreI18n();
  restoreReads();
  restoreOriginalHeaders();
});
const { ZoneSiteRoute, StandaloneZoneSiteFrame, zoneSiteMetadata } = await import('./site-route.tsx');

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
beforeEach(() => { routeReads = 0; refused = false; missing = false; routeRefused = false; });

test('root metadata selects the same complete publication as the home, without an unused route prerequisite', async () => {
  for (const realm of [true, false]) {
    attached = realm;
    routeRefused = true;
    const props = { params: Promise.resolve({ locale: 'en', space: zone }), searchParams: Promise.resolve({}) };
    const metadata = await zoneSiteMetadata(props);
    const result = await ZoneSiteRoute(props);
    expect(metadata.title).toBe('Publication B');
    expect(find(result, ZoneHomeContent)?.props.page).toBe(presentation.home);
    expect(routeReads).toBe(0);
    refused = true;
    expect((await zoneSiteMetadata(props)).title).toBe(messages.unavailableTitle);
    refused = false;
  }
});

test('whole-home publication failure determines the document status, while a failed framed region stays local', async () => {
  const request = () => new Request(new URL(`${localizedPath(spaceHref(context.ref, 'site'), 'en')}?q=rice&language=en&language=ja`, 'https://web.test'));
  const props = (path?: string[]) => ({ params: Promise.resolve({ locale: 'en', space: zone, path }),
    searchParams: Promise.resolve({ q: 'rice', language: ['en', 'ja'] }) });
  for (const realm of [true, false]) {
    attached = realm;
    refused = true;
    await withServerRequest(request(), async () => {
      const selected = await ZoneSiteRoute(props());
      // Finish the selected server recovery view without invoking its client child.
      const result = realm && isValidElement(selected)
        ? (selected.type as (props: unknown) => ReactNode)(selected.props) : selected;
      expect(find(result, ZoneHomeContent)).toBeNull();
      const response = await serverDocumentResponse(request(), new Response('render completed', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }));
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('retry-after')).toBe('5');
      if (realm) {
        expect(find(result, RealmUnavailable)).not.toBeNull();
        expect(find(result, LocalizedLink)?.props.href).toBe('/discover');
      }
    });
  }
  attached = true;
  refused = false;
  routeRefused = true;
  await withServerRequest(request(), async () => {
    const result = await ZoneSiteRoute(props(['mount']));
    expect(find(result, RealmUnavailable)).toBeNull();
    const response = await serverDocumentResponse(request(), new Response('frame and failed region', {
      headers: { 'content-type': 'text/html' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.has('retry-after')).toBe(false);
  });
  missing = true;
  await withServerRequest(request(), async () => {
    await expect(ZoneSiteRoute(props())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});

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
