import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import catalogue from '../../../../../scripts/qa/cases/outcomes/manga/catalogue-browse-and-search-in-its-zone.ts';
import { classificationContextBody, classifiedStatementBody, discloseClassificationConcept, type ClassificationPost } from '../../../../../scripts/dev/seed/classified-statement.ts';
import { seedFirstPublicationDate } from '../../../../../scripts/dev/seed/relation-lexicon.ts';
import { grantMangaFixtureAuthority } from '../../../../../scripts/qa/cases/outcomes/manga/work-hub-and-edition-choice.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string; contribution: string; publicationDecision: string; concept: string | null; year: number | null; status: string };
type Page = { items: { id: string; primaryCredits: { agent: string | null; role: string }[] }[]; nextCursor: string | null;
  matches: { value: number; kind: string }; query: { publicationYear?: string; filter: { all: unknown[] } }; window: { complete: boolean } };
setDefaultTimeout(90_000);
let sessions: PersonaSessions, pool: Pool;
let manga: string, oneShot: string, statement: string, privateWork: string;
const works: Work[] = [];
const phrase = `InkCatalogue${randomUUID().replaceAll('-', '')}`;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
const grant = (person: PersonaSession, scope: string, action: string) => grantMangaFixtureAuthority(pool, person, scope, action);
beforeAll(async () => {
  sessions = await personaSessions('public');
  pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const owner = sessions.owner, actor = owner.actingSubject!;
  const root = `/v1/realms/${short(sessions.realm)}`;
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Original catalogue publishers', permissions: ['publication.adopt'] },
    { kind: 'assignment', roleId, member: actor, assigned: true, validUntil: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    const roles = await answer<{ generation: string }>(owner.main('GET', `${root}/roles?${acting(owner)}`));
    const command = { actingSubject: actor, expectedGeneration: roles.generation, reason: 'Publish the original Manga fixtures', change };
    const preview = await answer<{ digest: string }>(owner.main('POST', `${root}/role-impact`, command));
    await answer(owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }), 201);
  }
  for (const [scope, action] of [
    ['semantic:create:root', 'semantic.change'], ['classification:define:global', 'classification.proposition.define'],
    ['classification:decide:global', 'statement.decide'], ['context:create:root', 'context.create'],
  ]) await grant(owner, scope!, action!);
  const terms: { concept: string; definitionRevision: string }[] = [];
  for (const label of ['Manga', 'One-shot']) {
    const term = await answer<{ concept: string; definitionRevision: string }>(owner.main('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: null, labels: [{ language: 'en', value: label }], alternativeLabels: [],
      broader: [], narrower: [], actingSubject: actor,
    }), 201);
    terms.push(term);
    const post: ClassificationPost = <T,>(path: string, body: unknown, _token: string, key: string) => answer<T>(owner.main('POST', path, body, key), 201);
    await discloseClassificationConcept(post, '', actor, term.concept, randomUUID());
  }
  manga = terms[0]!.concept; oneShot = terms[1]!.concept;
  const context = await answer<{ context: string; semanticRevision: string }>(owner.main('POST', '/v1/contexts', classificationContextBody(actor, terms)), 201);
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
  }, actor);
  for (let index = 0; index < 10; index++) {
    const work = await answer<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: `${phrase} ${index}`, language: 'en', semanticTypes: ['https://schema.org/Book'],
      authoring: 'own-work', actingSubject: actor,
    }), 201);
    if (index === 9) {
      privateWork = work.work;
      await grant(sessions.operator, `work:read:${work.work}`, 'work.read');
      continue;
    }
    const draft = await answer<{ contribution: string; draftRevision: string; author: string }>(owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en', body: `An original fictional manga chapter: ink gardener ${index} draws a new garden.`, actingSubject: actor,
    }), 201);
    expect(draft.author).toBe(actor);
    const publication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
    }), 201);
    const selection = { work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null, actingSubject: actor };
    await answer(owner.main('POST', '/v1/publication-selections', { ...selection, profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion }, selectionBasis: 'main-maintainer' }), 201);
    await answer(owner.main('POST', '/v1/publication-selections', { ...selection, profile: 'realm-local-selection-v1',
      context: { kind: 'realm-local', id: sessions.realm }, mainVersion: work.mainVersion, selectionBasis: 'realm-manager-review' }), 201);
    const status = index % 3 === 0 ? 'upcoming' : index % 3 === 1 ? 'completed' : 'cancelled';
    await answer(owner.main('PUT', `/v1/works/${short(work.work)}/metadata`, { profile: 'work-metadata-details-v1', expectedHead: null,
      state: { kind: 'header', originalTitle: null, localized: [], completionStatus: status }, actingSubject: actor }));
    const concept = index === 7 ? oneShot : index === 8 ? null : manga;
    if (concept) {
      const recorded = await answer<{ statement: string; meaningKey: string }>(owner.main('POST', '/v1/statements', classifiedStatementBody(actor, work.mainVersion, concept, context)), 201);
      statement ??= recorded.statement;
      await answer(owner.main('POST', '/v1/statement-decisions', { profile: 'statement-decision-v1',
        target: { kind: 'qualified-fact', meaningKey: recorded.meaningKey, support: [recorded.statement] },
        acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor }), 201);
    }
    const year = index === 6 || index === 8 ? null : index < 6 ? 1995 : 2001;
    if (year) {
      const recorded = await answer<{ statement: string }>(owner.main('POST', '/v1/statements', {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.work, predicate: published.component,
        relationDefinition: published.revision, value: { kind: 'literal', lexical: `${year}-07-12`, datatype: 'http://www.w3.org/2001/XMLSchema#date', language: null },
        applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: actor,
      }), 201);
      await answer(owner.main('POST', '/v1/statement-decisions', { profile: 'statement-decision-v1',
        target: { kind: 'statement', statement: recorded.statement }, acceptance: { kind: 'global' },
        expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor }), 201);
    }
    works.push({ ...work, ...selection, concept, year, status });
  }
  // Catalogue filters consume a Realm Discovery generation. Build it through
  // its separately mandated platform API after all fixture publication writes.
  await answer(sessions.visitor.main('GET', `${root}/modules/browse?limit=3`));
  const operator = sessions.operator;
  await grant(operator, 'recommendation:manage', 'recommendation.generation.manage');
  let generation = await answer<{ generation: string; checkpoint: string; complete: boolean }>(operator.main('POST', '/v1/discovery/generation-builds', {
    profile: 'discovery-generation-build-v1', actingSubject: operator.actingSubject,
    basis: { scope: 'realm', realm: sessions.realm, context: null },
  }));
  while (!generation.complete) generation = await answer(operator.main('POST', `/v1/discovery/generations/${generation.generation}/advance`, {
    actingSubject: operator.actingSubject, expectedCheckpoint: generation.checkpoint,
  }));
}, 300_000);
afterAll(async () => { await sessions?.close(); await pool?.end(); });

