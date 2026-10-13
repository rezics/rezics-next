import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import tracking from '../../../../../scripts/qa/cases/outcomes/recipes/collection-tracking-and-progress.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(tracking);
let work: { work: string; mainVersion: string };
type Collection = { collection: string; structure: string; revision: string; occurrences?: string[] };
let publicCollection: Collection;
let privateCollection: Collection;
const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession) => person.actingSubject
  ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

beforeAll(async () => {
  sessions = await personaSessions('private');
  await recording.prepare();
  const owner = sessions.owner;
  work = await answer(owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Original whole-recipe tracking fixture', language: 'en',
    semanticTypes: ['https://schema.org/Recipe'], authoring: 'own-work', actingSubject: owner.actingSubject,
  }), 201);
  const composition = await answer<{ structure: string; revision: string }>(owner.main('POST', '/v1/compositions', {
    profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: owner.actingSubject,
  }), 201);
  const head = await answer<{ revision: string }>(owner.main('GET', `/v1/works/${short(work.work)}/scalar-value${query(owner)}`));
  await answer(owner.main('POST', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'publish', work: work.work,
    actingSubject: owner.actingSubject, expectedWorkHead: head.revision, expectedMainVersion: work.mainVersion,
    structure: composition.structure, expectedStructureHead: composition.revision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
  }), 201);
  for (const disclosure of ['public', 'private'] as const) {
    let collection = await answer<Collection>(owner.main('POST', '/v1/collections', {
      collection: `https://rezics.com/id/${randomUUID()}`, name: `${disclosure} recipe collection`,
      disclosure, actingSubject: owner.actingSubject,
    }), 201);
    collection = await answer<Collection>(owner.main('POST', `/v1/collections/${short(collection.collection)}/changes`, {
      expectedHead: collection.revision, actingSubject: owner.actingSubject,
      operations: [0, 1].map(() => ({ op: 'insert', parent: collection.structure, position: 'last',
        role: 'member', target: work.work, selection: { mode: 'follow-context' } })),
    }));
    if (disclosure === 'public') publicCollection = collection;
    else privateCollection = collection;
  }
}, 180_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});

