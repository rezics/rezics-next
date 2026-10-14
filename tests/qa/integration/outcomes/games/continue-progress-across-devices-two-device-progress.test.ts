import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { BFF_PREFIX, browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { loadBooksLibrary } from '../../../../../apps/web/features/library/books-library-recorded-page.ts';
import { mainRelationships } from '../../../../../apps/web/features/relationships/api.ts';
import { pinnedCommunities, spaceCommunities } from '../../../../../apps/web/features/shell/communities-relationships.ts';
import { parseLibraryState } from '../../../../../apps/web/features/library/state.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { followHref } from '../../../../../apps/web/features/entity-page/href.ts';
import { mainTrackingApi } from '../../../../../apps/web/features/tracking/api.ts';
import { booksEditionReads } from '../../../../../apps/web/features/work-page/books-edition-page.read.ts';
import { readAnimeReaderState, readResourcePage } from '../../../../../apps/web/features/work-page/anime-hub-recorded-page.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { signIn } from '../../../../../scripts/lib/oauth-client.ts';
import { outcomeResponse } from '../../../support/outcome-test.ts';
import declaration from '../../../../../scripts/qa/cases/outcomes/games/continue-progress-across-devices-two-device-progress.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(215_000);
const proofDeadlineMs = 90_000; // The original outcome proof owns these 90 seconds.
const visitDeadlineMs = 120_000;
const fileWall = setTimeout(() => { throw new Error('Games record file exceeded 480 s'); }, 480_000);
type Work = { work: string; mainVersion: string };
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(declaration);
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => person.actingSubject
  ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
// Fixture refusal is a setup failure, never an expected pending outcome.
async function fixture<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  if (response.status !== status) throw new Error(`Fixture HTTP ${response.status}: ${raw}`);
  return JSON.parse(raw) as T;
}
async function createGame(title: string, semanticType = 'VideoGame'): Promise<Work> {
  return fixture<Work>(sessions.owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en',
    description: { value: 'An original game about planting lights in a synthetic garden.', language: 'en' },
    semanticTypes: [`https://schema.org/${semanticType}`],
    authoring: 'own-work', actingSubject: sessions.owner.actingSubject,
  }), 201);
}
async function publish(game: Work) {
  const owner = sessions.owner;
  const draft = await fixture<{ contribution: string; draftRevision: string }>(
    owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: game.work, language: 'en',
      body: 'Original fixture game: plant a light, visit the garden, and find a new route.',
      actingSubject: owner.actingSubject,
    }), 201);
  const published = await fixture<{ publicationDecision: string }>(
    owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: owner.actingSubject,
    }), 201);
  const selection = { work: game.work, contribution: draft.contribution,
    publicationDecision: published.publicationDecision, expectedSelectionHead: null,
    actingSubject: owner.actingSubject };
  await fixture(owner.main('POST', '/v1/publication-selections', {
    ...selection, profile: 'main-default-selection-v1',
    context: { kind: 'main-version-default', id: game.mainVersion },
    selectionBasis: 'main-maintainer',
  }), 201);
  return selection;
}
afterAll(async () => {
  try { await recording.publish(); }
  finally { clearTimeout(fileWall); await sessions?.close(); }
});