async function browse(name: PersonaName) {
  const person = sessions[name], root = `/v1/realms/${short(sessions.realm)}/modules/browse`;
  for (const filter of [{}, { q: phrase }, { concept: manga }, { concept: oneShot }, { status: 'upcoming' },
    { publicationYear: '1995' }, { publicationYear: '1995-2001', concept: manga },
    { q: phrase, publicationYear: '1995', concept: manga, status: 'upcoming' }]) {
    const expected = works.filter(work => (!('concept' in filter) || work.concept === filter.concept)
      && (!('status' in filter) || work.status === filter.status)
      && (!('publicationYear' in filter) || work.year !== null && (filter.publicationYear === '1995-2001' || work.year === 1995)));
    const params = new URLSearchParams({ ...filter, sort: 'newest', limit: '3' });
    const seen: string[] = [], cursors = new Set<string>();
    let page: Page;
    do {
      page = await answer<Page>(person.main('GET', `${root}?${params}`));
      for (const item of page.items) expect(item.primaryCredits).toContainEqual(expect.objectContaining({ agent: sessions.owner.actingSubject, role: 'author' }));
      seen.push(...page.items.map(item => item.id));
      if ('publicationYear' in filter) {
        expect(page.query.publicationYear).toBe(filter.publicationYear);
        const [min, max = min] = filter.publicationYear!.split('-');
        expect(page.query.filter.all).toContainEqual({ facet: 'publicationYear', range: { min, max } });
      }
      if (page.nextCursor) {
        expect(cursors.has(page.nextCursor)).toBe(false);
        cursors.add(page.nextCursor); params.set('cursor', page.nextCursor);
      }
    } while (page.nextCursor);
    expect(seen.length).toBe(expected.length);
    expect(new Set(seen).size).toBe(expected.length);
    expect(seen.sort()).toEqual(expected.map(work => work.work).sort());
    expect(seen).not.toContain(privateWork);
    expect(page.matches).toEqual({ value: expected.length, kind: 'exact' });
    expect(page.window.complete).toBe(true);
    if (expected.length > 3) expect(cursors.size).toBeGreaterThan(0);
  }
  if (name !== 'visitor' && name !== 'owner') {
    await answer(person.main('POST', '/v1/statement-decisions', { profile: 'statement-decision-v1',
      target: { kind: 'statement', statement }, acceptance: { kind: 'global' }, expectedDecisionHead: null,
      outcome: 'rejected', actingSubject: person.actingSubject }), 403);
    const work = works[0]!;
    await answer(person.main('POST', '/v1/publication-selections', { profile: 'realm-local-selection-v1',
      work: work.work, contribution: work.contribution, publicationDecision: work.publicationDecision,
      expectedSelectionHead: null, context: { kind: 'realm-local', id: sessions.realm }, mainVersion: work.mainVersion,
      selectionBasis: 'realm-manager-review', actingSubject: person.actingSubject }), 403);
  }
}
outcomeTest(catalogue, 'visitor', () => browse('visitor'));
outcomeTest(catalogue, 'stranger', () => browse('stranger'));
outcomeTest(catalogue, 'member', () => browse('member'));
outcomeTest(catalogue, 'owner', () => browse('owner'));
outcomeTest(catalogue, 'moderator', () => browse('moderator'));
outcomeTest(catalogue, 'operator', () => browse('operator'));
