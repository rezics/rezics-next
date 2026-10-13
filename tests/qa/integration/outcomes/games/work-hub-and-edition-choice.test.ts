import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import declaration from '../../../../../scripts/qa/cases/outcomes/games/work-hub-and-edition-choice.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
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
async function credit(person: PersonaSession, game: Work, sample: ReturnType<typeof recording.session>) {
  const page = await answer<{ items: { role: string; participantKind: string; agent: string | null }[] }>(
    sample('work-credits', 'GET', `/v1/works/${short(game.work)}/credits?${acting(person)}`));
  expect(page.items).toContainEqual(expect.objectContaining({
    role: 'author', participantKind: 'agent', agent: sessions.owner.actingSubject,
  }));
}
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});

let game: Work;
let draft: Work;
let release: { release: string; revision: string };
let releaseCommand: object;
beforeAll(async () => {
  sessions = await personaSessions('public');
  await recording.prepare();
  game = await createGame('Original garden game');
  draft = await createGame('Unpublished garden draft');
  await publish(game);
  await fixture(sessions.owner.main('PUT', `/v1/works/${short(game.work)}/metadata`, {
    profile: 'work-metadata-details-v1', expectedHead: null,
    actingSubject: sessions.owner.actingSubject,
    state: { kind: 'header', originalTitle: null, localized: [{
      language: 'en', title: null, mainVersionLabel: null,
      description: 'An original game about planting lights in a synthetic garden.',
    }] },
  }));
  const releaseId = `https://rezics.com/id/${randomUUID()}`;
  releaseCommand = {
    profile: 'release-v1', expectedHead: null, id: releaseId,
    actingSubject: sessions.owner.actingSubject, kind: 'formal', status: 'official',
    contentLanguages: ['en'], isTranslation: false, originalLanguages: [],
    titleLanguage: 'en', tracklistLanguage: null,
    title: { value: 'Garden game desktop release', language: 'en' },
    editionStatement: 'Desktop PC; version 1.0; digital format',
    publisher: null, publicationYear: null, isbn13: null, originalUrl: null,
    fixedRelease: null, coverage: null, evidence: null,
  };
  release = await fixture(sessions.owner.main('PUT',
    `/v1/works/${short(game.work)}/releases/${short(releaseId)}`, releaseCommand));
}, 180_000);

async function hub(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  const root = `/v1/works/${short(game.work)}`;
  const header = await answer<{ id: string; disclosure: string; description: { value: string } | null }>(
    sample('work-header', 'GET', `${root}?${acting(person)}`));
  expect(header).toMatchObject({ id: game.work, disclosure: 'public' });
  expect(header.description?.value).toBe('An original game about planting lights in a synthetic garden.');
  await credit(person, game, sample);
  // This endpoint requires a composition; the published partless game remains readable.
  expect(await answer(sample('partless-parts', 'GET',
    `/v1/resources/${short(game.work)}/parts?${acting(person)}`), 404))
    .toMatchObject({ code: 'work_unavailable' });
  expect(await answer<{ items: unknown[] }>(sample('editions-empty', 'GET',
    `${root}/editions?${acting(person)}`))).toMatchObject({ items: [] });
  const releases = await answer<{ items: { id: string; revision: string; editionStatement: string }[] }>(
    sample('releases', 'GET', `${root}/releases?${acting(person)}`));
  expect(releases.items).toContainEqual(expect.objectContaining({
    id: release.release, revision: release.revision,
    editionStatement: 'Desktop PC; version 1.0; digital format',
  }));
  await answer(sample('release-details', 'GET', `${root}/releases/${short(release.release)}?${acting(person)}`));
  // Match the bounded reads PrimaryAction and non-book Availability send.
  const viewer = (path: string) => person.actingSubject
    ? `${path}${path.includes('?') ? '&' : '?'}${acting(person)}` : path;
  const hubReleases = await answer<{ items: { id: string; revision: string }[] }>(
    sample('hub-releases', 'GET', viewer(`${root}/releases?limit=20`)));
  expect(hubReleases.items).toContainEqual(expect.objectContaining({
    id: release.release, revision: release.revision,
  }));
  expect(await answer(sample('hub-partless-parts', 'GET',
    viewer(`/v1/resources/${short(game.work)}/parts?limit=1`)), 404))
    .toMatchObject({ code: 'work_unavailable' });
  if (name !== 'member') {
    expect(await answer(sample('hub-realizations-empty', 'GET', viewer(`${root}/realizations?limit=20`))))
      .toMatchObject({ items: [] });
    expect(await answer(sample('hub-contents-unavailable', 'GET', viewer(`${root}/contents`)), 404))
      .toMatchObject({ code: 'work_unavailable' });
    if (person.actingSubject) {
      expect(await answer(sample('hub-continue-reading', 'GET', viewer('/v1/me/continue?limit=6'))))
        .toMatchObject({ items: [] });
      expect(await answer(sample('hub-progress-summary', 'GET',
        viewer(`/v1/me/progress-summaries/${short(game.work)}?language=en`))))
        .toMatchObject({ resource: game.work, language: 'en', status: 'not-started' });
    }
  }
  const preferencePath = `/v1/me/edition-preferences/${short(game.work)}`;
  const choice = { actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    expectedVersion: 0, language: 'en',
    edition: { kind: 'release', resource: release.release, revision: release.revision } };
  if (name === 'visitor') {
    await answer(sample('preference-sign-in', 'GET', `${preferencePath}?${acting(sessions.owner)}`), 401);
    await answer(sample('choose-edition-sign-in', 'PUT', preferencePath, choice), 401);
  } else {
    expect(await answer(sample('preference-empty', 'GET', `${preferencePath}?${acting(person)}`))).toBeNull();
    const saved = await answer(sample('choose-edition', 'PUT', preferencePath, choice));
    expect(saved).toMatchObject({ work: game.work, language: 'en', edition: choice.edition, version: 1 });
    expect(await answer(sample('preference-saved', 'GET', `${preferencePath}?${acting(person)}`)))
      .toMatchObject({ edition: choice.edition, version: 1 });
    const other = name === 'member' ? sessions.stranger : sessions.member;
    await answer(sample('preference-private', 'GET', `${preferencePath}?${acting(other)}`), 403);
    await answer(sample('choose-edition-private', 'PUT', preferencePath, { ...choice, actingSubject: other.actingSubject }), 403);
  }
  const privatePath = `/v1/works/${short(draft.work)}?${acting(person)}`;
  await answer(sample('unpublished-work', 'GET', privatePath), name === 'owner' ? 200 : 404);
  if (name !== 'owner') {
    await answer(sample('release-edit-refused', 'PUT', `${root}/releases/${short(release.release)}`, {
      ...releaseCommand, expectedHead: release.revision,
      actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    }), name === 'visitor' ? 401 : 403);
  }
  if (name === 'member') await supportingReads(person, sample);
}

