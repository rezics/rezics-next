import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import '../../tests/support/official-package-fixture.ts';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import manga from '../../../../tests/qa/fixtures/outcomes/manga/catalogue-browse-and-search-in-its-zone.json';
import { ACCESS_COOKIE, SESSION_KEY_COOKIE } from '../auth/cookies.ts';
import { addressKey, spaceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import type { RealmView } from '../realm/realm-page.tsx';
import type { ZoneBrowsePage, ZonePresentationRead } from '../realm/types.ts';

const record = manga as AnswerRecord;
// These identities belong together to the canonical-key recording.
const realm = '01a137cb-bd72-774d-9b57-e048179e856d';
const zone = '777d533e-408a-8f2c-8aa7-47a56f2df0a4';
const siteKey = '1Cg1BFuSog8nCaEwJY4TrN';
const realmSpace = '01a137cb-bc52-74bb-b11e-91c466ef45fe';
let persona: AnswerPersona = 'visitor';
const host = { ...(await import('next/headers')) };
void mock.module('next/headers', () => ({ ...host,
  cookies: async () => ({ get: (name: string) => persona === 'visitor' ? undefined
    : name === ACCESS_COOKIE ? { value: `recorded-${persona}` }
      : name === SESSION_KEY_COOKIE ? { value: '00000000-0000-4000-8000-000000000001' } : undefined }),
  headers: async () => new Headers(),
}));
const api = { ...(await import('../api/main.ts')) };
let fetcher: typeof fetch;
void mock.module('../api/main.ts', () => ({ ...api,
  mainApiWithToken: (token: string | undefined) => api.mainApiWithToken(token, { fetcher }),
}));
const { ZoneSiteRoute } = await import('./site-route.tsx');
const { RealmFrame } = await import('../realm/realm-page.tsx');
const { ZoneBrowse } = await import('./browse.tsx');
const { ZoneFrame } = await import('./zone-frame.tsx');
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
afterAll(async () => {
  await mock.module('../api/main.ts', () => api);
  await mock.module('next/headers', () => host);
});

function sample(label: string) {
  const found = record.personas[persona].find(answer => answer.label === label);
  if (!found) throw new Error(`Missing supporting attached Realm sample: ${record.row}/${persona}/${label}`);
  return found;
}

function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) return node.map(child => find(child, type)).find(Boolean) ?? null;
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  return node.type === type ? node as ReactElement<Record<string, unknown>> : find(node.props.children, type);
}

for (const who of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
  test(`${who}: a Zone-only address selects the attached Realm browse chain and canonical site links`, async () => {
    persona = who;
    const labels = ['frame-address', 'frame-presentation', 'frame-routes', 'frame-realm-header',
      'frame-facets', 'page-browse-default', ...(who === 'visitor' ? [] : ['frame-session-agent',
        'frame-person-preferences', 'frame-joining', 'frame-follow', 'frame-platform-access'])];
    const replay = recordedFetch(record, who, labels.map(label => ({ label,
      state: sample(label).status >= 400 ? 'error' : 'populated' })));
    disposals.push(replay.dispose);
    const requests: { path: string; query: Record<string, string>; authorization: string | null }[] = [];
    const gaps: string[] = [];
    fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams),
        authorization: request.headers.get('authorization') });
      try { return await replay.fetcher(input, init); }
      catch (error) { gaps.push(String(error)); throw error; }
    }) as typeof fetch;
    const escaped = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(fetcher, {
      preconnect: globalThis.fetch.preconnect,
    }));
    disposals.push(() => escaped.mockRestore());
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
}
