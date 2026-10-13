import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { grantLaunchRecipeAuthority } from '../../../../../scripts/load/launch-corpus.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(90_000);
let sessions: PersonaSessions;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
type Work = { work: string; mainVersion: string };
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
async function grant(person: PersonaSession, scope: string, action: string) {
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    const principal = await pool.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_subject = $1 AND active', [person.accountId]);
    expect(principal.rows).toHaveLength(1);
    await grantLaunchRecipeAuthority(pool, principal.rows[0]!.id, person.actingSubject!, scope, action);
  } finally { await pool.end(); }
}
async function publish(title: string): Promise<Work> {
  const owner = sessions.owner;
  const work = await answer<Work>(owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/TVSeries'],
    authoring: 'own-work', actingSubject: owner.actingSubject,
  }), 201);
  const draft = await answer<{ contribution: string; draftRevision: string }>(
    owner.main('POST', '/v1/contributions', { profile: 'text-contribution-v1',
      work: work.work, language: 'en', body: `Original fixture animation script by Outcome owner: ${title}.`,
      actingSubject: owner.actingSubject }), 201);
  const publication = await answer<{ publicationDecision: string }>(
    owner.main('POST', '/v1/contribution-publications', { profile: 'text-publication-v1',
      contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: owner.actingSubject }), 201);
  await answer(owner.main('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
    work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: owner.actingSubject,
  }), 201);
  return work;
}
afterAll(async () => { await sessions?.close(); });

import hub from '../../../../../scripts/qa/cases/outcomes/anime/work-hub-and-edition-choice.ts';
import { seedFirstPublicationDate } from '../../../../../scripts/dev/seed/relation-lexicon.ts';
const DATE_PUBLISHED_PREDICATE = 'https://schema.org/datePublished';
const DATE_PUBLISHED_DEFINITION_NOTATION = 'statement-first-publication-date-v1';
let dated: Work, undated: Work;
const releases: { id: string; revision: string; title: string }[] = [];
beforeAll(async () => {
  sessions = await personaSessions();
  const owner = sessions.owner, actor = owner.actingSubject!;
  dated = await publish('Original animation: Lantern harbour');
  undated = await publish('Original animation: Undated harbour');
  for (const [scope, action] of [
    ['semantic:create:root', 'semantic.change'],
    [`statement:speak:${actor}`, 'statement.record'],
    ['classification:decide:global', 'statement.decide'],
    ['classification:define:global', 'classification.proposition.define'],
    ['catalogue:verify:root', 'catalogue.verify'],
  ]) await grant(owner, scope!, action!);
  // Public vocabulary creation establishes the Global acceptance context for date decisions.
  await answer(owner.main('POST', '/v1/classification-vocabulary', {
    profile: 'classification-proposition-v2', scheme: null,
    labels: [{ language: 'en', value: 'Original fixture TV animation' }],
    alternativeLabels: [], broader: [], narrower: [], actingSubject: actor,
  }), 201);
  const definition = await seedFirstPublicationDate({
    post: <T,>(path: string, body: object, key: string) => answer<T>(owner.main('POST', path, body, key), 201),
    authorizeDefinition: receipt => grant(owner, `semantic:read:${receipt.component}`, 'semantic.read'),
    currentDefinition: async key => {
      const response = await owner.main('GET', `/v1/lexicon/definitions/${key}?${acting(owner)}`);
      if (response.status === 404) return null;
      const value = await answer<{ definition: string; revision: string; kind: string; lifecycle: string }>(Promise.resolve(response));
      return { component: value.definition, revision: value.revision,
        state: { component: 'definition', kind: 'property', notation: DATE_PUBLISHED_DEFINITION_NOTATION,
          lifecycle: 'active', successor: null, roles: [] } };
    },
  }, actor);
  const statement = await answer<{ statement: string }>(owner.main('POST', '/v1/statements', {
    profile: 'statement-v1', speaker: { kind: 'personal' }, subject: dated.work,
    predicate: definition.component, relationDefinition: definition.revision,
    value: { kind: 'literal', lexical: '2004-04-01', datatype: 'http://www.w3.org/2001/XMLSchema#date', language: null },
    applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: actor,
  }), 201);
  await answer(owner.main('POST', '/v1/statement-decisions', {
    profile: 'statement-decision-v1', target: { kind: 'statement', statement: statement.statement },
    acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor,
  }), 201);
  const realization = `https://rezics.com/id/${randomUUID()}`;
  const text = await answer<{ revision: string }>(owner.main('PUT',
    `/v1/works/${short(dated.work)}/realizations/${short(realization)}`, {
      profile: 'realization-v1', id: realization, expectedHead: null, actingSubject: actor,
      language: 'en', kind: 'original', translators: [], publishers: [],
      source: { kind: 'unresolved', work: dated.work }, status: 'official', verification: 'verified',
      evidence: `https://rezics.com/id/${randomUUID()}`,
    }));
  for (const title of ['Lantern harbour broadcast', 'Lantern harbour restored release']) {
    const id = `https://rezics.com/id/${randomUUID()}`;
    const release = await answer<{ revision: string }>(owner.main('PUT',
      `/v1/works/${short(dated.work)}/releases/${short(id)}`, {
        profile: 'release-v2', id, expectedHead: null, actingSubject: actor,
        kind: 'formal', status: 'official', titleLanguage: 'en', tracklistLanguage: null,
        title: { value: title, language: 'en' }, editionStatement: null, publisher: 'Fixture owner',
        publicationYear: 2004, isbn13: null, originalUrl: null, fixedRelease: null,
        identifiers: [], platform: 'Broadcast', territory: null,
        coverage: [{ realization, revision: text.revision, completeness: 'complete' }], evidence: null,
      }));
    releases.push({ id, revision: release.revision, title });
  }
  await answer(owner.main('POST', '/v1/compositions', { profile: 'work-composition',
    work: dated.work, mainVersion: dated.mainVersion, actingSubject: actor }), 201);
}, 180_000);

