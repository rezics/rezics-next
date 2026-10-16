import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import ranking from '../../../../../scripts/qa/cases/outcomes/realm/ranking.ts';
import { readRankingAnswer, readRankingModuleAnswer } from '../../../../../apps/web/features/realm/ranking-read.ts';
import { recordedMainClient } from '../../../support/recorded-main-client.ts';
import { seedRealmRanking as seed } from '../../../support/realm-ranking-fixture.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import type { PersonaName, PersonaSession, PersonaSessions } from '../../../support/personas.ts';
import { realmDiscussionSource } from '../../../support/realm-discussion-source.ts';
import '../../../../../apps/web/tests/support/official-package-fixture.ts';
import { BFF_PREFIX } from '../../../../../apps/web/features/api/browser.ts';
import { mainRelationships } from '../../../../../apps/web/features/relationships/api.ts';
import { rankingVisit, rankingVisitHost, rankingChart } from '../../../../../apps/web/features/realm/ranking-visit.tsx';
import type { DiscussionQuery } from '../../../../../apps/web/features/realm/discussion-read.ts';
import { uiLocales, type UiLocale } from '../../../../../apps/web/i18n/define.ts';

type Page = {
  items: { reply: string; author: { id: string } | null; work: { id: string }; vote: { score: number } }[];
  nextCursor: string | null; count: { value: number; kind: string; total: null };
};
setDefaultTimeout(120_000);
let publicRealm: PersonaSessions, privateRealm: PersonaSessions;
const publicThreads: string[] = [], oldThreads: string[] = [], currentThreads: string[] = [];
// Admission waits pause the runner's active-work clock, not Bun's hook timer.
// RetainedSources already bounds active restore/readiness work at 600 seconds.
const source = await realmDiscussionSource(undefined, 'ranking');
const restored = await source.sources.restore(source.adapter);
let emptyRealm: string, movedRealm: string;
const recording = new OutcomeRecorder(ranking);
const coordinates = [['best', 'all'], ['top', 'week'], ['top', 'month'], ['top', 'all']] as const;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => new URLSearchParams(person.actingSubject ? { actingSubject: person.actingSubject } : {});

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
beforeAll(async () => {
  const started = performance.now();
  const copy = restored;
  publicRealm = copy.candidate.sessions.rankingPublic;
  privateRealm = copy.candidate.sessions.rankingPrivate;
  const inventory = copy.candidate.metadata.ranking;
  publicThreads.push(...inventory.public.map(item => item.reply));
  oldThreads.push(...inventory.retained.map(item => item.reply));
  currentThreads.push(...inventory.current.map(item => item.reply));
  ({ emptyRealm, movedRealm } = inventory.states);
  await recording.prepare();
  console.info('Ranking setup', JSON.stringify({ sourceKey: copy.manifest.key,
    restore: copy.candidate.preparation,
    totalMs: Math.round(performance.now() - started) }));
}, 600_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await restored?.dispose(); }
});

/** Capture the whole production visit, preserving the anonymous/personal split. */
async function captureVisit(sessions: PersonaSessions, name: PersonaName, label: string,
  query: DiscussionQuery, chart = false, locale: UiLocale = 'en') {
  let ordinal = 0;
  let refreshFollow = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (!url.pathname.startsWith(`${BFF_PREFIX}/`)) throw new Error(`Unexpected visit request: ${url.pathname}`);
    const person = request.credentials === 'omit' ? sessions.visitor : sessions[name];
    const response = await recording.session(name, person)(`${label}-${++ordinal}`, request.method,
      url.pathname.slice(BFF_PREFIX.length) + url.search, undefined, undefined,
      { headers: Object.fromEntries(request.headers.entries()), settle: false });
    if (url.pathname.startsWith(`${BFF_PREFIX}/v1/follows/`)) {
      const follow = response.ok ? await response.clone().json() as { following: boolean | null; level: string | null } : null;
      refreshFollow = !follow || follow.following === null || follow.level === null;
    }
    return response;
  }) as typeof fetch;
  const page = await rankingVisit({ replay: rankingVisitHost(fetcher, name !== 'visitor'),
    ref: short(sessions.realm), locale, query, ...(chart ? { module: rankingChart } : {}) });
  expect(page).not.toBeNull();
  expect(ordinal, `${name}/${label} must reach the production transport`).toBeGreaterThan(0);
  // The shared relationship control refreshes unknown follow levels on mount.
  if (refreshFollow && sessions[name].actingSubject) await mainRelationships(sessions[name].actingSubject!, {
    origin: `https://recorded.invalid${BFF_PREFIX}`, fetch: fetcher,
  }).state(sessions.realm, 'realm');
}

