import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import declaration from '../../../../../scripts/qa/cases/outcomes/games/work-hub-and-edition-choice.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
type Work = { work: string; mainVersion: string };
let sessions: PersonaSessions;
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
async function credit(person: PersonaSession, game: Work) {
  const page = await answer<{ items: { role: string; participantKind: string; agent: string | null }[] }>(
    person.main('GET', `/v1/works/${short(game.work)}/credits?${acting(person)}`));
  expect(page.items).toContainEqual(expect.objectContaining({
    role: 'author', participantKind: 'agent', agent: sessions.owner.actingSubject,
  }));
}
afterAll(async () => { await sessions?.close(); });

let game: Work;
let draft: Work;
let release: { release: string; revision: string };
let releaseCommand: object;
beforeAll(async () => {
  sessions = await personaSessions('public');
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
  const root = `/v1/works/${short(game.work)}`;
  const header = await answer<{ id: string; disclosure: string; description: { value: string } | null }>(
    person.main('GET', `${root}?${acting(person)}`));
  expect(header).toMatchObject({ id: game.work, disclosure: 'public' });
  expect(header.description?.value).toBe('An original game about planting lights in a synthetic garden.');
  await credit(person, game);
  // This endpoint requires a composition; the published partless game remains readable.
  expect(await answer(person.main('GET',
    `/v1/resources/${short(game.work)}/parts?${acting(person)}`), 404))
    .toMatchObject({ code: 'work_unavailable' });
  expect(await answer<{ items: unknown[] }>(person.main('GET',
    `${root}/editions?${acting(person)}`))).toMatchObject({ items: [] });
  const releases = await answer<{ items: { id: string; revision: string; editionStatement: string }[] }>(
    person.main('GET', `${root}/releases?${acting(person)}`));
  expect(releases.items).toContainEqual(expect.objectContaining({
    id: release.release, revision: release.revision,
    editionStatement: 'Desktop PC; version 1.0; digital format',
  }));
  await answer(person.main('GET', `${root}/releases/${short(release.release)}?${acting(person)}`));
  const preferencePath = `/v1/me/edition-preferences/${short(game.work)}`;
  const choice = { actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    expectedVersion: 0, language: 'en',
    edition: { kind: 'release', resource: release.release, revision: release.revision } };
  if (name === 'visitor') {
    await answer(person.main('GET', `${preferencePath}?${acting(sessions.owner)}`), 401);
    await answer(person.main('PUT', preferencePath, choice), 401);
  } else {
    expect(await answer(person.main('GET', `${preferencePath}?${acting(person)}`))).toBeNull();
    const saved = await answer(person.main('PUT', preferencePath, choice));
    expect(saved).toMatchObject({ work: game.work, language: 'en', edition: choice.edition, version: 1 });
    expect(await answer(person.main('GET', `${preferencePath}?${acting(person)}`)))
      .toMatchObject({ edition: choice.edition, version: 1 });
    const other = name === 'member' ? sessions.stranger : sessions.member;
    await answer(person.main('GET', `${preferencePath}?${acting(other)}`), 403);
    await answer(person.main('PUT', preferencePath, { ...choice, actingSubject: other.actingSubject }), 403);
  }
  const privatePath = `/v1/works/${short(draft.work)}?${acting(person)}`;
  await answer(person.main('GET', privatePath), name === 'owner' ? 200 : 404);
  if (name !== 'owner') {
    await answer(person.main('PUT', `${root}/releases/${short(release.release)}`, {
      ...releaseCommand, expectedHead: release.revision,
      actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    }), name === 'visitor' ? 401 : 403);
  }
}

outcomeTest(declaration, 'visitor', () => hub('visitor'));

outcomeTest(declaration, 'stranger', () => hub('stranger'));

outcomeTest(declaration, 'member', () => hub('member'));

outcomeTest(declaration, 'owner', () => hub('owner'));

outcomeTest(declaration, 'moderator', () => hub('moderator'));

outcomeTest(declaration, 'operator', () => hub('operator'));

