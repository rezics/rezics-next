import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { browserMainApi, BFF_PREFIX } from '../../../../../apps/web/features/api/browser.ts';
import { mainLibraryApi } from '../../../../../apps/web/features/library/api.ts';
import { loadBooksLibrary } from '../../../../../apps/web/features/library/books-library-recorded-page.ts';
import { parseLibraryState } from '../../../../../apps/web/features/library/state.ts';
import { mainRelationships } from '../../../../../apps/web/features/relationships/api.ts';
import { pinnedCommunities, spaceCommunities } from '../../../../../apps/web/features/shell/communities-relationships.ts';
import tracking from '../../../../../scripts/qa/cases/outcomes/recipes/collection-tracking-and-progress.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(180_000);
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
  return async () => {
    if (name !== 'owner') {
      await answer(sample('private-collection-concealed', 'GET', `/v1/collections/${short(privateCollection.collection)}${query(person)}`), 404);
      await answer(collectionCommand(person, sample, publicCollection, 'collection-change-denied'), 403);
    } else {
      const privatePage = await answer<{ occurrences: unknown[] }>(sample('private-collection', 'GET', `/v1/collections/${short(privateCollection.collection)}${query(person)}`));
      expect(privatePage.occurrences).toHaveLength(2);
      const change = { actingSubject: person.actingSubject, expectedHead: privateCollection.revision,
        operations: [{ op: 'remove', occurrence: privateCollection.occurrences![0] }] };
      const changeKey = randomUUID();
      const changed = await answer<{ revision: string }>(collectionCommand(person, sample, privateCollection, 'collection-changed', changeKey));
      expect(await answer(sample('collection-change-replay', 'POST', `/v1/collections/${short(privateCollection.collection)}/changes`, change, changeKey)))
        .toMatchObject({ revision: changed.revision, replayed: true });
      await answer(sample('collection-change-stale', 'POST', `/v1/collections/${short(privateCollection.collection)}/changes`, change), 409);
    }
  };
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

type Sample = ReturnType<typeof recording.session>;

/** Transport only; Library owns the requests and the dependency order. */
async function libraryVisit(name: PersonaName, person: PersonaSession, sample: Sample) {
  const render = async (region: string, shelf?: string) => {
    // React's request cache shares overview, Work and resume reads during a server render.
    const reads = new Map<string, Promise<Response>>();
    // Main can refuse a duplicate-Work batch; production then reads both fixture occurrences separately.
    const occurrenceStates = ['work-state-primary-occurrence', 'work-state-repeated-occurrence'];
    let failure: unknown;
    const client = (anonymous = false) => browserMainApi('http://record.invalid', { fetcher: async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.slice(BFF_PREFIX.length);
      const names: Record<string, string> = {
        '/v1/me/shelves': 'directory',
        [`/v1/agents/${short(person.actingSubject!)}/library-visibility`]: 'visibility',
        '/v1/rating-contexts': 'rating-contexts',
        '/v1/me/shelves/status/reading/works': 'reading-preview',
        '/v1/me/shelves/status/read/works': 'read-shelf',
        '/v1/me/work-states': 'work-states',
        [`/v1/works/${short(work.work)}`]: 'work-header',
        [`/v1/me/continue/${short(work.work)}`]: 'continue',
        '/v1/me/follows/authors': 'followed-authors',
        '/v1/me/reading-goal': 'reading-goal',
        '/v1/me/reading-stats': 'reading-stats',
        [`/v1/collections/${short(publicCollection.collection)}`]: 'public-collection',
        [`/v1/collections/${short(privateCollection.collection)}`]: 'private-collection',
      };
      const singleState = path === '/v1/me/work-states' && !url.searchParams.get('works')?.includes(',');
      const customState = singleState && (region === 'library-public-view' || region === 'library-private-view');
      const label = customState ? occurrenceStates.shift() : singleState ? 'work-state' : names[path];
      if (!label) throw new Error(`Unlabelled Library request: ${path}${url.search}`);
      const request = path + url.search;
      let read = customState ? undefined : reads.get(request);
      if (!read) {
        read = (anonymous ? recording.session(name, sessions.visitor) : sample)(
          `${region}-${label}`, init?.method ?? 'GET', request).catch(error => {
            failure = error;
            throw error;
          });
        if (!customState) reads.set(request, read);
      }
      return (await read).clone();
    } });
    const main = client();
    await loadBooksLibrary({ main, anonymous: client(true), actingSubject: person.actingSubject! }, {
      state: parseLibraryState(shelf ? { shelf } : {}), locale: 'en',
      year: new Date().getUTCFullYear(), first: shelf === undefined,
    });
    if (failure) throw failure;
  };
  await Promise.all([frameVisit(name, person, sample), render('library-visit')]);
  await render('library-read-view', 'read');
  await render('library-public-view', short(publicCollection.collection));
  await render('library-private-view', short(privateCollection.collection));
}

