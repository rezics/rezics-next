import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import hub, { grantMangaFixtureAuthority } from '../../../../../scripts/qa/cases/outcomes/manga/work-hub-and-edition-choice.ts';
import { seedFirstPublicationDate } from '../../../../../scripts/dev/seed/relation-lexicon.ts';
import { classificationContextBody, classifiedStatementBody } from '../../../../../scripts/dev/seed/classified-statement.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Release = { id: string; revision: string; title: { value: string } };
type Preference = { work: string; language: string; edition: { kind: string; resource: string; revision: string }; version: number };
setDefaultTimeout(90_000);
let sessions: PersonaSessions;
let pool: Pool;
let manga: Work, undated: Work;
const releases: Release[] = [];
const short = (id: string) => id.slice(-36);
const iri = () => `https://rezics.com/id/${randomUUID()}`;
const acting = (person: PersonaSession, actor = person.actingSubject!) => `actingSubject=${encodeURIComponent(actor)}`;

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
const grant = (person: PersonaSession, scope: string, action: string) => grantMangaFixtureAuthority(pool, person, scope, action);

// Fixture failures are outside outcomeTest and cannot be counted as expected product failures.
beforeAll(async () => {
  sessions = await personaSessions('public');
  pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const owner = sessions.owner, actor = owner.actingSubject;
  for (const title of ['Ink Garden', 'Ink Garden without a recorded date']) {
    const work = await answer<Work>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: `${title} ${randomUUID()}`, language: 'en',
      semanticTypes: ['https://schema.org/Book'], authoring: 'own-work', actingSubject: actor,
    }), 201);
    const draft = await answer<{ contribution: string; draftRevision: string; author: string }>(owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en',
      body: 'An original fictional manga: a gardener draws a river in ink and follows it to a new garden.', actingSubject: actor,
    }), 201);
    expect(draft.author).toBe(actor);
    const publication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
    }), 201);
    await answer(owner.main('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1', work: work.work, contribution: draft.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
      context: { kind: 'main-version-default', id: work.mainVersion }, selectionBasis: 'main-maintainer', actingSubject: actor,
    }), 201);
    if (!manga) manga = work; else undated = work;
  }
  for (const [scope, action] of [
    ['semantic:create:root', 'semantic.change'],
    ['classification:decide:global', 'statement.decide'],
    ['classification:define:global', 'classification.proposition.define'],
    ['context:create:root', 'context.create'],
  ]) await grant(owner, scope!, action!);
  const term = await answer<{ concept: string; definitionRevision: string }>(owner.main('POST', '/v1/classification-vocabulary', {
    profile: 'classification-proposition-v2', scheme: null, labels: [{ language: 'en', value: 'Manga' }],
    alternativeLabels: [], broader: [], narrower: [], actingSubject: actor,
  }), 201);
  const context = await answer<{ context: string; semanticRevision: string }>(owner.main('POST', '/v1/contexts', classificationContextBody(actor!, [term])), 201);
  for (const work of [manga, undated]) {
    const classified = await answer<{ statement: string; meaningKey: string }>(owner.main('POST', '/v1/statements', classifiedStatementBody(actor!, work.mainVersion, term.concept, context)), 201);
    await answer(owner.main('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target: { kind: 'qualified-fact', meaningKey: classified.meaningKey, support: [classified.statement] },
      acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor,
    }), 201);
  }
  const published = await seedFirstPublicationDate({
    post: <T,>(path: string, body: object, key: string) => answer<T>(owner.main('POST', path, body, key), 201),
    authorizeDefinition: receipt => grant(owner, `semantic:read:${receipt.component}`, 'semantic.read'),
    currentDefinition: async notation => {
      const response = await owner.main('GET', `/v1/lexicon/definitions/${notation}?${acting(owner)}`);
      if (response.status === 404) return null;
      const current = await answer<{ definition: string; revision: string; kind: string; lifecycle: string; roles: never[] }>(Promise.resolve(response));
      if (current.kind !== 'property' || current.lifecycle !== 'active' || current.roles.length) return null;
      return { component: current.definition, revision: current.revision,
        state: { component: 'definition' as const, kind: 'property' as const, lifecycle: 'active' as const,
          successor: null, roles: [], notation } };
    },
  }, actor!);
  const statement = await answer<{ statement: string }>(owner.main('POST', '/v1/statements', {
    profile: 'statement-v1', speaker: { kind: 'personal' }, subject: manga.work,
    predicate: published.component, relationDefinition: published.revision,
    value: { kind: 'literal', lexical: '1995-07-12', datatype: 'http://www.w3.org/2001/XMLSchema#date', language: null },
    applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: actor,
  }), 201);
  await answer(owner.main('POST', '/v1/statement-decisions', {
    profile: 'statement-decision-v1', target: { kind: 'statement', statement: statement.statement },
    acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor,
  }), 201);
  const realization = iri();
  const text = await answer<{ revision: string }>(owner.main('PUT', `/v1/works/${short(manga.work)}/realizations/${short(realization)}`, {
    profile: 'realization-v1', id: realization, expectedHead: null, actingSubject: actor,
    language: 'ja', kind: 'original', translators: [], publishers: [], source: { kind: 'unresolved', work: manga.work },
    status: 'official', verification: 'verified', evidence: manga.work,
  }));
  for (const title of ['Ink Garden tankōbon', 'Ink Garden omnibus']) {
    const id = iri();
    const saved = await answer<{ revision: string }>(owner.main('PUT', `/v1/works/${short(manga.work)}/releases/${short(id)}`, {
      profile: 'release-v2', id, expectedHead: null, actingSubject: actor, kind: 'formal', status: 'official',
      titleLanguage: 'en', tracklistLanguage: null, title: { value: title, language: 'en' }, editionStatement: null,
      publisher: 'Original fixture owner', publicationYear: 2024, isbn13: null, originalUrl: null, fixedRelease: null,
      identifiers: [], platform: 'Print', territory: null,
      coverage: [{ realization, revision: text.revision, completeness: 'complete' }], evidence: null,
    }));
    releases.push({ id, revision: saved.revision, title: { value: title } });
  }
  await answer(owner.main('POST', '/v1/compositions', {
    profile: 'work-composition', work: manga.work, mainVersion: manga.mainVersion, actingSubject: actor,
  }), 201);
}, 180_000);
afterAll(async () => { await sessions?.close(); await pool?.end(); });

