import { beforeEach, expect, mock, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { direction } from '@rezics/main/language';
import { cloneElement, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RealmView } from '../realm/realm-page.tsx';
import type { ZonePresentationRead } from '../realm/types.ts';
import { messages } from '../realm/messages.ts';
import { fictionZone, zoneMessagesFor } from './fixtures.ts';

const zone = '00000000-0000-4000-8000-000000000001';
const canonical = { prefix: '/z/' as const, key: zone, suffixSource: 'Harbor' };
const zoneMessages = zoneMessagesFor('en');
let discussionCalls = 0;
let attached = true;
let currentView: RealmView;
let publication: ZonePresentationRead;

void mock.module('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
void mock.module('next/navigation', () => ({
  usePathname: () => `/en/z/${zone}`,
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  notFound: () => { throw new Error('Unexpected missing home'); },
}));
// The route renders supplied packages; Vite's installed-package glob is not part of this Bun fixture.
void mock.module('../../zones/official/index.ts', () => ({
  installedDigest: async () => null,
  loadPackage: async () => null,
}));
void mock.module('../../i18n/server.ts', () => ({
  requestLocale: async () => 'en',
  getMessages: async (namespace: string) => namespace === 'realm' ? messages : zoneMessages,
  getTranslation: async () => ({ t: {} }),
}));
void mock.module('./about-discussion-entry.tsx', () => ({
  ZoneAboutDiscussion: () => {
    discussionCalls += 1;
    return <aside data-zone-discussion-entry aria-label="Discussion">Discussion sentinel</aside>;
  },
}));
void mock.module('../zone-editor/edit-link.tsx', () => ({ ZoneEditLink: () => null }));
const reads = await import('../realm/read.ts');
void mock.module('../realm/read.ts', () => ({ ...reads,
  resolveSite: async () => ({ kind: 'site', zone, realm: attached ? zone : null, address: { canonical } }),
  readCompletePresentation: async () => ({ ok: true, data: publication }),
  readZoneBrowse: async () => ({ ok: false, failure: 'unavailable' }),
}));
const modules = await import('../realm/modules.ts');
void mock.module('../realm/modules.ts', () => ({ ...modules,
  loadHomeModules: async () => ({ modules: [], images: [] }),
}));
const frames = await import('../realm/realm-page.tsx');
void mock.module('../realm/realm-page.tsx', () => ({ ...frames,
  loadRealmView: async () => currentView,
}));
const { ZoneSiteHome } = await import('./site-home.tsx');
const { ZoneHomeContent } = await import('../zone-editor/home-content.tsx');
const { ZoneSiteRoute, StandaloneZoneSiteFrame } = await import('./site-route.tsx');

// Resolve the server boundaries before React renders their shared frame and content.
// The discussion sentinel stays a React component, so even a nested entry increments it.
async function resolveServerContent(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServerContent));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === ZoneSiteHome) return resolveServerContent(await ZoneSiteHome(node.props as Parameters<typeof ZoneSiteHome>[0]));
  if (node.type === ZoneHomeContent) return resolveServerContent(await ZoneHomeContent(node.props as Parameters<typeof ZoneHomeContent>[0]));
  if (node.type === frames.RealmFrame) return resolveServerContent(await frames.RealmFrame(node.props as Parameters<typeof frames.RealmFrame>[0]));
  if (node.type === StandaloneZoneSiteFrame) return resolveServerContent(await StandaloneZoneSiteFrame(node.props as Parameters<typeof StandaloneZoneSiteFrame>[0]));
  if (!('children' in node.props)) return node;
  return cloneElement(node, { children: await resolveServerContent(node.props.children) });
}

beforeEach(() => {
  discussionCalls = 0;
  attached = true;
  publication = {
    zone, revision: 'publication', name: 'Harbor', language: 'en', official: null,
    presentation: { profile: 'zone-presentation-v2', preset: 'clean', tokens: fictionZone('en').tokens,
      modules: [], slides: [], navigation: [] },
    navigation: [{ occurrence: 'guide', segment: 'guide', target: zone,
      name: { value: 'Harbor field guide', language: 'en', direction: direction('en', 'Harbor field guide') } }],
    moduleData: [], slideMedia: [], home: null,
  } as unknown as ZonePresentationRead;
  currentView = {
    kind: 'view', publication, presentation: publication.presentation, slideMedia: [], mounts: [],
    context: { locale: 'en', ref: 'harbor', realm: zone, zone, mounts: new Map() },
    realm: { kind: 'realm', ref: 'harbor', realm: zone, zone: { id: zone, segment: null },
      header: { id: zone, visibility: 'public', listing: 'listed',
        membership: { count: { kind: 'exact', value: 0 } } } },
    zone: fictionZone('en'), pkg: null, data: null, zoneMessages, messages,
    execution: { state: 'fallback', reason: 'none_approved' }, lookEnabled: true,
    reader: { signedIn: false, actingSubject: null, avatarQuery: '' }, membership: null, ban: null,
  } as unknown as RealmView;
});

for (const home of ['package', 'fallback', 'standalone published', 'standalone unpublished'] as const) {
  test(`${home} home renders its page without invoking the discussion helper`, async () => {
    let content: string;
    if (home === 'package') {
      currentView.pkg = { slug: 'harbor', css: '',
        slots: { home: () => createElement('h1', null, 'Package home') } };
      content = 'Package home';
    } else if (home === 'fallback') {
      content = messages.emptyHomeTitle;
    } else {
      attached = false;
      if (home === 'standalone published') {
        publication.home = { document: fromPlainText('Published Harbor home', 'blocks'),
          definitions: [], blocks: [], showcases: [], showcaseData: { slides: [], slideMedia: [] },
          cost: { nodesVisited: 3, extensions: 0, showcases: 0, responseBytes: 0,
            graphReads: 0, definitionExecutions: 0 },
          reference: { owner: 'content', resourceId: `https://rezics.com/id/${zone}`,
            variantId: `https://rezics.com/id/${zone}`, revisionId: `https://rezics.com/id/${zone}`,
            format: 'rezics-content-json-v1', model: 'document-blocks-v1', byteDigest: '0'.repeat(64),
            byteLength: 0, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
            direction: direction('en', 'Published Harbor home'), sourceRevision: null,
            predecessor: null, provenance: {} } };
        content = 'Published Harbor home';
      } else content = 'Harbor field guide';
    }
    const page = await ZoneSiteRoute({ params: Promise.resolve({ locale: 'en', space: zone }),
      searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(await resolveServerContent(page));
    expect(html).toContain(content);
    expect(html).not.toContain('data-zone-discussion-entry');
    expect(html).not.toContain('aria-label="Discussion"');
    expect(html).not.toContain('Discussion sentinel');
    expect(discussionCalls).toBe(0);
  });
}