async function track(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  if (name === 'owner') await libraryReads(sample);
  const path = `/v1/works/${short(work.work)}`;
  const publicPage = await answer<{ occurrences: { target: string; occurrence: string }[] }>(
    sample('public-collection', 'GET', `/v1/collections/${short(publicCollection.collection)}${query(person)}`));
  expect(publicPage.occurrences.map(item => item.target)).toEqual([work.work, work.work]);
  expect(new Set(publicPage.occurrences.map(item => item.occurrence)).size).toBe(2);
  type State = { status: { status: string | null; version: number }; customShelves: unknown[]; progress: unknown };
  const state = await answer<State>(sample('reader-state-empty', 'GET', `${path}/reader-state${query(person)}`));
  expect(state.status).toMatchObject({ status: null, version: 0 });
  if (name === 'owner') {
    expect(state.customShelves).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: privateCollection.collection, disclosure: 'private' }),
      expect.objectContaining({ id: publicCollection.collection, disclosure: 'public' }),
    ]));
  } else expect(state.customShelves).toEqual([]);
  if (name === 'visitor') {
    expect(state.progress).toBeNull();
    await answer(sample('progress-authentication-required', 'GET', `${path}/progress${query(sessions.owner)}`), 401);
    await answer(sample('progress-write-authentication-required', 'PUT', `${path}/progress`, {
      actingSubject: sessions.owner.actingSubject, expectedVersion: 0, standing: 'started',
    }), 401);
    await answer(sample('private-collection-concealed', 'GET', `/v1/collections/${short(privateCollection.collection)}`), 404);
    return;
  }
  const initial = await answer<{ parts: boolean; standing: string; version: number }>(sample('progress-empty', 'GET', `${path}/progress${query(person)}`));
  expect(initial).toMatchObject({ parts: false, standing: 'not-started', version: 0 });
  const command = { actingSubject: person.actingSubject, expectedVersion: 0, standing: 'started' };
  const key = randomUUID();
  expect(await answer(sample('progress-started', 'PUT', `${path}/progress`, command, key))).toMatchObject({ standing: 'started', version: 1 });
  expect(await answer(sample('progress-replay', 'PUT', `${path}/progress`, command, key))).toMatchObject({ standing: 'started', version: 1, replayed: true });
  expect(await answer<{ code: string }>(sample('progress-stale', 'PUT', `${path}/progress`, {
    ...command, standing: 'completed',
  }), 409)).toMatchObject({ code: 'stale_progress' });
  expect(await answer(sample('progress-readback', 'GET', `${path}/progress${query(person)}`))).toMatchObject({ standing: 'started', version: 1 });
  expect(await answer(sample('reader-status-reading', 'PUT', `${path}/reader-status`, {
    actingSubject: person.actingSubject, expectedVersion: 0, status: 'reading',
  }))).toMatchObject({ status: 'reading', version: 1 });
  const ownState = await answer<State>(sample('reader-state-reading', 'GET', `${path}/reader-state${query(person)}`));
  expect(ownState.status).toMatchObject({ status: 'reading', version: 1 });
  const shelves = await answer<{ statusShelves: { status: string; count: number }[] }>(sample('shelves', 'GET', `/v1/me/shelves${query(person)}`));
  expect(shelves.statusShelves).toContainEqual(expect.objectContaining({ status: 'reading', count: 1 }));
  const peer = name === 'owner' ? sessions.member : sessions.owner;
  await answer(sample('peer-reader-state-denied', 'GET', `${path}/reader-state${query(peer)}`), 403);
  await answer(sample('peer-reader-status-denied', 'PUT', `${path}/reader-status`, {
    actingSubject: peer.actingSubject, expectedVersion: 0, status: 'read',
  }), 403);
  await answer(sample('peer-shelves-denied', 'GET', `/v1/me/shelves${query(peer)}`), 403);
  await answer(sample('peer-progress-summary-denied', 'GET', `/v1/me/progress-summaries/${short(work.work)}${query(peer)}`), 403);
  if (name !== 'owner') {
    await answer(sample('private-collection-concealed', 'GET', `/v1/collections/${short(privateCollection.collection)}${query(person)}`), 404);
    await answer(sample('collection-change-denied', 'POST', `/v1/collections/${short(publicCollection.collection)}/changes`, {
      actingSubject: person.actingSubject, expectedHead: publicCollection.revision,
      operations: [{ op: 'remove', occurrence: publicCollection.occurrences![0] }],
    }), 403);
  } else {
    const privatePage = await answer<{ occurrences: unknown[] }>(sample('private-collection', 'GET', `/v1/collections/${short(privateCollection.collection)}${query(person)}`));
    expect(privatePage.occurrences).toHaveLength(2);
    const change = { actingSubject: person.actingSubject, expectedHead: privateCollection.revision,
      operations: [{ op: 'remove', occurrence: privateCollection.occurrences![0] }] };
    const changeKey = randomUUID();
    const changed = await answer<{ revision: string }>(sample('collection-changed', 'POST', `/v1/collections/${short(privateCollection.collection)}/changes`, change, changeKey));
    expect(await answer(sample('collection-change-replay', 'POST', `/v1/collections/${short(privateCollection.collection)}/changes`, change, changeKey)))
      .toMatchObject({ revision: changed.revision, replayed: true });
    await answer(sample('collection-change-stale', 'POST', `/v1/collections/${short(privateCollection.collection)}/changes`, change), 409);
  }
}

// The Library's custom and status shelves render these reads alongside Collection and reader state.
async function libraryReads(sample: ReturnType<typeof recording.session>) {
  const person = sessions.owner, actor = person.actingSubject!;
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(actor)}`;
  await answer(sample('library-work-header', 'GET', viewer(`/v1/works/${short(work.work)}`)));
  await answer(sample('library-visibility', 'GET', `/v1/agents/${short(actor)}/library-visibility`));
  await answer(sample('library-rating-contexts', 'GET', '/v1/rating-contexts?scope=global&limit=1'));
  await answer(sample('library-work-states', 'GET', viewer(`/v1/me/work-states?works=${encodeURIComponent(work.work)}`)));
  await answer(sample('library-status-shelf-empty', 'GET', viewer('/v1/me/shelves/status/read/works?sort=added&order=desc&limit=20')));
  await answer(sample('library-continue-empty', 'GET', viewer(`/v1/me/continue/${short(work.work)}`)));
  await answer(sample('library-followed-authors-empty', 'GET', viewer('/v1/me/follows/authors')));
  const year = new Date().getUTCFullYear();
  await answer(sample('library-reading-goal', 'GET', viewer(`/v1/me/reading-goal?year=${year}`)));
  await answer(sample('library-reading-stats', 'GET', viewer(`/v1/me/reading-stats?year=${year}`)));
  await answer(sample('library-private-reviews-empty', 'GET', viewer(`/v1/me/import-reviews?works=${encodeURIComponent(work.work)}`)));
  await answer(sample('progress-summary-empty', 'GET', viewer(`/v1/me/progress-summaries/${short(work.work)}?language=en`)));
}

outcomeTest(tracking, 'visitor', () => track('visitor'), recording);
outcomeTest(tracking, 'stranger', () => track('stranger'), recording);
outcomeTest(tracking, 'member', () => track('member'), recording);
outcomeTest(tracking, 'owner', () => track('owner'), recording);
outcomeTest(tracking, 'moderator', () => track('moderator'), recording);
outcomeTest(tracking, 'operator', () => track('operator'), recording);
