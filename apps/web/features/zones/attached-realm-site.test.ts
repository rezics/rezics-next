import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { replaceModule } from '../../tests/support/module-replacement.ts';
import '../../tests/support/official-package-fixture.ts';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import manga from '../../../../tests/qa/fixtures/outcomes/manga/catalogue-browse-and-search-in-its-zone.json';
import homes from '../../../../tests/qa/fixtures/outcomes/zone/home-rendering.json';
import { ACCESS_COOKIE, SESSION_KEY_COOKIE } from '../auth/cookies.ts';
import { addressKey, spaceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import type { RealmView } from '../realm/realm-page.tsx';
import type { RealmHeader, ZoneBrowsePage, ZonePresentationRead } from '../realm/types.ts';
import { idOf } from '../realm/route.ts';

let record = manga as AnswerRecord;
let persona: AnswerPersona = 'visitor';
const host = { ...(await import('next/headers')) };
const restoreHost = replaceModule(import.meta.resolve('next/headers'), host, {
  cookies: async () => ({ get: (name: string) => persona === 'visitor' ? undefined
    : name === ACCESS_COOKIE ? { value: `recorded-${persona}` }
      : name === SESSION_KEY_COOKIE ? { value: '00000000-0000-4000-8000-000000000001' } : undefined }),
  headers: async () => new Headers(),
});
const api = { ...(await import('../api/main.ts')) };
let fetcher: typeof fetch;
const restoreApi = replaceModule(import.meta.resolve('../api/main.ts'), api, {
  mainApiWithToken: (token: string | undefined) => api.mainApiWithToken(token, { fetcher }),
});
const { ZoneSiteRoute, StandaloneZoneSiteFrame } = await import('./site-route.tsx');
const { ZoneHomeContent } = await import('../zone-editor/home-content.tsx');
const { RealmFrame } = await import('../realm/realm-page.tsx');
const { ZoneBrowse } = await import('./browse.tsx');
const { ZoneFrame } = await import('./zone-frame.tsx');
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
afterAll(() => {
  restoreApi();
  restoreHost();
});

function sample(label: string) {
  const found = record.personas[persona].find(answer => answer.label === label);
  if (!found) throw new Error(`Missing supporting attached Realm sample: ${record.row}/${persona}/${label}`);
  return found;
}

function replay(labels: string[]) {
  const transport = recordedFetch(record, persona, labels.map(label => ({ label,
    state: sample(label).status >= 400 ? 'error' : 'populated' })));
  disposals.push(transport.dispose);
  const requests: { path: string; query: Record<string, string>; authorization: string | null }[] = [];
  const gaps: string[] = [];
  fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams),
      authorization: request.headers.get('authorization') });
    try { return await transport.fetcher(input, init); }
    catch (error) { gaps.push(String(error)); throw error; }
  }) as typeof fetch;
  const escaped = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(fetcher, {
    preconnect: globalThis.fetch.preconnect,
  }));
  disposals.push(() => escaped.mockRestore());
  return { requests, gaps };
}

function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) return node.map(child => find(child, type)).find(Boolean) ?? null;
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  return node.type === type ? node as ReactElement<Record<string, unknown>> : find(node.props.children, type);
}