type Standing = { standing: string; version: number; replayed?: boolean };
type Mark = { completed: boolean; position: string | null; version: number; replayed?: boolean };
type ReaderState = { status: { status: string | null; version: number; startedOn: string | null; finishedOn: string | null; changedAt: string | null }; progress: unknown };
let game: Work;
let composed: Work;
let sentinel: Work;
let structure: string;
let required: string;
const wholePath = () => `/v1/works/${short(game.work)}/progress`;
const partPath = (occurrence = required) => `/v1/compositions/${short(structure)}/occurrences/${short(occurrence)}/progress`;
const statePath = (work: Work, person: PersonaSession) => `/v1/works/${short(work.work)}/reader-state?${acting(person)}`;
const summaryPath = (work: Work, person: PersonaSession) => `/v1/me/progress-summaries/${short(work.work)}?${acting(person)}`;
async function setupProgress() {
  sessions = await personaSessions('public');
  await recording.prepare();
  game = await createGame('Original partless garden game');
  composed = await createGame('Original garden with main and bonus routes');
  sentinel = await createGame('Original neighbouring garden game');
  const main = await createGame('Original required garden route');
  const bonus = await createGame('Original bonus garden route');
  for (const work of [game, composed, sentinel, main, bonus]) await publish(work);
  const created = await fixture<{ structure: string; revision: string }>(
    sessions.owner.main('POST', '/v1/compositions', { profile: 'work-composition',
      work: composed.work, mainVersion: composed.mainVersion, actingSubject: sessions.owner.actingSubject }), 201);
  structure = created.structure;
  const changed = await fixture<{ occurrences: string[] }>(sessions.owner.main('POST',
    `/v1/compositions/${short(structure)}/changes`, { profile: 'work-composition',
      expectedHead: created.revision, actingSubject: sessions.owner.actingSubject,
      operations: [
        { op: 'insert', parent: structure, position: 'last', role: 'part', target: main.work,
          displayLabel: 'Main garden route', inclusion: 'required' },
        { op: 'insert', parent: structure, position: 'last', role: 'part', target: bonus.work,
          displayLabel: 'Bonus garden route', inclusion: 'extra' },
      ] }));
  [required] = changed.occurrences as [string, string];
}
async function status(person: PersonaSession, work: Work, value: string | null) {
  const current = await answer<ReaderState>(person.main('GET', statePath(work, person)));
  return answer(person.main('PUT', `/v1/works/${short(work.work)}/reader-status`, {
    actingSubject: person.actingSubject, expectedVersion: current.status.version, status: value,
    startedOn: value === 'reading' || value === 'read' ? '2026-10-10' : null,
    finishedOn: value === 'read' ? '2026-10-12' : null,
  }));
}
async function privateBoundary(person: PersonaSession, name: PersonaName) {
  const victim = person === sessions.member ? sessions.stranger : sessions.member;
  await Promise.all([game, composed, sentinel].map(work => status(victim, work, 'reading')));
  // An independently saved neighbour makes an illicit last-read timestamp change observable
  // through the public shelf order, even though reader-state omits lastReadAt.
  const neighbourPath = `/v1/works/${short(sentinel.work)}/progress`;
  const neighbour = await answer<Standing>(victim.main('GET', `${neighbourPath}?${acting(victim)}`));
  await answer(victim.main('PUT', neighbourPath, {
    actingSubject: victim.actingSubject, expectedVersion: neighbour.version, standing: 'started',
  }));
  const shelfPath = `/v1/me/shelves/status/reading/works?${acting(victim)}&sort=last-read&order=desc`;
  const shelf = () => answer<{ items: { work: string }[] }>(victim.main('GET', shelfPath));
  const before = await shelf();
  expect(before.items[0]?.work).toBe(sentinel.work);
  const [beforeWhole, beforePart, beforeState] = await Promise.all([
    answer<Standing>(victim.main('GET', `${wholePath()}?${acting(victim)}`)),
    answer<Mark>(victim.main('GET', `${partPath()}?${acting(victim)}`)),
    answer<ReaderState>(victim.main('GET', statePath(game, victim))),
  ]);
  await Promise.all([statePath(game, victim), summaryPath(game, victim),
    `/v1/me/shelves?${acting(victim)}`, shelfPath].map(path =>
    answer(person.main('GET', path), 403)));
  await answer(person.main('PUT', `/v1/works/${short(game.work)}/reader-status`, {
    actingSubject: victim.actingSubject, expectedVersion: beforeState.status.version, status: null,
  }), 403);
  const [ownWhole, ownPart] = await Promise.all([
    answer<Standing>(person.main('GET', `${wholePath()}?${acting(person)}`)),
    answer<Mark>(person.main('GET', `${partPath()}?${acting(person)}`)),
  ]);
  for (const [path, own] of [[wholePath(), ownWhole], [partPath(), ownPart]] as const) {
    const response = await person.main('GET', `${path}?${acting(victim)}`);
    const body = await response.text();
    expect([200, 403], body).toContain(response.status);
    if (response.status === 200) expect(JSON.parse(body)).toEqual(own);
  }
  const attempts = [
    { path: wholePath(), body: { actingSubject: victim.actingSubject,
      expectedVersion: ownWhole.version, standing: 'completed' } },
    { path: partPath(), body: { actingSubject: victim.actingSubject,
      expectedVersion: ownPart.version, completed: true, position: 'completed' } },
  ];
  const evidence: string[] = [];
  for (const attempt of attempts) {
    const key = randomUUID();
    for (let replay = 0; replay < 2; replay++) {
      const response = await person.main('PUT', attempt.path, attempt.body, key);
      const body = await response.text();
      expect([200, 403], body).toContain(response.status);
      evidence.push(`PUT ${attempt.path} foreign actingSubject, replay=${replay}: ${response.status} ${body}`);
    }
  }
  const [afterWhole, afterPart, afterState, afterShelf] = await Promise.all([
    answer<Standing>(victim.main('GET', `${wholePath()}?${acting(victim)}`)),
    answer<Mark>(victim.main('GET', `${partPath()}?${acting(victim)}`)),
    answer<ReaderState>(victim.main('GET', statePath(game, victim))), shelf(),
  ]);
  expect(afterWhole).toEqual(beforeWhole);
  expect(afterPart).toEqual(beforePart);
  expect(afterState.status).toEqual(beforeState.status);
  const beforeOrder = before.items.map(item => item.work);
  const afterOrder = afterShelf.items.map(item => item.work);
  if (JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder)) {
    console.error(JSON.stringify({ row: declaration.rowId, persona: name,
      requests: evidence, beforeOrder, afterOrder }));
  }
  expect(afterOrder, evidence.join('\n')).toEqual(beforeOrder);
}