async function storyRanking(sessions: PersonaSessions, name: PersonaName,
  sort: 'best' | 'top', window: 'week' | 'month' | 'all', label: string, cursor?: string,
  expectedStatus = 200) {
  const person = sessions[name];
  const checked = { ...person, main: async (...args: Parameters<PersonaSession['main']>) => {
    const response = await person.main(...args);
    expect(response.status, `${label}: ${await response.clone().text()}`).toBe(expectedStatus);
    return response;
  } };
  return readRankingAnswer(recordedMainClient(recording, name, checked, label), {
    realm: sessions.realm, sort, window, actingSubject: sessions[name].actingSubject, ...(cursor ? { cursor } : {}),
  });
}

async function storyStates(name: PersonaName) {
  const person = publicRealm[name];
  const stateRealm = { ...publicRealm, realm: emptyRealm };
  const absentRealm = { ...publicRealm, realm: `https://rezics.com/id/${randomUUID()}` };
  for (const [sort, window] of coordinates) {
    const empty = await storyRanking(stateRealm, name, sort, window, `${sort}-${window}-empty`);
    expect(empty.ok).toBe(true);
    if (!empty.ok) throw new Error('Empty ranking read failed');
    expect(empty.data.items).toEqual([]);
    expect(empty.data.nextCursor).toBeNull();
    expect(await storyRanking(absentRealm, name, sort, window, `${sort}-${window}-missing`, undefined, 404))
      .toMatchObject({ ok: false, failure: 'missing' });
    const invalid = await storyRanking(publicRealm, name, sort, window,
      `${sort}-${window}-invalid-cursor`, 'contract:another-viewer:page-2', 400);
    expect(invalid).toMatchObject({ ok: false, failure: 'invalid' });
    await Promise.all([
      captureVisit(stateRealm, name, `visit-${sort}-${window}-empty`, { sort, window }),
      captureVisit(absentRealm, name, `visit-${sort}-${window}-missing`, { sort, window }),
      captureVisit(publicRealm, name, `visit-${sort}-${window}-invalid-cursor`, {
        sort, window, cursor: 'contract:another-viewer:page-2',
      }),
    ]);
  }
  await captureVisit(publicRealm, name, 'visit-ranking-module', { sort: 'best', window: 'all' }, true);
  await captureVisit(stateRealm, name, 'visit-ranking-module-empty', { sort: 'best', window: 'all' }, true);
  if (name === 'visitor') for (const locale of uiLocales) {
    if (locale === 'en') continue;
    await Promise.all([
      captureVisit(publicRealm, name, `visit-best-all@${locale}`, { sort: 'best', window: 'all' }, false, locale),
      captureVisit(publicRealm, name, `visit-ranking-module@${locale}`, { sort: 'best', window: 'all' }, true, locale),
    ]);
  }
  for (const interval of ['day', 'week', 'month'] as const) {
    const main = recordedMainClient(recording, name, person, `ranking-module-${interval}`);
    const populated = await readRankingModuleAnswer(main, publicRealm.realm, interval, 'reads');
    expect(populated.ok).toBe(true);
    if (!populated.ok) throw new Error('Populated ranking module read failed');
    expect(populated.data.items.length).toBeGreaterThan(0);
    expect(populated.data.nextCursor).not.toBeNull();
    // The module itself never follows this cursor; retain that separate API answer as evidence.
    const continuation = recordedMainClient(recording, name, person, `ranking-module-${interval}-continuation`);
    const continued = await continuation.v1.realms({ realm: short(publicRealm.realm) }).rankings.get({ query: {
      interval, metric: 'reads', limit: 10, cursor: populated.data.nextCursor!,
    } });
    expect(continued.response.status).toBe(200);
    expect(continued.error).toBeNull();
    if (!continued.data) throw new Error('Ranking module continuation returned no page');
    expect(continued.data.items.length).toBeGreaterThan(0);
    expect(continued.data.nextCursor).toBeNull();
    const empty = await readRankingModuleAnswer(
      recordedMainClient(recording, name, person, `ranking-module-${interval}-empty`), emptyRealm, interval, 'reads');
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.data.items).toEqual([]);
    expect(await readRankingModuleAnswer(recordedMainClient(recording, name, person,
      `ranking-module-${interval}-missing`), absentRealm.realm, interval, 'reads')).toMatchObject({ ok: false, failure: 'missing' });
  }
  const moving = { ...publicRealm, realm: movedRealm };
  const first = await storyRanking(moving, name, 'best', 'all', 'moved-basis');
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error('Moving ranking basis read failed');
  expect(first.data.nextCursor).not.toBeNull();
  const other = name === 'stranger' ? publicRealm.member : publicRealm.stranger;
  const otherParams = acting(other); otherParams.set('sort', 'best'); otherParams.set('window', 'all');
  const otherPage = await answer<Page>(other.main('GET', `/v1/realms/${short(movedRealm)}/threads?${otherParams}`));
  expect(otherPage.nextCursor).not.toBeNull();
  const stolen = await storyRanking(moving, name, 'best', 'all', 'viewer-bound-refusal', otherPage.nextCursor!, 400);
  expect(stolen).toMatchObject({ ok: false, failure: 'invalid' });
  // A committed placement advances this Realm's rank revision, invalidating the old cut.
  await seed({ ...moving, owner: publicRealm.stranger }, 1, 'next-ranked-cut');
  expect(await storyRanking(moving, name, 'best', 'all', 'moved', first.data.nextCursor!, 409))
    .toMatchObject({ ok: false, failure: 'moved' });
  await captureVisit(moving, name, 'visit-moved', { sort: 'best', window: 'all', cursor: first.data.nextCursor! });
}