const preferencePath = () => `/v1/me/edition-preferences/${short(manga.work)}`;
const summaryPath = () => `/v1/me/progress-summaries/${short(manga.work)}`;
const choice = (person: PersonaSession, release: Release, expectedVersion = 0, actor = person.actingSubject) => ({
  actingSubject: actor, expectedVersion, language: 'ja', edition: { kind: 'release', resource: release.id, revision: release.revision },
});
async function publicHub(person: PersonaSession) {
  const query = person.actingSubject ? `?${acting(person)}` : '';
  for (const [work, dates] of [[manga, ['1995-07-12']], [undated, []]] as const) {
    await answer(person.main('GET', `/v1/works/${short(work.work)}${query}`));
    const page = await answer<{ groups: { predicate: string; items: { value?: { lexical?: string } }[] }[] }>(
      person.main('GET', `/v1/resources/${short(work.work)}/statements${query}`));
    expect(page.groups.filter(group => group.predicate === 'https://schema.org/datePublished')
      .flatMap(group => group.items.map(item => item.value?.lexical))).toEqual(dates);
    const credit = await answer<{ items: { agent: string | null; role: string }[] }>(person.main('GET', `/v1/works/${short(work.work)}/credits${query}`));
    expect(credit.items).toContainEqual(expect.objectContaining({ agent: sessions.owner.actingSubject, role: 'author' }));
  }
  const page = await answer<{ items: Release[] }>(person.main('GET', `/v1/works/${short(manga.work)}/releases${query}`));
  expect(page.items.map(item => item.id).sort()).toEqual(releases.map(item => item.id).sort());
  for (const release of releases) expect(await answer(person.main('GET', `/v1/works/${short(manga.work)}/releases/${short(release.id)}${query}`))).toMatchObject(release);
}
async function reader(name: Exclude<PersonaName, 'visitor'>) {
  const person = sessions[name];
  await publicHub(person);
  expect(await answer(person.main('GET', `${preferencePath()}?${acting(person)}`))).toBeNull();
  const commands = releases.map(release => ({ body: choice(person, release), key: randomUUID() }));
  const responses = await Promise.all(commands.map(command => person.main('PUT', preferencePath(), command.body, command.key)));
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  const index = responses.findIndex(response => response.status === 200), winner = commands[index]!;
  const saved = await answer<Preference & { replayed: boolean }>(Promise.resolve(responses[index]!));
  const { replayed: _replayed, ...retained } = saved;
  expect(retained).toMatchObject({ work: manga.work, language: 'ja', version: 1, edition: winner.body.edition });
  expect(await answer(Promise.resolve(responses[1 - index]!), 409)).toMatchObject({ code: 'stale_edition_preference', current: retained });
  expect(await answer(person.main('PUT', preferencePath(), winner.body, winner.key))).toEqual({ ...retained, replayed: true });
  expect(await answer(person.main('GET', `${summaryPath()}?language=ja&${acting(person)}`))).toMatchObject({ preference: retained, language: 'ja' });
  expect(await answer(person.main('PUT', preferencePath(), { ...choice(person, releases[0]!, 1), language: 'fr' }), 400)).toMatchObject({ code: 'invalid_edition_preference' });
  expect(await answer(person.main('PUT', `/v1/me/edition-preferences/${short(undated.work)}`, choice(person, releases[0]!)), 404)).toMatchObject({ code: 'work_unavailable' });
  const target = name === 'owner' ? sessions.member : sessions.owner;
  const before = await answer(target.main('GET', `${preferencePath()}?${acting(target)}`));
  for (const path of [preferencePath(), summaryPath()]) expect(await answer(person.main('GET', `${path}?${acting(person, target.actingSubject!)}`), 403)).toMatchObject({ code: 'progress_denied' });
  expect(await answer(person.main('PUT', preferencePath(), choice(person, releases[0]!, 1, target.actingSubject)), 403)).toMatchObject({ code: 'progress_denied' });
  expect(await answer(target.main('GET', `${preferencePath()}?${acting(target)}`))).toEqual(before);
  if (name === 'moderator' || name === 'operator') {
    const selected = releases[0]!;
    const command = { profile: 'release-v2', id: selected.id, expectedHead: selected.revision, actingSubject: person.actingSubject,
      kind: 'formal', status: 'official', titleLanguage: 'en', tracklistLanguage: null, title: { value: 'Corrected original imprint', language: 'en' },
      editionStatement: null, publisher: 'Original fixture owner', publicationYear: 2024, isbn13: null, originalUrl: null,
      fixedRelease: null, identifiers: [], platform: 'Print', territory: null, coverage: [], evidence: manga.work };
    // A valid write shape is obtained from the retained release, preserving its coverage.
    const current = await answer<{ coverage: { realization: string; revision: string; completeness: string }[] }>(person.main('GET', `/v1/works/${short(manga.work)}/releases/${short(selected.id)}?${acting(person)}`));
    command.coverage = current.coverage.map(({ realization, revision, completeness }) => ({ realization, revision, completeness })) as never[];
    const path = `/v1/works/${short(manga.work)}/releases/${short(selected.id)}`;
    await answer(person.main('PUT', path, command), 403);
    if (name === 'operator') {
      await grant(person, `work:edit:${manga.work}`, 'work.edit');
      await answer(person.main('PUT', path, command));
      // A target Work mandate does not establish control of the target reader.
      await answer(person.main('GET', `${preferencePath()}?${acting(person, sessions.owner.actingSubject!)}`), 403);
      expect(await answer(person.main('GET', `${preferencePath()}?${acting(person)}`))).toEqual(retained);
    }
  }
}
outcomeTest(hub, 'visitor', async () => {
  const person = sessions.visitor;
  await publicHub(person);
  for (const path of [preferencePath(), summaryPath()]) await answer(person.main('GET', `${path}?${acting(person, sessions.owner.actingSubject!)}`), 401);
  await answer(person.main('PUT', preferencePath(), choice(person, releases[0]!, 0, sessions.owner.actingSubject)), 401);
});
outcomeTest(hub, 'stranger', () => reader('stranger'));
outcomeTest(hub, 'member', () => reader('member'));
outcomeTest(hub, 'owner', () => reader('owner'));
outcomeTest(hub, 'moderator', () => reader('moderator'));
outcomeTest(hub, 'operator', () => reader('operator'));
