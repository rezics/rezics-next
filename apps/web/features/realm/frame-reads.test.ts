import { afterEach, expect, spyOn, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import manga from '../../../../tests/qa/fixtures/outcomes/manga/catalogue-browse-and-search-in-its-zone.json';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { readPublishedRealmHeader, realmFrameReads } from './read.ts';

const record = manga as AnswerRecord;
const realm = '01a13738-258e-75fc-8fad-9632795f42a6';
const zone = '88e711d2-e971-8847-8f2d-11979aee1101';
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(persona: AnswerPersona, label: string) {
  const answer = record.personas[persona].find(item => item.label === label);
  if (!answer) throw new Error(`Missing supporting frame sample: ${record.row}/${persona}/${label}`);
  return answer;
}

function transport(persona: AnswerPersona, selections: RecordedSelection[], anonymous: boolean) {
  const replay = recordedFetch(record, persona, selections);
  disposals.push(replay.dispose);
  const requests: { path: string; query: Record<string, string>; authorization: string | null }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(request.method).toBe('GET');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: request.headers.get('authorization') });
    return replay.fetcher(input, init);
  }) as typeof fetch;
  return { main: treaty<MainApp>('https://recorded.invalid', { fetcher, parseDate: false,
    headers: anonymous ? {} : { authorization: `Bearer recorded-${persona}` } }), requests };
}

const publicSelections: RecordedSelection[] = [
  { label: 'frame-realm-header', state: 'populated' },
  { label: 'frame-facets', state: 'populated' },
  { label: 'frame-address', state: 'populated' },
];
const personalSelections: RecordedSelection[] = [
  { label: 'frame-presentation', state: 'populated' },
  { label: 'frame-routes', state: 'error' },
];

for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
  test(`${persona}: the shared production factory uses exact public and personal frame reads`, async () => {
    const escapedFetch = Object.assign(async () => {
      throw new Error('A frame read escaped its supplied client');
    }, { preconnect: globalThis.fetch.preconnect });
    const escaped = spyOn(globalThis, 'fetch').mockImplementation(escapedFetch);
    disposals.push(() => escaped.mockRestore());
    const actor = persona === 'visitor' ? undefined : (sample(persona, 'frame-session-agent').answer as {
      sessionAgent: { actingSubject: string };
    }).sessionAgent.actingSubject;
    const published = transport(persona, publicSelections, true);
    const personal = transport(persona, personalSelections, persona === 'visitor');
    const reads = realmFrameReads({ main: published.main, personal: personal.main, actingSubject: actor });
    const header = await reads.readRealmHeader(realm);
    const facets = await reads.readFacets();
    const address = await reads.readAddress(zone, 'en');
    expect<unknown>(header).toEqual({ ok: true, data: sample(persona, 'frame-realm-header').answer });
    expect<unknown>(facets).toEqual({ ok: true, data: sample(persona, 'frame-facets').answer });
    expect<unknown>(address).toEqual({ kind: 'resolved', data: sample(persona, 'frame-address').answer });
    // A site with no Realm capability remains a site; it does not invent a Realm or private fallback.
    expect<unknown>(await reads.resolveSite(zone, 'en')).toEqual({ kind: 'site',
      address: sample(persona, 'frame-address').answer, zone, realm: null });
    expect(await reads.resolveRealm(zone, 'en')).toEqual({ kind: 'missing' });
    expect<unknown>(await reads.readCompletePresentation(zone)).toEqual({ ok: true,
      data: sample(persona, 'frame-presentation').answer });
    const refused = await reads.readZoneRoute(zone, 'browse');
    expect<unknown>(refused).toEqual({ ok: false, failure: 'missing', status: 404,
      problem: sample(persona, 'frame-routes').answer });
    expect(published.requests).toEqual([
      { path: `/v1/realms/${realm}`, query: {}, authorization: null },
      { path: `/v1/facets`, query: {}, authorization: null },
      ...Array.from({ length: 3 }, () => ({ path: `/v1/addresses/resolve`,
        query: { scope: 'space', key: zone }, authorization: null })),
    ]);
    expect(personal.requests).toEqual([
      { path: `/v1/zones/${zone}/presentation`, query: actor ? { actingSubject: actor } : {},
        authorization: actor ? `Bearer recorded-${persona}` : null },
      { path: `/v1/zones/${zone}/routes`, query: { ...(actor ? { actingSubject: actor } : {}), path: 'browse' },
        authorization: actor ? `Bearer recorded-${persona}` : null },
    ]);
    expect(escaped).not.toHaveBeenCalled();
  });
}

test('the rules header adapter uses the same anonymous query and unchanged recorded answer', async () => {
  const published = transport('visitor', [publicSelections[0]!], true);
  expect<unknown>(await readPublishedRealmHeader(published.main, realm)).toEqual({ ok: true,
    data: sample('visitor', 'frame-realm-header').answer });
  expect(published.requests).toEqual([
    { path: `/v1/realms/${realm}`, query: {}, authorization: null },
  ]);
});

test('missing exact continuation samples remain named gaps and keep the supplied opaque value', async () => {
  const published = transport('visitor', [], true);
  const personal = transport('visitor', personalSelections, true);
  const reads = realmFrameReads({ main: published.main, personal: personal.main });
  const continuation = 'opaque/+cursor==';
  await expect(reads.readPresentation(zone, continuation)).rejects.toThrow('Unmatched recorded request');
  await expect(reads.readZoneRoute(zone, 'browse', continuation)).rejects.toThrow('Unmatched recorded request');
  expect(personal.requests.map(request => request.query)).toEqual([
    { after: continuation }, { path: 'browse', cursor: continuation },
  ]);
  expect(published.requests).toEqual([]);
});
