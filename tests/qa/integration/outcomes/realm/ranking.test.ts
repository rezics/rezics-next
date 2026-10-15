import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import ranking from '../../../../../scripts/qa/cases/outcomes/realm/ranking.ts';
import { readRankingAnswer, readRankingModuleAnswer } from '../../../../../apps/web/features/realm/ranking-read.ts';
import { recordedMainClient } from '../../../support/recorded-main-client.ts';
import { publishClosureOriginals, type ClosureOriginal } from './closure-original-credit-setup.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import type { PersonaName, PersonaSession, PersonaSessions } from '../../../support/personas.ts';
import { realmDiscussionSource } from '../../../support/realm-discussion-source.ts';

type Work = { work: string; workRevision: string; mainVersion: string };
type Draft = { revisionId: string; revisionDigest: string };
type Page = {
  items: { reply: string; author: { id: string } | null; work: { id: string }; vote: { score: number } }[];
  nextCursor: string | null; count: { value: number; kind: string; total: null };
};
setDefaultTimeout(420_000);
let publicRealm: PersonaSessions, privateRealm: PersonaSessions;
const publicThreads: string[] = [], oldThreads: string[] = [], currentThreads: string[] = [];
let restored: { dispose(): Promise<void> } | undefined;
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
async function seedCommand(person: PersonaSession, target: Work, path: string, input: unknown) {
  const key = randomUUID();
  for (let attempt = 0; ; attempt++) {
    const response = await person.main('POST', path, input, key);
    if (response.status !== 409 || attempt === 24) {
      if (!response.ok) console.info('Pending ranking population command', {
        method: 'POST', path, status: response.status, request: input,
        answer: await response.clone().json(),
      });
      return response;
    }
    const problem = await response.clone().json() as { code: string };
    if (problem.code !== 'read_basis_changed') return response;
    // Restart the public read basis; a receipt race does not change this
    // command's key, credited author or exact intended root revision.
    await answer(person.main('GET', `/v1/works/${short(target.work)}?${acting(person)}`));
  }
}
async function publishRoot(sessions: PersonaSessions, target: Work) {
  const person = sessions.owner, author = person.actingSubject!;
  // Ranking readers need a public root; Realm membership governs its discussion separately.
  const contribution = await answer<{ contribution: string; draftRevision: string }>(person.main('POST', '/v1/contributions', {
    profile: 'text-contribution-v1', work: target.work, language: 'en',
    body: 'An original essay about the ranking discussion garden.', actingSubject: author }), 201);
  const publication = await answer<{ publicationDecision: string }>(person.main('POST', '/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: contribution.contribution,
    expectedDraftHead: contribution.draftRevision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: author }), 201);
  await answer(person.main('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', work: target.work, contribution: contribution.contribution,
    publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
    context: { kind: 'main-version-default', id: target.mainVersion }, selectionBasis: 'main-maintainer',
    actingSubject: author }), 201);
}
async function seed(sessions: PersonaSessions, size: number, label: string) {
  const person = sessions.owner, author = person.actingSubject!;
  const target = await answer<Work>(person.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: `Original ${label} ranking garden`, language: 'en',
    authoring: 'own-work', actingSubject: author }), 201);
  await publishRoot(sessions, target);
  const replies: string[] = [];
  const create = async (index: number) => {
    const reply = `https://rezics.com/id/${randomUUID()}`, variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = await answer<Draft>(seedCommand(person, target, '/v1/member-reply-drafts', {
      profile: 'member-reply-draft-v1', reply, variantId, rootTarget: target.work,
      rootRevision: target.workRevision, originRealm: sessions.realm, language: 'en', direction: 'ltr',
      expectedHead: null, body: `Original ${label} thread ${index}\nA synthetic discussion authored for this ranking proof.`,
      actingSubject: author }), 201);
    await answer(seedCommand(person, target, '/v1/realm-replies', {
      profile: 'realm-reply-identity-v1', reply, variantId, revisionId: draft.revisionId,
      author, rootTarget: target.work, rootRevision: target.workRevision,
      parentReply: null, parentRevision: null, contextRevision: null }), 201);
    await answer(seedCommand(person, target, '/v1/realm-reply-placements', {
      profile: 'realm-reply-placement-v1', realm: sessions.realm, reply,
      revisionId: draft.revisionId, revisionDigest: draft.revisionDigest,
      reviewDecisionId: null, expectedHead: null, actingSubject: author }), 201);
    return reply;
  };
  for (let start = 0; start < size; start += 8) {
    const results = await Promise.allSettled(Array.from({ length: Math.min(8, size - start) },
      (_, offset) => create(start + offset)));
    replies.push(...results.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    }));
  }
  return replies;
}
beforeAll(async () => {
  const started = performance.now();
  const { sources, adapter } = await realmDiscussionSource();
  const copy = await sources.restore(adapter);
  restored = copy;
  publicRealm = copy.candidate.sessions.rankingPublic;
  privateRealm = copy.candidate.sessions.rankingPrivate;
  const inventory = copy.candidate.metadata.ranking;
  publicThreads.push(...inventory.public.map(item => item.reply));
  oldThreads.push(...inventory.retained.map(item => item.reply));
  currentThreads.push(...inventory.current.map(item => item.reply));
  await recording.prepare();
  const founder = publicRealm.stranger;
  for (const state of ['empty', 'moved'] as const) {
    const created = await answer<{ realm: string }>(founder.main('POST', '/v1/spaces', {
      profile: 'space-realm-v2', name: `Original ${state} ranking garden`, language: 'en',
      handle: `ranking-${randomUUID().slice(0, 12)}`, capabilities: ['realm'], actingSubject: founder.actingSubject,
      initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open',
        whoMaySubmit: 'members', selfJoin: false, rules: [] },
    }), 201);
    if (state === 'empty') emptyRealm = created.realm;
    else movedRealm = created.realm;
  }
  await seed({ ...publicRealm, owner: publicRealm.stranger, realm: movedRealm }, 21, 'moving');
  // Whole-Work progress is the public source of the chart's reads metric.
  // Twelve adopted originals give its limit=10 request a real continuation.
  const originals: ClosureOriginal[] = [];
  await publishClosureOriginals(publicRealm, originals, `Rankinggarden${randomUUID().replaceAll('-', '')}`, 12);
  for (const original of originals) await answer(publicRealm.owner.main('PUT',
    `/v1/works/${short(original.work)}/progress`, {
      actingSubject: publicRealm.owner.actingSubject, expectedVersion: 0, standing: 'started',
    }));
  console.info('Ranking setup', JSON.stringify({ sourceKey: copy.manifest.key,
    restore: copy.candidate.preparation,
    totalMs: Math.round(performance.now() - started) }));
}, 600_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await restored?.dispose(); }
});

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
}

async function traverse(sessions: PersonaSessions, name: PersonaName, expected: string[]) {
  const person = sessions[name], root = `/v1/realms/${short(sessions.realm)}`;
  const header = await answer<Record<string, unknown>>(person.main('GET', `${root}?${acting(person)}`));
  for (const [sort, window] of [['best', 'all'], ['top', 'week'], ['top', 'month'], ['top', 'all']]) {
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
