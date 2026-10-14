import { replaceModule } from '../../tests/support/module-replacement.ts';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import '../../tests/support/official-package-fixture.ts';
import { fromPlainText } from '@rezics/document';
import { direction } from '@rezics/main/language';
import { cloneElement, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext, PathParamsContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import type { RealmView } from '../realm/realm-page.tsx';
import type { ZonePresentationRead } from '../realm/types.ts';
import { messages } from '../realm/messages.ts';
import { siteHref } from '../realm/route.ts';
import { spaceHref } from '../address/path.ts';
import { fictionZone, zoneMessagesFor } from './fixtures.ts';
import { metadataOnlyWork } from '../work-page/fixtures.ts';
import { messages as workMessages } from '../work-page/messages.ts';

const zone = '00000000-0000-4000-8000-000000000001';
const canonical = { prefix: '/z/' as const, key: zone, suffixSource: 'Harbor' };
const zoneMessages = zoneMessagesFor('en');
let discussionCalls = 0;
let attached = true;
let currentView: RealmView;
let publication: ZonePresentationRead;
let pageKind: 'work' | 'resource' | 'document';
const discussionAddresses: Array<{ zone?: string; ref?: string; path: string; href: string }> = [];

const originalHeaders = { ...(await import('next/headers')) };
const i18n = { ...(await import('../../i18n/server.ts')) };
const restoreOriginalHeaders = replaceModule(import.meta.resolve('next/headers'), originalHeaders, {
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
});
const restoreI18n = replaceModule(import.meta.resolve('../../i18n/server.ts'), i18n, {
  requestLocale: async () => 'en',
  getMessages: async (namespace: string) => namespace === 'realm' ? messages
    : namespace === 'workPage' ? workMessages.en : zoneMessages,
  getTranslation: async () => ({ t: {} }),
});
const discussionEntry = { ...(await import('./about-discussion-entry.tsx')) };
const restoreDiscussionEntry = replaceModule(import.meta.resolve('./about-discussion-entry.tsx'), discussionEntry, {
  ZoneAboutDiscussion: (address: typeof discussionAddresses[number]) => {
    discussionCalls += 1;
    discussionAddresses.push(address);
    return <aside data-zone-discussion-entry aria-label="Discussion">Discussion sentinel</aside>;
  },
});
const editLink = { ...(await import('../zone-editor/edit-link.tsx')) };
const restoreEditLink = replaceModule(import.meta.resolve('../zone-editor/edit-link.tsx'), editLink, { ZoneEditLink: () => null });
const reads = { ...(await import('../realm/read.ts')) };
const restoreReads = replaceModule(import.meta.resolve('../realm/read.ts'), reads, {
  resolveSite: async () => ({ kind: 'site', zone, realm: attached ? zone : null, address: { canonical } }),
  readCompletePresentation: async () => ({ ok: true, data: publication }),
  readZoneBrowse: async () => ({ ok: false, failure: 'unavailable' }),
  readZoneRoute: async () => ({ ok: true, data: {
    kind: pageKind === 'document' ? 'document' : 'detail',
    resource: { id: metadataOnlyWork.id }, mount: null, tab: null,
  } }),
});
const modules = { ...(await import('../realm/modules.ts')) };
const restoreModules = replaceModule(import.meta.resolve('../realm/modules.ts'), modules, {
  loadHomeModules: async () => ({ modules: [], images: [] }),
});
const frames = { ...(await import('../realm/realm-page.tsx')) };
const restoreFrames = replaceModule(import.meta.resolve('../realm/realm-page.tsx'), frames, {
  loadRealmView: async () => currentView,
});
const workReads = { ...(await import('../work-page/read.ts')) };
const restoreWorkReads = replaceModule(import.meta.resolve('../work-page/read.ts'), workReads, {
  loadWork: async () => ({ ok: true, id: metadataOnlyWork.id.slice(-36), header: metadataOnlyWork }),
  readText: async () => ({ ok: true, data: { language: 'en', body: 'Mounted guide prose' } }),
});
// These content regions have their own reads; the Zone route and the components that own its entry stay real.
const workViews = { ...(await import('../work-page/work-views.tsx')) };
const restoreWorkViews = replaceModule(import.meta.resolve('../work-page/work-views.tsx'), workViews, {
  WorkFrameView: ({ work, children }: { work: typeof metadataOnlyWork; children: ReactNode }) =>
    <section><h1>{work.title.value}</h1>{children}</section>,
  WorkOverview: () => <article>Work overview body</article>,
});
const entityReads = { ...(await import('../entity-page/read.ts')) };
const restoreEntityReads = replaceModule(import.meta.resolve('../entity-page/read.ts'), entityReads, {
  readEntityProjection: async () => ({ ok: true, data: {
    target: { base: pageKind === 'work' ? 'work' : 'resource' },
    summary: { status: 'available', name: { value: 'Harbor resource', language: 'en',
      direction: direction('en', 'Harbor resource') } },
  } }),
});
const entityViews = { ...(await import('../entity-page/entity-page.tsx')) };
const restoreEntityViews = replaceModule(import.meta.resolve('../entity-page/entity-page.tsx'), entityViews, {
  EntityPage: () => <article><h1>Harbor resource</h1></article>,
});
afterAll(async () => {
  restoreEntityViews();
  restoreEntityReads();
  restoreWorkViews();
  restoreWorkReads();
  restoreFrames();
  restoreModules();
  restoreReads();
  restoreEditLink();
  restoreDiscussionEntry();
  restoreI18n();
  restoreOriginalHeaders();
});
const { ZoneSiteHome } = await import('./site-home.tsx');
const { ZoneHomeContent } = await import('../zone-editor/home-content.tsx');
const { ZoneWorkPage } = await import('./site-work.tsx');
const { ZoneEntityPage } = await import('./site-entity.tsx');
const { ZoneSiteRoute, StandaloneZoneSiteFrame } = await import('./site-route.tsx');

// Resolve the server boundaries before React renders their shared frame and content.
// The discussion sentinel stays a React component, so even a nested entry increments it.
async function resolveServerContent(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServerContent));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === ZoneSiteHome) return resolveServerContent(await ZoneSiteHome(node.props as Parameters<typeof ZoneSiteHome>[0]));
  if (node.type === ZoneHomeContent) return resolveServerContent(await ZoneHomeContent(node.props as Parameters<typeof ZoneHomeContent>[0]));
  if (node.type === ZoneWorkPage) return resolveServerContent(await ZoneWorkPage(node.props as Parameters<typeof ZoneWorkPage>[0]));
  if (node.type === ZoneEntityPage) return resolveServerContent(await ZoneEntityPage(node.props as Parameters<typeof ZoneEntityPage>[0]));
  if (node.type === frames.RealmFrame) return resolveServerContent(await frames.RealmFrame(node.props as Parameters<typeof frames.RealmFrame>[0]));
  if (node.type === StandaloneZoneSiteFrame) return resolveServerContent(await StandaloneZoneSiteFrame(node.props as Parameters<typeof StandaloneZoneSiteFrame>[0]));
  if (!('children' in node.props)) return node;
  return cloneElement(node, { children: await resolveServerContent(node.props.children) });
}