const devices = new Map<PersonaName, PersonaSession>();
async function device(person: PersonaSession): Promise<PersonaSession> {
  const directory = join('.temp/stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`);
  const configDirectory = readdirSync(directory).filter(name => name.startsWith('g-1005-auth-'));
  if (configDirectory.length !== 1) throw new Error('Expected the active persona OAuth client fixture');
  const config = JSON.parse(readFileSync(join(directory, configDirectory[0]!, 'public.json'), 'utf8')) as {
    clientId: string; redirectUris: string[]; scope: string;
  };
  // Account's existing cookie authenticates a fresh PKCE authorization, yielding a
  // distinct OAuth device grant. Tokens are never shared with the first device.
  const oauth = await signIn({ account: Bun.env.ACCOUNT_BASE_URL!,
    clientId: config.clientId, redirectUri: config.redirectUris[0]!, scope: config.scope,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/token')) return fetch(input, init);
      return person.account(init?.method ?? 'GET', url.pathname + url.search,
        init?.body ? JSON.parse(String(init.body)) : undefined);
    },
  }, '');
  const sessionKey = randomUUID();
  return { ...person, main: async (method, path, body, key) => {
    const headers = new Headers({ authorization: `Bearer ${await oauth.current()}`, 'x-session-key': sessionKey });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (method !== 'GET') headers.set('idempotency-key', key ?? randomUUID());
    const request = (signal: AbortSignal) => fetch(new URL(path, `http://127.0.0.1:${Bun.env.MAIN_PORT}`), {
      method, headers, signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return method === 'GET' ? outcomeResponse(request) : request(AbortSignal.timeout(30_000));
  }};
}
beforeAll(async () => {
  await setupProgress();
  for (const name of ['stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    const second = await device(sessions[name]);
    const identity = await fixture<{ user: { id: string } }>(second.account('GET', '/api/auth/get-session'));
    if (identity.user.id !== sessions[name].accountId) throw new Error('Device Account identity mismatch');
    devices.set(name, second);
  }
}, 180_000);

async function continuity(name: PersonaName) {
  const a = sessions[name];
  const sampleA = recording.session(name, a);
  if (name === 'visitor') {
    const member = sessions.member;
    const before = await answer(member.main('GET', `${wholePath()}?${acting(member)}`));
    for (const path of [`${wholePath()}?${acting(member)}`, `${partPath()}?${acting(member)}`,
      `/v1/compositions/${short(structure)}/progress?${acting(member)}`, summaryPath(game, member)])
      await answer(sampleA(`sign-in-${path.split('?')[0]}`, 'GET', path), 401);
    await answer(sampleA('whole-write-sign-in', 'PUT', wholePath(), { actingSubject: member.actingSubject,
      expectedVersion: 0, standing: 'completed' }), 401);
    await answer(sampleA('part-write-sign-in', 'PUT', partPath(), { actingSubject: member.actingSubject,
      expectedVersion: 0, completed: true, position: 'completed' }), 401);
    expect(await answer(member.main('GET', `${wholePath()}?${acting(member)}`))).toEqual(before);
    return;
  }
  const b = devices.get(name)!;
  const sampleB = recording.session(name, b);
  await status(a, game, 'want-to-read');
  for (const [path, start, finish, undo] of [
    [wholePath(), { standing: 'started' }, { standing: 'completed' }, { standing: 'not-started' }],
    [partPath(), { completed: false, position: 'played' },
      { completed: true, position: 'completed' }, { completed: false, position: null }],
  ] as const) {
    const label = path === wholePath() ? 'whole' : 'part';
    const initial = await answer<{ version: number }>(sampleB(`${label}-device-b-initial`, 'GET', `${path}?${acting(b)}`));
    const key = randomUUID();
    const command = { actingSubject: a.actingSubject, expectedVersion: initial.version, ...start };
    const saved = await answer<{ version: number }>(sampleA(`${label}-device-a-started`, 'PUT', path, command, key));
    expect(saved.version).toBe(initial.version + 1);
    expect(await answer(sampleB(`${label}-device-b-started`, 'GET', `${path}?${acting(b)}`))).toMatchObject({ ...start, version: saved.version });
    expect(await answer(sampleB(`${label}-device-b-replay`, 'PUT', path, command, key))).toMatchObject({ ...start, version: saved.version, replayed: true });
    expect(await answer(sampleB(`${label}-replay-conflict`, 'PUT', path, { ...command, ...finish }, key), 409))
      .toMatchObject({ code: 'progress_conflict' });
    expect(await answer(sampleB(`${label}-stale-write`, 'PUT', path, { ...command, ...finish }), 409))
      .toMatchObject({ code: 'stale_progress' });
    const winner = await answer<{ version: number }>(sampleB(`${label}-conflict-current`, 'GET', `${path}?${acting(b)}`));
    const completed = await answer<{ version: number }>(sampleB(`${label}-device-b-completed`, 'PUT', path, {
      actingSubject: b.actingSubject, expectedVersion: winner.version, ...finish }));
    expect(await answer(sampleA(`${label}-device-a-completed`, 'GET', `${path}?${acting(a)}`))).toMatchObject({ ...finish, version: completed.version });
    if (path === wholePath()) {
      expect(await answer(sampleB('completed-summary', 'GET', summaryPath(game, b))))
        .toMatchObject({ status: 'finished', counts: { completed: 1, completedRequired: 1 } });
    }
    if (name === 'member' && path === wholePath()) await completedVisit(name);
    const undone = await answer<{ version: number }>(sampleA(`${label}-device-a-undone`, 'PUT', path, {
      actingSubject: a.actingSubject, expectedVersion: completed.version, ...undo }));
    expect(await answer(sampleB(`${label}-device-b-undone`, 'GET', `${path}?${acting(b)}`))).toMatchObject({ ...undo, version: undone.version });
    const other = name === 'member' ? sessions.stranger : sessions.member;
    const otherBase = await answer<{ version: number }>(other.main('GET', `${path}?${acting(other)}`));
    const independent = await answer<{ version: number; replayed?: boolean }>(other.main('PUT', path, {
      actingSubject: other.actingSubject, expectedVersion: otherBase.version, ...start }, key));
    expect(independent.replayed).not.toBe(true);
    expect(independent.version).toBe(otherBase.version + 1);
    expect(await answer(sampleB(`${label}-device-b-independent`, 'GET', `${path}?${acting(b)}`))).toMatchObject({ ...undo, version: undone.version });
  }
  expect(await answer(sampleB('undone-summary', 'GET', summaryPath(game, b))))
    .toMatchObject({ status: 'not-started', counts: { completed: 0 } });
  await privateBoundary(a, name);
  if (name === 'member') await supportingReads(b, sampleB);
}

async function supportingReads(person: PersonaSession, sample: ReturnType<typeof recording.session>) {
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${acting(person)}`;
  for (const work of [game, composed]) {
    const label = work === game ? 'whole' : 'composed';
    const root = `/v1/works/${short(work.work)}`;
    for (const [suffix, path] of [
      ['header', root],
      ['reader-state', `${root}/reader-state`],
      ['progress', `${root}/progress`],
      ['summary', `/v1/me/progress-summaries/${short(work.work)}?language=en`],
      ['preference-empty', `/v1/me/edition-preferences/${short(work.work)}`],
      ['realizations-empty', `${root}/realizations?limit=20`],
      ['releases-empty', `${root}/releases?limit=20`],
      ['relations', `/v1/resources/${short(work.work)}/relations?limit=20`],
      ['sessions-empty', `/v1/me/sessions?${new URLSearchParams({ target: work.work, limit: '50' })}`],
    ] as const) await answer(sample(`${label}-${suffix}`, 'GET', viewer(path)));
  }
  const parts = await answer<{ parts: { occurrence: string }[] }>(
    sample('game-routes', 'GET', viewer(`/v1/resources/${short(composed.work)}/parts?limit=20`)));
  for (const [index, part] of parts.parts.entries()) {
    await answer(sample(`route-${index}-progress`, 'GET', viewer(partPath(part.occurrence))));
  }
  await answer(sample('partless-routes-empty', 'GET', viewer(`/v1/resources/${short(game.work)}/parts?limit=20`)), 404);
  await answer(sample('completion-list-empty', 'GET', viewer(`/v1/compositions/${short(structure)}/progress?limit=20`)));
  await answer(sample('series-structure', 'GET', viewer(`/v1/compositions/${short(structure)}?limit=20`)));
  await answer(sample('resume-position', 'GET', viewer(`/v1/reading-positions/${short(composed.work)}?position=mine&limit=1`)));
  const definition = await sample('correspondence-definition', 'GET', viewer('/v1/lexicon/definitions/correspondence-equivalent'));
  expect([200, 404]).toContain(definition.status);
  await definition.body?.cancel();
}

outcomeTest(declaration, 'visitor', () => proveAndVisit('visitor'), recording);

outcomeTest(declaration, 'stranger', () => proveAndVisit('stranger'), recording);

outcomeTest(declaration, 'member', () => proveAndVisit('member'), recording);

outcomeTest(declaration, 'owner', () => proveAndVisit('owner'), recording);

outcomeTest(declaration, 'moderator', () => proveAndVisit('moderator'), recording);

outcomeTest(declaration, 'operator', () => proveAndVisit('operator'), recording);


async function libraryVisit(name: PersonaName, phase = 'visit') {
  const person = sessions[name];
  const sample = recording.session(name, person);
  const publicSample = recording.session(name, { main: (method, path) => outcomeResponse(signal =>
    fetch(new URL(path, `http://127.0.0.1:${Bun.env.MAIN_PORT}`), { method, signal })) });
  const seen = new Map<string, Promise<Response>>();
  const workNames = new Map([[short(game.work), 'game'], [short(composed.work), 'composed'], [short(sentinel.work), 'sentinel']]);
  const transport = (anonymous: boolean): typeof fetch => async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.slice(BFF_PREFIX.length) + url.search;
    const key = `${anonymous ? 'public' : 'acting'}:${request.method}${path}`;
    let pending = seen.get(key);
    if (!pending) {
      // Labels describe the production request, including the page's distinct query.
      const route = url.pathname.slice(BFF_PREFIX.length);
      const names = (url.searchParams.get('works') ?? '').split(',').filter(Boolean)
        .map(work => workNames.get(short(work)) ?? short(work)).join('-');
      let label: string;
      if (route === '/v1/types') label = 'frame-types';
      else if (route === '/v1/zones') label = 'frame-official-zones';
      else if (route.startsWith('/v1/realms/')) label = `frame-realm-${route.split('/').at(-1)}`;
      else if (route === '/v1/me/session-agent') label = 'frame-session-agent';
      else if (route === '/v1/me/acting-contexts') label = 'frame-acting-contexts';
      else if (route === '/v1/me/agents') label = 'frame-session-agents';
      else if (route === '/v1/me/platform-access') label = 'frame-platform-access';
      else if (route === '/v1/me/person-preferences') label = 'frame-person-preferences';
      else if (route === '/v1/me/managed-realms') label = 'frame-managed-realms';
      else if (route === '/v1/me/notifications/unread-count') label = 'frame-unread-count';
      else if (route === '/v1/me/follows') label = url.searchParams.get('order') === 'pinned'
        ? 'frame-pinned-follows' : url.searchParams.get('kind') === 'space' ? 'frame-space-follows' : 'frame-follow-inventory';
      else if (route.startsWith('/v1/agents/') && !route.endsWith('/library-visibility')) label = 'frame-session-profile';
      else if (route === '/v1/me/shelves') label = 'overview';
      else if (route.includes('/library-visibility')) label = 'visibility';
      else if (route === '/v1/rating-contexts') label = 'rating-context';
      else if (route === '/v1/me/reading-goal') label = 'reading-goal';
      else if (route === '/v1/me/reading-stats') label = 'reading-year';
      else if (route === '/v1/me/follows/authors') label = 'followed-authors';
      else if (route.includes('/shelves/status/')) label = `shelf-${route.split('/')[5]}-${url.searchParams.get('sort')}-${url.searchParams.get('limit')}`;
      else if (route === '/v1/me/work-states') label = `work-states-${names}`;
      else if (route === '/v1/me/import-reviews') label = `import-reviews-${names}`;
      else if (route.startsWith('/v1/me/continue/')) label = `resume-${workNames.get(route.split('/').at(-1)!)}`;
      else if (route.startsWith('/v1/works/')) label = `header-${workNames.get(route.split('/').at(-1)!)}`;
      else throw new Error(`Unlabelled library request: ${path}`);
      pending = (anonymous ? publicSample : sample)(`${phase}-library-${label}`, request.method, path);
      seen.set(key, pending);
    }
    return (await pending).clone();
  };
  const fetcher = transport(false);
  const main = browserMainApi('http://record.invalid', { fetcher });
  const anonymous = browserMainApi('http://record.invalid', { fetcher: transport(true), anonymous: true });
  // LibraryRoute redirects signed-out visitors before any Main library read.
  const reader = person.actingSubject ? { main, anonymous, actingSubject: person.actingSubject } : null;
  await Promise.all([
    libraryFrame(main, anonymous, person.actingSubject, fetcher),
    loadBooksLibrary(reader, { state: parseLibraryState({}), locale: 'en', year: 2026, first: true }),
  ]);
  if (reader) {
    await loadBooksLibrary(reader, { state: parseLibraryState({ shelf: 'reading' }), locale: 'en', year: 2026, first: false });
    await loadBooksLibrary(reader, { state: parseLibraryState({ shelf: 'read' }), locale: 'en', year: 2026, first: false });
  }
}

async function within(part: string, milliseconds: number, run: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${part} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

const proofClocks = new Map<PersonaName, { pause: () => void; resume: () => void; visitMs: number }>();
async function completedVisit(name: PersonaName) {
  const clock = proofClocks.get(name)!;
  clock.pause();
  const started = performance.now();
  try {
    await within('completed visit', visitDeadlineMs, async () => {
      await libraryVisit(name, 'completed');
      await completedWorkVisit(name);
    });
  } finally {
    clock.visitMs += performance.now() - started;
    clock.resume();
  }
}

async function proveAndVisit(name: PersonaName) {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remaining = proofDeadlineMs;
  let resumed = started;
  let rejectProof: (reason: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { rejectProof = reject; });
  const clock = {
    visitMs: 0,
    pause() { clearTimeout(timer); remaining -= performance.now() - resumed; },
    resume() {
      resumed = performance.now();
      timer = setTimeout(() => rejectProof(new Error('proof exceeded 90000 ms')), Math.max(0, remaining));
    },
  };
  proofClocks.set(name, clock);
  clock.resume();
  let proofMs = 0;
  try {
    // Completion is proved before its visit; undo still runs afterwards with every original assertion.
    await Promise.race([continuity(name), deadline]);
    clock.pause();
    proofMs = performance.now() - started - clock.visitMs;
    const visitStarted = performance.now();
    try { await within('visit', Math.max(0, visitDeadlineMs - clock.visitMs), () => libraryVisit(name)); }
    finally { clock.visitMs += performance.now() - visitStarted; }
  } finally {
    clearTimeout(timer);
    proofClocks.delete(name);
    console.info(`[games-library] ${name} proof=${Math.round(proofMs || performance.now() - started - clock.visitMs)}ms visit=${Math.round(clock.visitMs)}ms`);
  }
}

async function completedWorkVisit(name: PersonaName) {
  const person = sessions[name];
  const labels = new AsyncLocalStorage<string | ((path: string) => string)>();
  const recorded = recording.session(name, person);
  const publicSample = recording.session(name, { main: (method, path, body) => outcomeResponse(signal =>
    fetch(new URL(path, `http://127.0.0.1:${Bun.env.MAIN_PORT}`), { method, signal,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })) });
  const seen = new Map<string, Promise<Response>>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.slice(BFF_PREFIX.length) + url.search;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const label = labels.getStore();
    if (!label) throw new Error(`Unlabelled hub request: ${method} ${path}`);
    const anonymous = init?.credentials === 'omit' || ['/v1/types', '/v1/facets', '/v1/resources/showcase', '/v1/zones']
      .includes(url.pathname.slice(BFF_PREFIX.length));
    const key = JSON.stringify([anonymous, method, path, body]);
    let pending = seen.get(key);
    if (!pending) {
      const stableLabel = typeof label === 'function' ? label(path) : label;
      pending = (anonymous ? publicSample : recorded)(stableLabel, method, path, body);
      seen.set(key, pending);
    }
    try { return (await pending).clone(); }
    catch (error) { throw new Error(`Hub visit ${name}: ${method} ${path}: ${String(error)}`, { cause: error }); }
  };
  const main = browserMainApi('http://record.invalid', { fetcher });
  const anonymous = browserMainApi('http://record.invalid', { fetcher, anonymous: true });
  const call = <T,>(label: string | ((path: string) => string), read: () => Promise<T>) => labels.run(label, read);
  const actingSubject = person.actingSubject ?? undefined;
  const id = short(game.work);
  const work = main.v1.works({ id });
  const resource = main.v1.resources({ resource: id });
  const query = { actingSubject };
  const reads = booksEditionReads({ main, actingSubject });
  const template = (kind: 'work-credits' | 'work-adoptions') => call(`completed-work-${kind}`, () => main.v1.query.post({
    profile: 'template-query-v1', query: `https://rezics.com/query/${kind}`, revision: 1,
    parameters: { roots: [game.work] }, presentation: { actingSubject },
  }));
  await call(path => {
    const url = new URL(path, 'http://record.invalid');
    const request = url.pathname.slice(4).replaceAll('/', '-');
    const follow = url.pathname === '/v1/me/follows' ? `-${url.searchParams.get('order') ?? 'inventory'}` : '';
    return `completed-work-frame-${request}${follow}`;
  }, () => libraryFrame(main, anonymous, person.actingSubject, fetcher));
  // The signed-in shell's Main reads have no acting query until selection is known.
  await Promise.all([
    call('completed-work-types', () => main.v1.types.get()),
    person.actingSubject ? (async () => {
      const [state] = await Promise.all([
        call('completed-work-session-agent', () => main.v1.me['session-agent'].get()),
        call('completed-work-acting-contexts', () => main.v1.me['acting-contexts'].get({ query: { task: 'work.create' } })),
        call('completed-work-session-agents', () => main.v1.me.agents.get({ query: { languages: 'en' } })),
      ]);
      if (state.data?.sessionAgent.eligible) await Promise.all([
        call('completed-work-person-preferences', () => main.v1.me['person-preferences'].get({ query })),
        call('completed-work-session-profile', () => main.v1.agents({ id: short(person.actingSubject!) }).get({ query })),
      ]);
    })() : null,
  ]);
  const header = await call('completed-work-header', () => reads.readWorkHeader(id));
  if (!header.ok) return; // The route cannot render a Work frame without its header.
  const [projection, contexts, credits] = await Promise.all([
    call('completed-work-projection', () => readResourcePage(main, actingSubject, id)),
    call('completed-work-rating-contexts', () => resource['rating-contexts'].get({ query: { ...query, scope: 'global' } })),
    call('completed-work-agent-credits', () => work['agent-credits'].get({ query })),
    template('work-credits'), template('work-adoptions'),
    call('completed-work-showcase', () => main.v1.resources.showcase.post({ profile: 'work-showcase-batch-v1', targets: [game.work] })),
    call('completed-work-facets', () => main.v1.facets.get()),
    call('completed-work-medium-header', () => mainTrackingApi(actingSubject!, () => main).media!.types(game.work)).then(async () => {
      const media = mainTrackingApi(actingSubject!, () => main).media!;
      await call('completed-work-medium-routes', () => media.routes(game.work));
      await call('completed-work-whole-progress', () => media.workStanding(game.work));
    }),
    call('completed-work-classifications', () => work.classifications.get({ query: { ...query, scope: 'global' } })),
    call('completed-work-rating-populations', () => main.v1['rating-populations'].get({ query: { ...query, target: game.work, limit: 20 } })),
    call('completed-work-also-enjoyed', () => work['also-enjoyed'].get({ query: { ...query, limit: 12 } })),
    person.actingSubject ? call('completed-work-reader-state', () => readAnimeReaderState(main, actingSubject, id)) : null,
    person.actingSubject ? call('completed-work-platform-access', () => main.v1.me['platform-access'].get()) : null,
  ]);
  const context = contexts.data?.items[0]?.context;
  const sections = projection.ok ? projection.data.sections : [];
  // Game availability is non-book; the releases make YourEdition reachable.
  await Promise.all([
    contexts.error ? null : call('completed-work-ratings-global', () => resource.ratings.get({ query: { ...query, scope: 'global', context } })),
    call('completed-work-reader-stats', () => work['reader-stats'].get({ query: { ...query, context } })),
    context ? call('completed-work-reviews', () => resource.reviews.get({ query: { ...query, context, sort: 'helpful', limit: 10 } })).then(async () => {
      await call('completed-work-review-relations', () => resource.relations.get({ query: { ...query, limit: 32 } }));
    }) : null,
    (async () => {
      const [realizations, releases] = await Promise.all([
        call('completed-work-realizations', () => work.realizations.get({ query: { ...query, limit: 20 } })),
        call('completed-work-releases', () => work.releases.get({ query: { ...query, limit: 20 } })),
        call('completed-work-partless-parts', () => resource.parts.get({ query: { ...query, limit: 1 } })),
      ]);
      if (person.actingSubject && (releases.data?.items.length || realizations.data?.items.length)) {
        const tracking = mainTrackingApi(person.actingSubject, () => main);
        await Promise.all([
          call('completed-work-edition-preference', () => tracking.preference(game.work)),
          call(path => path.includes('/realizations') ? 'completed-work-realizations' : 'completed-work-releases', () => tracking.editions(game.work)),
        ]);
      }
    })(),
    call('completed-work-parts-preview', () => resource.parts.get({ query: { ...query, limit: 7 } })),
    call('completed-work-wholes', () => resource.wholes.get({ query: { ...query, limit: 3 } })),
    call('completed-work-relations', () => resource.relations.get({ query: { ...query, limit: 20 } })),
    person.actingSubject ? (async () => {
      const tracking = mainTrackingApi(person.actingSubject!, () => main);
      const [preference] = await Promise.all([
        call('completed-work-edition-preference', () => tracking.preference(game.work)),
        call(path => path.includes('/realizations') ? 'completed-work-realizations' : 'completed-work-releases', () => tracking.editions(game.work)),
        call('completed-work-relations', () => tracking.relations(game.work)),
        call('completed-work-correspondence-definition', () => tracking.definition('correspondence-equivalent')),
      ]);
      await call('completed-work-series-progress', () => tracking.series(game.work, preference.ok ? preference.data?.language ?? 'en' : 'en'));
    })() : null,
    ...sections.filter(section => ['statements', 'discussion'].includes(section.id)).map(section =>
      call(`completed-work-${section.id}`, followHref(main, section.href, query))),
    ...(credits.data?.items.filter(credit => credit.role === 'author').slice(0, 1).map(credit =>
      call('completed-work-author-works', () => main.v1.agents({ id: short(credit.agent) }).works.get({ query: { ...query, limit: 12 } }))) ?? []),
  ]);
}


/** Main reads in RootLayout, LocaleLayout and ShellCommunities; Account viewer reads stay with Account. */
async function libraryFrame(main: ReturnType<typeof browserMainApi>, anonymous: ReturnType<typeof browserMainApi>,
  actingSubject: string | null, fetcher: typeof fetch) {
  const [state, zones] = await Promise.all([
    actingSubject ? main.v1.me['session-agent'].get() : null,
    anonymous.v1.zones.get({ query: { official: 'true', limit: 6 } }),
    anonymous.v1.types.get(),
    actingSubject ? main.v1.me['acting-contexts'].get({ query: { task: 'work.create' } }) : null,
    actingSubject ? main.v1.me.agents.get({ query: { languages: 'en' } }) : null,
    actingSubject ? main.v1.me['platform-access'].get() : null,
  ]);
  const actor = state?.data?.sessionAgent.eligible ? actingSubject : null;
  const relationships = actor ? mainRelationships(actor, { origin: 'http://record.invalid/api/main', fetch: fetcher }) : null;
  await Promise.all([
    actor ? main.v1.me['managed-realms'].get({ query: { actingSubject: actor } }) : null,
    actor ? main.v1.me['person-preferences'].get({ query: { actingSubject: actor } }) : null,
    actor ? main.v1.agents({ id: short(actor) }).get({ query: { actingSubject: actor } }) : null,
    actingSubject ? main.v1.me.notifications['unread-count'].get() : null,
    relationships ? pinnedCommunities(relationships, '', null).catch(() => null) : null,
    relationships ? spaceCommunities(relationships, '', null).catch(() => null) : null,
    relationships ? relationships.follows().catch(() => null) : null,
    ...((zones.data?.items ?? []).slice(0, 6).map(zone => anonymous.v1.realms({ realm: short(zone.realm) }).get())),
  ]);

}