for (const who of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
  test(`${who}: a Zone-only address selects the attached Realm browse chain and canonical site links`, async () => {
    persona = who;
    record = manga as AnswerRecord;
    const realm = new URL(sample('frame-realm-header').path, 'https://recorded.invalid').pathname.split('/')[3]!;
    const zone = new URL(sample('frame-presentation').path, 'https://recorded.invalid').pathname.split('/')[3]!;
    const siteKey = new URL(sample('frame-address').path, 'https://recorded.invalid').searchParams.get('key')!;
    const realmSpace = idOf((sample('frame-realm-header').answer as RealmHeader).space)!;
    const labels = ['frame-address', 'frame-presentation', 'frame-routes', 'frame-realm-header',
      'frame-facets', 'page-browse-default', ...(who === 'visitor' ? [] : ['frame-session-agent',
        'frame-person-preferences', 'frame-joining', 'frame-member-ban', 'frame-follow', 'frame-platform-access'])];
    const { requests, gaps } = replay(labels);
    const presentation = sample('frame-presentation').answer as ZonePresentationRead;
    expect(presentation.address).toMatchObject({ prefix: '/z/' });
    const siteAddress = { ...presentation.address!, prefix: '/z/' as const };
    expect(sample('frame-address').path).toBe(`/v1/addresses/resolve?scope=space&key=${siteKey}`);
    expect(sample('frame-address').answer).toMatchObject({ capabilities: { zone: presentation.zone } });
    expect(Object.keys((sample('frame-address').answer as { capabilities: object }).capabilities)).toEqual(['zone']);
    expect(presentation.realm).toBe(`https://rezics.com/id/${realm}`);
    expect(sample('frame-routes').status).toBe(404);

    const page = await ZoneSiteRoute({ params: Promise.resolve({ locale: 'en', space: siteKey, path: ['browse'] }),
      searchParams: Promise.resolve({}) });
    expect(isValidElement(page)).toBe(true);
    const frame = page as ReactElement<{ view: RealmView; children: ReactNode }>;
    expect(frame.type).toBe(RealmFrame);
    const view = frame.props.view;
    expect(view.realm.realm).toBe(realm);
    expect(view.realm.zone?.id).toBe(zone);
    expect(view.realm.ref).toBe(realmSpace);
    expect(view.context.ref).toBe(addressKey(siteAddress));
    expect(view.zone.links.home).toBe(localizedPath(spaceHref(siteAddress, 'site'), 'en'));
    expect(view.zone.links.browse).toBe(localizedPath(spaceHref(siteAddress, 'site', ['browse']), 'en'));
    expect(view.zone.links.works).toBe(view.zone.links.browse);
    expect(view.zone.links.discussions).toBe(localizedPath(spaceHref(realmSpace, 'community', ['discussions']), 'en'));
    expect(view.publication).toEqual(presentation);
    const browse = find(frame.props.children, ZoneBrowse)!;
    expect(browse).not.toBeNull();
    const answer = sample('page-browse-default').answer as ZoneBrowsePage;
    expect(browse.props.model).toMatchObject({ items: answer.items.map(item => ({ id: item.id })) });
    const productionFrame = await RealmFrame({ ...frame.props, tab: null, locale: 'en', search: {} });
    expect(find(productionFrame, ZoneFrame)).not.toBeNull();
    expect(gaps).toEqual([]);
    const actor = who === 'visitor' ? undefined : (sample('frame-session-agent').answer as {
      sessionAgent: { actingSubject: string };
    }).sessionAgent.actingSubject;
    const route = requests.filter(request => request.path === `/v1/zones/${zone}/routes`);
    expect(route).toEqual([{ path: `/v1/zones/${zone}/routes`,
      query: { ...(actor ? { actingSubject: actor } : {}), path: 'browse' },
      authorization: actor ? `Bearer recorded-${who}` : null }]);
    expect(requests.filter(request => request.path === `/v1/realms/${realm}`)
      .every(request => request.authorization === null && Object.keys(request.query).length === 0)).toBe(true);
    expect(requests.filter(request => request.path === '/v1/addresses/resolve')
      .every(request => request.query.key === siteKey && request.authorization === null)).toBe(true);
    expect(requests.filter(request => request.path === `/v1/zones/${zone}/presentation`)
      .every(request => request.authorization === (actor ? `Bearer recorded-${who}` : null)
        && request.query.actingSubject === actor)).toBe(true);
    expect(requests.findIndex(request => request.path.endsWith('/routes')))
      .toBeLessThan(requests.findIndex(request => request.path.endsWith('/modules/browse')));
  });

  for (const branch of ['published', 'empty'] as const) {
    test(`${who}: the ${branch} presentation selects its recorded Realm or standalone home frame`, async () => {
      persona = who;
      record = homes as AnswerRecord;
      const prefix = `frame-${branch}`;
      const labels = record.personas[who].filter(sample => sample.label.startsWith(`${prefix}-`)
        && !sample.label.startsWith(`${prefix}-index-`) && !sample.label.includes('@')).map(sample => sample.label);
      if (branch !== 'empty') labels.push('published-home-route');
      const { requests, gaps } = replay(labels);
      const presentation = sample(`${prefix}-presentation`).answer as ZonePresentationRead;
      const siteKey = new URL(sample(`${prefix}-space-address`).path, 'https://recorded.invalid').searchParams.get('key')!;
      const page = await ZoneSiteRoute({ params: Promise.resolve({ locale: 'en', space: siteKey }),
        searchParams: Promise.resolve({}) });
      expect(isValidElement(page)).toBe(true);
      const frame = page as ReactElement<{ view: RealmView; children: ReactNode; zone: { realm: string | null } }>;
      if (branch === 'empty') {
        expect(presentation.realm).toBeNull();
        expect(frame.type).toBe(StandaloneZoneSiteFrame);
        expect(frame.props.zone.realm).toBeNull();
        expect(requests.some(request => request.path.startsWith('/v1/realms/'))).toBe(false);
      } else {
        const realm = new URL(sample(`${prefix}-realm-header`).path, 'https://recorded.invalid').pathname.split('/')[3]!;
        expect(presentation.realm).toBe(`https://rezics.com/id/${realm}`);
        expect(frame.type).toBe(RealmFrame);
        expect<unknown>(frame.props.view.realm.header).toEqual(sample(`${prefix}-realm-header`).answer);
        expect(frame.props.view.context.realm).toBe(realm);
        expect(frame.props.view.publication).toEqual(presentation);
        expect(find(frame.props.children, ZoneHomeContent)?.props.page).toEqual(presentation.home);

      }
      expect(gaps).toEqual([]);
    });
  }
}