async function journey(name: PersonaName) {
  const person = sessions[name];
  for (const work of [dated, undated]) {
    const query = person.actingSubject ? `?${acting(person)}` : '';
    expect(await answer(person.main('GET', `/v1/works/${short(work.work)}${query}`)))
      .toMatchObject({ id: work.work, disclosure: 'public', selectedLanguage: 'en', types: ['https://schema.org/TVSeries'] });
    const statements = await answer<{ groups: { predicate: string; items: { value?: { lexical: string } }[] }[] }>(
      person.main('GET', `/v1/resources/${short(work.work)}/statements${query}`));
    const dates = statements.groups.filter(group => group.predicate === DATE_PUBLISHED_PREDICATE)
      .flatMap(group => group.items.map(item => item.value?.lexical));
    expect(dates).toEqual(work === dated ? ['2004-04-01'] : []);
    const credit = await person.main('GET', `/v1/works/${short(work.work)}/credits${query}`);
    expect(credit.status).toBe(200);
    expect(await credit.text()).toContain(sessions.owner.actingSubject!);
  }
  const root = `/v1/works/${short(dated.work)}`;
  const query = person.actingSubject ? `?${acting(person)}` : '';
  const list = await answer<{ items: { id: string }[] }>(person.main('GET', `${root}/releases${query}`));
  expect(list.items.map(item => item.id).sort()).toEqual(releases.map(item => item.id).sort());
  for (const release of releases) {
    expect(await answer(person.main('GET', `${root}/releases/${short(release.id)}${query}`)))
      .toMatchObject({ id: release.id, revision: release.revision, title: { value: release.title } });
  }
  const path = `/v1/me/edition-preferences/${short(dated.work)}`;
  const affected = name === 'owner' ? sessions.member : sessions.owner;
  const deniedStatus = name === 'visitor' ? 401 : 403;
  expect(await answer<{ code: string }>(person.main('GET', `${path}?${acting(affected)}`), deniedStatus))
    .toMatchObject({ code: name === 'visitor' ? 'account_assertion_denied' : 'progress_denied' });
  await answer(person.main('PUT', path, { actingSubject: affected.actingSubject, expectedVersion: 0,
    language: 'en', edition: { kind: 'release', resource: releases[0]!.id, revision: releases[0]!.revision } }), deniedStatus);
  if (name === 'visitor') return;
  expect(await answer(person.main('GET', `${path}?${acting(person)}`))).toBeNull();
  const choices = releases.map(release => ({ key: randomUUID(), body: { actingSubject: person.actingSubject,
    expectedVersion: 0, language: 'en', edition: { kind: 'release', resource: release.id, revision: release.revision } } }));
  const raced = await Promise.all(choices.map(choice => person.main('PUT', path, choice.body, choice.key)));
  expect(raced.map(response => response.status).sort()).toEqual([200, 409]);
  const index = raced.findIndex(response => response.status === 200);
  const saved = await answer<{ version: number; edition: object }>(Promise.resolve(raced[index]!));
  expect(saved).toMatchObject({ version: 1, edition: choices[index]!.body.edition, replayed: false });
  expect(await answer(Promise.resolve(raced[1 - index]!), 409)).toMatchObject({ code: 'stale_edition_preference' });
  expect(await answer(person.main('PUT', path, choices[index]!.body, choices[index]!.key)))
    .toMatchObject({ ...saved, replayed: true });
  expect(await answer(person.main('GET', `/v1/me/progress-summaries/${short(dated.work)}?${acting(person)}&language=en`)))
    .toMatchObject({ preference: { version: 1, edition: choices[index]!.body.edition } });
}
outcomeTest(hub, 'visitor', () => journey('visitor'));
outcomeTest(hub, 'stranger', () => journey('stranger'));
outcomeTest(hub, 'member', () => journey('member'));
outcomeTest(hub, 'owner', () => journey('owner'));
outcomeTest(hub, 'moderator', () => journey('moderator'));
outcomeTest(hub, 'operator', () => journey('operator'));

