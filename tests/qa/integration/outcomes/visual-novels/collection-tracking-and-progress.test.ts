import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import collection from '../../../../../scripts/qa/cases/outcomes/visual-novels/collection-tracking-and-progress.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
let sessions: PersonaSessions;
const pairs = new Map<PersonaName, string[]>();
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
beforeAll(async () => {
  sessions = await personaSessions('public');
  const owner = sessions.owner;
  const actingSubject = owner.actingSubject;
  for (const name of ['visitor', 'member', 'owner'] as const) {
    const pair: string[] = [];
    for (let index = 0; index < 2; index++) {
      const work = await answer<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
        profile: 'metadata-only-v1', title: `Orchard Choices ${name} ${index}`, language: 'en',
        semanticTypes: ['https://schema.org/VideoGame'], authoring: 'own-work', actingSubject,
      }), 201);
      const draft = await answer<{ contribution: string; draftRevision: string }>(owner.main('POST', '/v1/contributions', {
        profile: 'text-contribution-v1', work: work.work, language: 'en',
        body: `An original partless visual novel: gardener ${index} chooses a path through an orchard.`, actingSubject,
      }), 201);
      const publication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
      }), 201);
      await answer(owner.main('POST', '/v1/publication-selections', {
        profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
        work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject,
      }), 201);
      pair.push(work.work);
    }
    pairs.set(name, pair);
  }
  for (const name of ['stranger', 'moderator', 'operator'] as const) pairs.set(name, pairs.get('visitor')!);
}, 180_000);
afterAll(async () => { await sessions?.close(); });
type State = { status: { work: string; status: string | null; version: number; changedAt: string | null }; progress: unknown };
type Mark = { standing: string; version: number; replayed?: boolean };
const state = (person: PersonaSession, work: string) => answer<State>(person.main('GET', `/v1/works/${short(work)}/reader-state?${query(person)}`));
const mark = (person: PersonaSession, work: string) => answer<Mark>(person.main('GET', `/v1/works/${short(work)}/progress?${query(person)}`));
const status = (person: PersonaSession, work: string, value: string | null, version: number) => answer(person.main('PUT', `/v1/works/${short(work)}/reader-status`, { actingSubject: person.actingSubject, status: value, expectedVersion: version }));
const progress = (person: PersonaSession, work: string, standing: string, expectedVersion: number, key?: string) => answer<Mark>(person.main('PUT', `/v1/works/${short(work)}/progress`, { actingSubject: person.actingSubject, standing, expectedVersion }, key));
async function shelf(person: PersonaSession, selected: string[]) {
  const params = new URLSearchParams({ actingSubject: person.actingSubject!, sort: 'last-read', order: 'desc', limit: '1' });
  const seen: string[] = [];
  let page: { items: Array<{ work: string }>; nextCursor: string | null };
  do {
    page = await answer(person.main('GET', `/v1/me/shelves/status/reading/works?${params}`));
    seen.push(...page.items.map(item => item.work));
    if (page.nextCursor) params.set('cursor', page.nextCursor);
  } while (page.nextCursor);
  return seen.filter(work => selected.includes(work));
}