/** The shell reads beside the page; dependent community names follow their directory. */
async function frameVisit(name: PersonaName, person: PersonaSession, sample: Sample) {
  let failure: unknown;
  const transport = (label: string, anonymous = false): typeof fetch => async (input, init) => {
    const url = new URL(String(input));
    try {
      return await (anonymous ? recording.session(name, sessions.visitor) : sample)(label,
        init?.method ?? 'GET', url.pathname.replace(BFF_PREFIX, '') + url.search, undefined, undefined,
        { headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    } catch (error) { failure = error; throw error; }
  };
  const main = (label: string, anonymous = false) => browserMainApi('http://record.invalid', {
    fetcher: transport(label, anonymous),
  });
  const relationships = (label: string) => mainRelationships(person.actingSubject!, {
    origin: 'http://record.invalid', fetch: transport(label),
  });
  const official = main('frame-official-zones', true).v1.zones.get({ query: { official: 'true', limit: 6 } })
    .then(page => Promise.all((page.data?.items.slice(0, 6) ?? []).map(zone =>
      main(`frame-official-realm-${short(zone.realm)}`, true).v1.realms({ realm: short(zone.realm) }).get())));
  await Promise.all([
    main('frame-platform-access').v1.me['platform-access'].get(),
    main('frame-type-registry', true).v1.types.get(),
    official,
    main('frame-person-preferences').v1.me['person-preferences'].get({ query: { actingSubject: person.actingSubject! } }),
    pinnedCommunities(relationships('frame-pinned-follows'), '', null).catch(() => null),
    spaceCommunities(relationships('frame-space-follows'), '', null).catch(() => null),
    relationships('frame-follow-inventory').follows().catch(() => null),
    main('frame-managed-realms').v1.me['managed-realms'].get({ query: { actingSubject: person.actingSubject! } }),
    main('frame-notification-unread-count').v1.me.notifications['unread-count'].get(),
  ]);
  if (failure) throw failure;
}

async function collectionCommand(person: PersonaSession, sample: Sample, collection: Collection,
  label: string, replayKey?: string): Promise<Response> {
  let command: Response | undefined;
  let prerequisite: Response | undefined;
  let failure: unknown;
  const main = browserMainApi('http://record.invalid', { fetcher: async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const key = method === 'POST' ? replayKey ?? new Headers(init?.headers).get('idempotency-key') ?? undefined : undefined;
    try {
      const response = await sample(method === 'GET' ? `${label}-prerequisite` : label,
        method, url.pathname.slice(BFF_PREFIX.length) + url.search, body, key);
      if (method === 'POST') command = response.clone();
      else prerequisite = response.clone();
      return response;
    } catch (error) { failure = error; throw error; }
  } });
  await mainLibraryApi(person.actingSubject!, () => main).removeFromShelf(collection.collection, [collection.occurrences![0]!]);
  if (failure) throw failure;
  if (!command) {
    throw new Error(`Collection command stopped at prerequisite: ${prerequisite?.status} ${await prerequisite?.text()}`);
  }
  return command;
}

async function within<T>(milliseconds: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Phase exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function recordedTrack(name: PersonaName) {
  const started = performance.now();
  // The existing API proof has its own 60 s deadline, before the production visit's 120 s.
  const collectionProof = await within(60_000, () => track(name));
  const proof = performance.now() - started;
  const visitStarted = performance.now();
  try {
    if (name !== 'visitor') await within(120_000, async () => {
      await libraryVisit(name, sessions[name], recording.session(name, sessions[name]));
      await collectionProof?.();
    });
  } finally {
    console.info(`${name}: proof ${(proof / 1000).toFixed(3)}s; visit ${((performance.now() - visitStarted) / 1000).toFixed(3)}s`);
  }
}

outcomeTest(tracking, 'visitor', () => recordedTrack('visitor'), recording);
outcomeTest(tracking, 'stranger', () => recordedTrack('stranger'), recording);
outcomeTest(tracking, 'member', () => recordedTrack('member'), recording);
outcomeTest(tracking, 'owner', () => recordedTrack('owner'), recording);
outcomeTest(tracking, 'moderator', () => recordedTrack('moderator'), recording);
outcomeTest(tracking, 'operator', () => recordedTrack('operator'), recording);