async function traverse(sessions: PersonaSessions, name: PersonaName, expected: string[]) {
  const person = sessions[name], root = `/v1/realms/${short(sessions.realm)}`;
  const header = await answer<Record<string, unknown>>(person.main('GET', `${root}?${acting(person)}`));
  for (const [sort, window] of [['best', 'all'], ['top', 'week'], ['top', 'month'], ['top', 'all']]) {
    const visits: Promise<{ error?: unknown }>[] = [];
    const params = acting(person); params.set('sort', sort!); params.set('window', window!); params.set('limit', '20');
    const seen: string[] = [], scores: number[] = [], cursors = new Set<string>();
    let page: Page;
    let pageNumber = 0;
    do {
      const finalPage = (pageNumber + 1) * 20 >= expected.length;
      if (pageNumber < 2 || finalPage) {
        const prefix = sessions === privateRealm ? 'private-' : '';
        const suffix = pageNumber === 0 ? '' : finalPage ? '-continuation' : '-continuation-start';
        const recorded = await storyRanking(sessions, name, sort as 'best' | 'top',
          window as 'week' | 'month' | 'all', `${prefix}${sort}-${window}${suffix}`, params.get('cursor') ?? undefined);
        expect(recorded.ok).toBe(true);
        visits.push(captureVisit(sessions, name, `visit-${prefix}${sort}-${window}${suffix}`, {
          sort: sort as 'best' | 'top', window: window as 'week' | 'month' | 'all', cursor: params.get('cursor') ?? undefined,
        }).then(() => ({}), error => ({ error })));
        if (!recorded.ok) throw new Error('Ranked traversal read failed');
        page = recorded.data;
      } else page = await answer<Page>(person.main('GET', `${root}/threads?${params}`));
      pageNumber++;
      expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
      expect(page.items.length).toBeLessThanOrEqual(20);
      for (const item of page.items) {
        seen.push(item.reply); scores.push(item.vote.score);
        if (item.author) expect(item.author.id).toBe(sessions.owner.actingSubject!);
      }
      if (page.nextCursor) {
        expect(cursors.has(page.nextCursor)).toBe(false); cursors.add(page.nextCursor);
        params.set('cursor', page.nextCursor);
      }
      expect(cursors.size).toBeLessThan(30);
    } while (page.nextCursor);
    // At most three independent frame visits overlap the unchanged API traversal.
    for (const result of await Promise.all(visits)) if ('error' in result) throw result.error;
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...expected].sort());
    if (sort === 'top') expect(scores).toEqual([...scores].sort((left, right) => right - left));
  }
  const after = await answer<Record<string, unknown>>(person.main('GET', `${root}?${acting(person)}`));
  expect(after).toEqual(header);
}
async function prove(name: PersonaName) {
  const person = publicRealm[name];
  await answer(person.main('GET', `/v1/realms/${short(publicRealm.realm)}?${acting(person)}`));
  await traverse(publicRealm, name, publicThreads);
  if (['member', 'owner', 'moderator'].includes(name)) {
    const expected = name === 'member' ? currentThreads : [...oldThreads, ...currentThreads];
    await traverse(privateRealm, name, expected);
    const person = privateRealm[name];
    await answer(person.main('GET', `/v1/realms/${short(privateRealm.realm)}/threads/${short(oldThreads[0]!)}?${acting(person)}`),
      name === 'member' ? 404 : 200);
  } else {
    const person = privateRealm[name];
    for (const [sort, window] of [['best', 'all'], ['top', 'week'], ['top', 'month'], ['top', 'all']]) {
      const params = acting(person); params.set('sort', sort!); params.set('window', window!);
      await answer(person.main('GET', `/v1/realms/${short(privateRealm.realm)}/threads?${params}`), 404);
      expect(await storyRanking(privateRealm, name, sort as 'best' | 'top', window as 'week' | 'month' | 'all',
        `private-${sort}-${window}`, undefined, 404)).toMatchObject({ ok: false, failure: 'missing' });
      await captureVisit(privateRealm, name, `visit-private-${sort}-${window}`, {
        sort: sort as 'best' | 'top', window: window as 'week' | 'month' | 'all',
      });
    }
  }
  await storyStates(name);
  // A continuation is bound to the represented reader, not just its ranking coordinates.
  if (name !== 'visitor') {
    const person = publicRealm[name], params = acting(person); params.set('sort', 'best');
    const page = await answer<Page>(person.main('GET', `/v1/realms/${short(publicRealm.realm)}/threads?${params}`));
    expect(page.nextCursor).not.toBeNull();
    const stranger = name === 'stranger' ? publicRealm.member : publicRealm.stranger;
    const stolen = acting(stranger); stolen.set('sort', 'best'); stolen.set('cursor', page.nextCursor!);
    await answer(stranger.main('GET', `/v1/realms/${short(publicRealm.realm)}/threads?${stolen}`), 400);
  }
}

outcomeTest(ranking, 'visitor', () => prove('visitor'), recording);
outcomeTest(ranking, 'stranger', () => prove('stranger'), recording);
outcomeTest(ranking, 'member', () => prove('member'), recording);
outcomeTest(ranking, 'owner', () => prove('owner'), recording);
outcomeTest(ranking, 'moderator', () => prove('moderator'), recording);
outcomeTest(ranking, 'operator', () => prove('operator'), recording);