beforeEach(() => {
  discussionCalls = 0;
  discussionAddresses.length = 0;
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

function publishHome() {
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
}

// Components already loaded by another test can retain Next's real hooks.
// Supply their real contexts rather than depend on replacing that module again.
function renderPage(node: ReactNode) {
  const router = { bfcacheId: 'discussion-page', back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={siteHref('en', zone, [])}>
        <PathParamsContext.Provider value={{ locale: 'en' }}>
          <SearchParamsContext.Provider value={new URLSearchParams()}>{node}</SearchParamsContext.Provider>
        </PathParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

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
        publishHome();
        content = 'Published Harbor home';
      } else content = 'Harbor field guide';
    }
    const page = await ZoneSiteRoute({ params: Promise.resolve({ locale: 'en', space: zone }),
      searchParams: Promise.resolve({}) });
    const html = renderPage(await resolveServerContent(page));
    expect(html).toContain(content);
    expect(html).not.toContain('data-zone-discussion-entry');
    expect(html).not.toContain('aria-label="Discussion"');
    expect(html).not.toContain('Discussion sentinel');
    expect(discussionCalls).toBe(0);
  });
}

test('an attached Realm published home renders its page without invoking the discussion helper', async () => {
  publishHome();
  const page = await ZoneSiteRoute({ params: Promise.resolve({ locale: 'en', space: zone }),
    searchParams: Promise.resolve({}) });
  const html = renderPage(await resolveServerContent(page));
  expect(html).toContain('Published Harbor home');
  expect(html).not.toContain('data-zone-discussion-entry');
  expect(discussionCalls).toBe(0);
});

for (const kind of ['work', 'resource', 'document'] as const) {
  test(`${kind} frame retains its attached Realm discussion entry`, async () => {
    pageKind = kind;
    const path = ['guide', 'harbor-field-guide'];
    const page = await ZoneSiteRoute({ params: Promise.resolve({ locale: 'en', space: zone, path }),
      searchParams: Promise.resolve({}) });
    const html = renderPage(await resolveServerContent(page));
    expect(html).toContain(kind === 'work' ? 'Work overview body'
      : kind === 'resource' ? 'Harbor resource' : 'Mounted guide prose');
    expect(html).toContain('data-zone-discussion-entry');
    expect(html).toContain('aria-label="Discussion"');
    expect(discussionCalls).toBe(1);
    expect(discussionAddresses).toEqual([expect.objectContaining({
      path: '/guide/harbor-field-guide', href: spaceHref(currentView.context.ref, 'site', path),
    })]);
  });
}