async function foreign(name: PersonaName) {
  const person = sessions[name];
  const victim = name === 'owner' ? sessions.member : sessions.owner;
  const [work, other] = pairs.get(name)! as [string, string];
  for (const id of [work, other]) {
    await status(victim, id, 'reading', (await state(victim, id)).status.version);
    await progress(victim, id, 'started', (await mark(victim, id)).version);
  }
  const before = await state(victim, work);
  const victimMark = await mark(victim, work);
  const shelvesBefore = await answer(victim.main('GET', `/v1/me/shelves?${query(victim)}`));
  const ownMark = await mark(person, work);
  expect(await shelf(victim, [work, other])).toEqual([other, work]);
  await answer(person.main('GET', `/v1/works/${short(work)}/reader-state?${query(victim)}`), 403);
  await answer(person.main('PUT', `/v1/works/${short(work)}/reader-status`, { actingSubject: victim.actingSubject, expectedVersion: 1, status: 'read' }), 403);
  // Standing belongs to the principal. A foreign subject must never project that principal's mark into the victim's library.
  const read = await person.main('GET', `/v1/works/${short(work)}/progress?${query(victim)}`);
  if (read.status === 200) expect(await read.json()).toMatchObject({ standing: ownMark.standing, version: ownMark.version });
  else expect(read.status).toBe(403);
  const write = await person.main('PUT', `/v1/works/${short(work)}/progress`, { actingSubject: victim.actingSubject, expectedVersion: ownMark.version, standing: 'completed' });
  expect([200, 403]).toContain(write.status);
  await write.body?.cancel();
  expect(await state(victim, work)).toEqual(before);
  expect(await mark(victim, work)).toEqual(victimMark);
  expect(await answer(victim.main('GET', `/v1/me/shelves?${query(victim)}`))).toEqual(shelvesBefore);
  expect(await shelf(victim, [work, other])).toEqual([other, work]);
}

async function track(name: PersonaName) {
  const person = sessions[name];
  const work = pairs.get(name)![0]!;
  const root = `/v1/works/${short(work)}`;
  if (name === 'visitor') {
    expect(await answer(person.main('GET', `${root}/reader-state`))).toMatchObject({ status: { status: null, version: 0, changedAt: null }, progress: null });
    await answer(person.main('PUT', `${root}/reader-status`, { actingSubject: sessions.owner.actingSubject, status: 'reading', expectedVersion: 0 }), 401);
    await answer(person.main('GET', `${root}/progress?${query(sessions.owner)}`), 401);
    await answer(person.main('PUT', `${root}/progress`, { actingSubject: sessions.owner.actingSubject, expectedVersion: 0, standing: 'started' }), 401);
    expect((await state(sessions.owner, work)).status).toMatchObject({ status: null, version: 0 });
    return;
  }
  if (['stranger', 'moderator', 'operator'].includes(name)) return foreign(name);
  expect((await state(person, work)).status).toMatchObject({ status: null, version: 0 });
  let version = 0;
  for (const value of ['want-to-read', 'reading', 'read', null]) {
    expect(await status(person, work, value, version++)).toMatchObject({ status: value, version });
    expect((await state(person, work)).status).toMatchObject({ status: value, version });
    if (value) {
      const shelves = await answer<{ statusShelves: Array<{ status: string; count: number }> }>(person.main('GET', `/v1/me/shelves?${query(person)}`));
      expect(shelves.statusShelves.find(item => item.status === value)!.count).toBeGreaterThanOrEqual(1);
      const savedWorks = await answer<{ items: Array<{ work: string }> }>(person.main('GET', `/v1/me/shelves/status/${value}/works?${query(person)}`));
      expect(savedWorks.items).toContainEqual(expect.objectContaining({ work }));
    }
  }
  expect(await mark(person, work)).toMatchObject({ parts: false, standing: 'not-started', version: 0 });
  let markVersion = 0;
  for (const standing of ['started', 'completed', 'not-started', 'dropped']) {
    const key = randomUUID();
    const saved = await progress(person, work, standing, markVersion, key);
    expect(saved).toMatchObject({ standing, version: ++markVersion });
    expect(await progress(person, work, standing, markVersion - 1, key)).toMatchObject({ ...saved, replayed: true });
    expect(await mark(person, work)).toMatchObject({ standing, version: markVersion });
  }
  expect(await answer(person.main('GET', `/v1/me/progress-summaries/${short(work)}?${query(person)}`))).toMatchObject({ status: 'dropped' });
  if (name === 'owner') await foreign(name);
}

outcomeTest(collection, 'visitor', () => track('visitor'));
outcomeTest(collection, 'stranger', () => track('stranger'));
outcomeTest(collection, 'member', () => track('member'));
outcomeTest(collection, 'owner', () => track('owner'));
outcomeTest(collection, 'moderator', () => track('moderator'));
outcomeTest(collection, 'operator', () => track('operator'));