async function supportingReads(person: PersonaSession, sample: ReturnType<typeof recording.session>) {
  const root = `/v1/works/${short(game.work)}`;
  const resource = `/v1/resources/${short(game.work)}`;
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${acting(person)}`;
  const projection = await answer<{ sections: { id: string; href: string }[] }>(
    sample('hub-projection', 'GET', viewer(`${resource}/page`)));
  for (const [label, path] of [
    ['agent-credits', `${root}/agent-credits`],
    ['reader-state', `${root}/reader-state`],
    ['realizations-empty', `${root}/realizations?limit=20`],
    ['work-relations', `${resource}/relations?limit=20`],
    ['progress-summary', `/v1/me/progress-summaries/${short(game.work)}?language=en`],
    ['continue-reading', '/v1/me/continue?limit=6'],
    ['reader-stats', `${root}/reader-stats`],
    ['also-enjoyed', `${root}/also-enjoyed?limit=12`],
    ['author-works', `/v1/agents/${short(sessions.owner.actingSubject!)}/works?limit=12`],
    ['facets', '/v1/facets'],
    ['classifications', `${root}/classifications?scope=global`],
    ['follow-context', `/v1/follows/${short(game.work)}?kind=work`],
    ['edition-sessions-empty', `/v1/me/sessions?${new URLSearchParams({ target: game.work, limit: '50' })}`],
    ['text-selection', `/v1/main-versions/${short(game.mainVersion)}/selection?language=en`],
  ] as const) await answer(sample(label, 'GET', label === 'text-selection' ? path : viewer(path)));
  await answer(sample('contents-unavailable', 'GET', viewer(`${root}/contents`)), 404);
  await answer(sample('work-showcase-empty', 'POST', '/v1/resources/showcase', {
    profile: 'work-showcase-batch-v1', targets: [game.work],
  }));
  await answer(sample('rating-populations', 'GET', viewer(`/v1/rating-populations?${new URLSearchParams({
    target: game.work, limit: '20',
  })}`)));
  const definition = await sample('correspondence-definition', 'GET', viewer('/v1/lexicon/definitions/correspondence-equivalent'));
  expect([200, 404]).toContain(definition.status);
  await definition.body?.cancel();
  for (const query of ['work-credits', 'work-adoptions']) {
    await answer(sample(`${query}-template`, 'POST', '/v1/query', {
      profile: 'template-query-v1', query: `https://rezics.com/query/${query}`, revision: 1,
      parameters: { roots: [game.work] }, presentation: { actingSubject: person.actingSubject },
    }));
  }
  const contexts = await answer<{ items: { context: string }[] }>(
    sample('rating-contexts', 'GET', viewer(`${resource}/rating-contexts?scope=global`)));
  const context = contexts.items[0]?.context;
  await answer(sample('rating-summary', 'GET', viewer(`${resource}/ratings${context
    ? `?context=${encodeURIComponent(context)}` : ''}`)));
  for (const section of projection.sections) {
    if (['statements', 'discussion', 'lists'].includes(section.id)) {
      await answer(sample(`hub-${section.id}`, 'GET', viewer(section.href)));
    } else if (section.id === 'reviews' && context) {
      await answer(sample('hub-reviews', 'GET', viewer(`${section.href}?${new URLSearchParams({
        context, sort: 'helpful', limit: '10',
      })}`)));
    }
  }
}

outcomeTest(declaration, 'visitor', () => hub('visitor'), recording);

outcomeTest(declaration, 'stranger', () => hub('stranger'), recording);

outcomeTest(declaration, 'member', () => hub('member'), recording);

outcomeTest(declaration, 'owner', () => hub('owner'), recording);

outcomeTest(declaration, 'moderator', () => hub('moderator'), recording);

outcomeTest(declaration, 'operator', () => hub('operator'), recording);

