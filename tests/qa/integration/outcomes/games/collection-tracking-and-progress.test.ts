import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import declaration from '../../../../../scripts/qa/cases/outcomes/games/collection-tracking-and-progress.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(90_000);
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
  finally { await sessions?.close(); }
});

type Standing = { standing: string; version: number; replayed?: boolean };
type Mark = { completed: boolean; position: string | null; version: number; replayed?: boolean };
type ReaderState = { status: { status: string | null; version: number; startedOn: string | null; finishedOn: string | null; changedAt: string | null }; progress: unknown };
let game: Work;
let composed: Work;
let sentinel: Work;
let structure: string;
let required: string;
let extra: string;
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
  [required, extra] = changed.occurrences as [string, string];
}
async function status(person: PersonaSession, work: Work, value: string | null,
  sample?: ReturnType<typeof recording.session>, label = `status-${value ?? 'removed'}`) {
  const current = await answer<ReaderState>(sample
    ? sample(`${label}-before`, 'GET', statePath(work, person))
    : person.main('GET', statePath(work, person)));
  const body = {
    actingSubject: person.actingSubject, expectedVersion: current.status.version, status: value,
    startedOn: value === 'reading' || value === 'read' ? '2026-10-10' : null,
    finishedOn: value === 'read' ? '2026-10-12' : null,
  };
  const path = `/v1/works/${short(work.work)}/reader-status`;
  return answer(sample ? sample(label, 'PUT', path, body) : person.main('PUT', path, body));
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

beforeAll(setupProgress, 180_000);
async function collection(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  if (name === 'visitor') {
    const before = await answer<ReaderState>(sessions.member.main('GET', statePath(game, sessions.member)));
    expect(await answer<ReaderState>(sample('reader-state-public', 'GET', statePath(game, person))))
      .toMatchObject({ status: { status: null, version: 0 }, progress: null });
    for (const path of [`${wholePath()}?${acting(sessions.member)}`,
      `${partPath()}?${acting(sessions.member)}`, summaryPath(game, sessions.member),
      `/v1/me/shelves?${acting(sessions.member)}`,
      `/v1/me/shelves/status/reading/works?${acting(sessions.member)}`])
      await answer(sample(`sign-in-${path.split('?')[0]}`, 'GET', path), 401);
    for (const [path, body] of [
      [wholePath(), { expectedVersion: 0, standing: 'completed' }],
      [partPath(), { expectedVersion: 0, completed: true, position: 'completed' }],
      [`/v1/works/${short(game.work)}/reader-status`, { expectedVersion: 0, status: 'read' }],
    ] as const) await answer(sample(`write-sign-in-${path}`, 'PUT', path, { ...body, actingSubject: sessions.member.actingSubject }), 401);
    expect((await answer<ReaderState>(sessions.member.main('GET', statePath(game, sessions.member)))).status)
      .toEqual(before.status);
    return;
  }
  for (const value of ['want-to-read', 'reading', 'read', null]) {
    expect(await status(person, game, value, sample)).toMatchObject({ status: value });
    expect((await answer<ReaderState>(sample(`status-${value ?? 'removed'}-saved`, 'GET', statePath(game, person)))).status)
      .toMatchObject({ status: value, startedOn: value === 'reading' || value === 'read' ? '2026-10-10' : null,
        finishedOn: value === 'read' ? '2026-10-12' : null });
    if (value) {
      const shelf = await answer<{ items: { work: string }[] }>(sample(`shelf-${value}`, 'GET',
        `/v1/me/shelves/status/${value}/works?${acting(person)}`));
      expect(shelf.items.map(item => item.work)).toContain(game.work);
    }
  }
  await status(person, game, 'want-to-read', sample, 'collect-game');
  const library = (await answer<ReaderState>(sample('library-status', 'GET', statePath(game, person)))).status;
  let current = await answer<Standing>(sample('whole-progress-initial', 'GET', `${wholePath()}?${acting(person)}`));
  for (const standing of ['started', 'completed', 'dropped', 'not-started'] as const) {
    current = await answer<Standing>(sample(`whole-${standing}`, 'PUT', wholePath(), {
      actingSubject: person.actingSubject, expectedVersion: current.version, standing }));
    expect(current.standing).toBe(standing);
    const summary = await answer<{ status: string; counts: { completed: number } }>(
      sample(`summary-${standing}`, 'GET', summaryPath(game, person)));
    expect(summary.status).toBe(({ started: 'reading', completed: 'finished',
      dropped: 'dropped', 'not-started': 'not-started' })[standing]);
    expect(summary.counts.completed).toBe(standing === 'completed' ? 1 : 0);
    expect((await answer<ReaderState>(sample(`reader-state-${standing}`, 'GET', statePath(game, person)))).status).toEqual(library);
  }
  const parts = await answer<{ parts: { occurrence: string; inclusion: string }[] }>(sample('game-parts', 'GET',
    `/v1/resources/${short(composed.work)}/parts?${acting(person)}`));
  expect(parts.parts.map(part => [part.occurrence, part.inclusion]))
    .toEqual([[required, 'required'], [extra, 'extra']]);
  expect(await answer(sample('composed-progress', 'GET', `/v1/works/${short(composed.work)}/progress?${acting(person)}`)))
    .toEqual({ work: composed.work, parts: true });
  expect(await answer(sample('whole-write-has-parts', 'PUT', `/v1/works/${short(composed.work)}/progress`, {
    actingSubject: person.actingSubject, expectedVersion: 0, standing: 'completed' }), 409))
    .toMatchObject({ code: 'work_has_parts' });
  for (const occurrence of [extra, required]) {
    const path = partPath(occurrence);
    const label = occurrence === extra ? 'bonus' : 'required';
    const initial = await answer<Mark>(sample(`${label}-initial`, 'GET', `${path}?${acting(person)}`));
    const completed = await answer<Mark>(sample(`${label}-completed`, 'PUT', path, {
      actingSubject: person.actingSubject, expectedVersion: initial.version,
      completed: true, position: 'completed' }));
    expect(completed.completed).toBe(true);
    const saved = await answer<{ items: { occurrence: string }[] }>(sample(`${label}-completion-list`, 'GET',
      `/v1/compositions/${short(structure)}/progress?${acting(person)}`));
    expect(saved.items.map(item => item.occurrence)).toContain(occurrence);
  }
  const mark = await answer<Mark>(sample('required-before-undo', 'GET', `${partPath()}?${acting(person)}`));
  await answer(sample('required-undone', 'PUT', partPath(), { actingSubject: person.actingSubject,
    expectedVersion: mark.version, completed: false, position: null }));
  const saved = await answer<{ items: { occurrence: string }[] }>(sample('remaining-completions', 'GET',
    `/v1/compositions/${short(structure)}/progress?${acting(person)}`));
  expect(saved.items.map(item => item.occurrence)).toEqual([extra]);
  await privateBoundary(person, name);
  if (name === 'member') await supportingReads(person, sample);
}

async function supportingReads(person: PersonaSession, sample: ReturnType<typeof recording.session>) {
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${acting(person)}`;
  for (const [label, path] of [
    ['library-overview', '/v1/me/shelves?limit=20'],
    ['reading-goal', '/v1/me/reading-goal?year=2026'],
    ['reading-year', '/v1/me/reading-stats?year=2026'],
    ['followed-authors', '/v1/me/follows/authors'],
    ['shelf-empty', '/v1/me/shelves/status/read/works?sort=last-read&order=desc&limit=20'],
    ['currently-reading', '/v1/me/shelves/status/reading/works?sort=last-read&order=desc&limit=6'],
    ['library-work-states', `/v1/me/work-states?${new URLSearchParams({ works: [game.work, composed.work, sentinel.work].join(',') })}`],
    ['private-import-reviews', `/v1/me/import-reviews?${new URLSearchParams({ works: [game.work, composed.work, sentinel.work].join(',') })}`],
    ['game-header', `/v1/works/${short(game.work)}`],
    ['composed-header', `/v1/works/${short(composed.work)}`],
    ['game-parts-empty', `/v1/resources/${short(game.work)}/parts?limit=20`],
    ['series-structure', `/v1/compositions/${short(structure)}?limit=20`],
    ['resume-game', `/v1/me/continue/${short(game.work)}`],
    ['resume-composed', `/v1/me/continue/${short(composed.work)}`],
    ['edition-preference-empty', `/v1/me/edition-preferences/${short(composed.work)}`],
    ['realizations-empty', `/v1/works/${short(composed.work)}/realizations?limit=20`],
    ['releases-empty', `/v1/works/${short(composed.work)}/releases?limit=20`],
    ['composed-summary', `/v1/me/progress-summaries/${short(composed.work)}?language=en`],
    ['resume-position', `/v1/reading-positions/${short(composed.work)}?position=mine&limit=1`],
    ['work-relations', `/v1/resources/${short(composed.work)}/relations?limit=20`],
    ['edition-sessions-empty', `/v1/me/sessions?${new URLSearchParams({ target: composed.work, limit: '50' })}`],
  ] as const) await answer(sample(label, 'GET', viewer(path)), label === 'game-parts-empty' ? 404 : 200);
  await answer(sample('library-visibility', 'GET', `/v1/agents/${short(person.actingSubject!)}/library-visibility`));
  await answer(sample('library-rating-context', 'GET', '/v1/rating-contexts?scope=global&limit=1'));
  await answer(sample('private-reader-state', 'GET', statePath(game, sessions.stranger)), 403);
  const definition = await sample('correspondence-definition', 'GET', viewer('/v1/lexicon/definitions/correspondence-equivalent'));
  expect([200, 404]).toContain(definition.status);
  await definition.body?.cancel();
}

outcomeTest(declaration, 'visitor', () => collection('visitor'), recording);

outcomeTest(declaration, 'stranger', () => collection('stranger'), recording);

outcomeTest(declaration, 'member', () => collection('member'), recording);

outcomeTest(declaration, 'owner', () => collection('owner'), recording);

outcomeTest(declaration, 'moderator', () => collection('moderator'), recording);

outcomeTest(declaration, 'operator', () => collection('operator'), recording);

