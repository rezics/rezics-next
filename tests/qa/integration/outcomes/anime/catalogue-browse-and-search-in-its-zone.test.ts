import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { grantLaunchRecipeAuthority } from '../../../../../scripts/load/launch-corpus.ts';
import { outcomeResponse, outcomeTest } from '../../../support/outcome-test.ts';
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
async function publish(title: string): Promise<Work & { contribution: string; publicationDecision: string }> {
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
  return { ...work, contribution: draft.contribution, publicationDecision: publication.publicationDecision };
}
afterAll(async () => { await sessions?.close(); });

import catalogue from '../../../../../scripts/qa/cases/outcomes/anime/catalogue-browse-and-search-in-its-zone.ts';
import { acceptClassifiedStatement, discloseClassificationConcept, shareClassificationContext,
  type ClassificationPost } from '../../../../../scripts/dev/seed/classified-statement.ts';
import { seedFirstPublicationDate } from '../../../../../scripts/dev/seed/relation-lexicon.ts';
const DATE_PUBLISHED_DEFINITION_NOTATION = 'statement-first-publication-date-v1';

type Page = { items: { id: string }[]; nextCursor: string | null; matches: { value: number; kind: string };
  query: { filter: { all: unknown[] }; appliedSort: string } };
const works: Work[] = [], tvWorks: Work[] = [], dated: Work[] = [], completed: Work[] = [];
let tv: string, movie: string, draft: Work;
const phrase = `Lanternanime${randomUUID().replaceAll('-', '')}`;
const credentials = new Map<PersonaSession, Headers>();
const formatAnswers: { persona: string; request: string; status: number; answer: string }[] = [];
let preparationPopulation = 12;
let preparationDurationMs: number | undefined;
const preparationAnswers: { population: number; request: { method: string; path: string; body: unknown; key?: string }; status: number; answer: string }[] = [];
beforeAll(async () => {
  const started = Date.now();
  try {
  sessions = await personaSessions();
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    const person = sessions[name], main = person.main;
    person.main = async (method, path, body, key, options) => {
      key ??= method === 'GET' ? undefined : randomUUID();
      const response = await main(method, path, body, key, options);
      if (response.status >= 400 || (method === 'POST' && path === '/v1/contributions')) {
        preparationAnswers.push({ population: preparationPopulation, request: { method, path, body, key }, status: response.status,
          answer: await response.clone().text() });
        await Bun.write(`.temp/anime-catalogue-preparation-${Bun.env.REZICS_QA_RUN_ID}.json`,
          JSON.stringify({ durationMs: preparationDurationMs ?? Date.now() - started, preparationAnswers }, null, 2));
      }
      return response;
    };
  }
  const owner = sessions.owner, actor = owner.actingSubject!;
  const root = `/v1/realms/${short(sessions.realm)}`;
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Original animation publishers', permissions: ['publication.adopt'] },
    { kind: 'assignment', roleId, member: actor, assigned: true, validUntil: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    const roles = await answer<{ generation: string }>(owner.main('GET', `${root}/roles?${acting(owner)}`));
    const command = { actingSubject: actor, expectedGeneration: roles.generation,
      reason: 'Publish the original animation fixture catalogue', change };
    const preview = await answer<{ digest: string }>(owner.main('POST', `${root}/role-impact`, command));
    await answer(owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }), 201);
  }
  for (const [scope, action] of [
    ['classification:define:global', 'classification.proposition.define'],
    ['classification:decide:global', 'statement.decide'],
    ['context:create:root', 'context.create'],
    [`statement:speak:${actor}`, 'statement.record'],
    ['semantic:create:root', 'semantic.change'],
  ]) await grant(owner, scope!, action!);
  const post: ClassificationPost = async <T,>(path: string, body: unknown, _token: string, key: string) => {
    const response = await owner.main('POST', path, body, key);
    expect([200, 201]).toContain(response.status);
    return answer<T>(Promise.resolve(response), response.status);
  };
  const terms = [];
  for (const name of ['Fixture TV animation', 'Fixture film animation']) {
    terms.push(await post<{ concept: string; definitionRevision: string }>('/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: null, labels: [{ language: 'en', value: name }],
      alternativeLabels: [], broader: [], narrower: [], actingSubject: actor,
    }, '', randomUUID()));
  }
  tv = terms[0]!.concept; movie = terms[1]!.concept;
  const context = await shareClassificationContext(post, '', actor, terms, randomUUID());
  for (const term of terms) await discloseClassificationConcept(post, '', actor, term.concept, randomUUID());
  const date = await seedFirstPublicationDate({
    post: <T,>(path: string, body: object, key: string) => post<T>(path, body, '', key),
    authorizeDefinition: receipt => grant(owner, `semantic:read:${receipt.component}`, 'semantic.read'),
    currentDefinition: async key => {
      const response = await owner.main('GET', `/v1/lexicon/definitions/${key}?${acting(owner)}`);
      if (response.status === 404) return null;
      const value = await answer<{ definition: string; revision: string }>(Promise.resolve(response));
      return { component: value.definition, revision: value.revision, state: { component: 'definition',
        kind: 'property', notation: DATE_PUBLISHED_DEFINITION_NOTATION, lifecycle: 'active', successor: null, roles: [] } };
    },
  }, actor);
  const prepare = async (index: number) => {
    const work = await publish(`${phrase} original animation ${index}`);
    await answer(owner.main('POST', '/v1/publication-selections', {
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: sessions.realm },
      work: work.work, mainVersion: work.mainVersion, contribution: work.contribution,
      publicationDecision: work.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review', actingSubject: actor,
    }), 201);
    works[index] = work;
    if (index < 12) {
      const concept = index < 11 ? tv : movie;
      await acceptClassifiedStatement(post, '', actor, work, concept, context, { kind: 'global' },
        { state: 'none', source: 'global', decision: null }, { statement: randomUUID(), decision: randomUUID() });
      if (index < 11) tvWorks.push(work);
      const status = index < 11 ? 'completed' : 'ongoing';
      await answer(owner.main('PUT', `/v1/works/${short(work.work)}/metadata`, {
        profile: 'work-metadata-details-v1', expectedHead: null, actingSubject: actor,
        state: { kind: 'header', originalTitle: null, completionStatus: status, localized: [] },
      }));
      if (status === 'completed') completed.push(work);
      const statement = await post<{ statement: string }>('/v1/statements', {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.work,
        predicate: date.component, relationDefinition: date.revision,
        value: { kind: 'literal', lexical: index < 11 ? '2004-04-01' : '1999-01-01',
          datatype: 'http://www.w3.org/2001/XMLSchema#date', language: null },
        applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: actor,
      }, '', randomUUID());
      await post('/v1/statement-decisions', { profile: 'statement-decision-v1',
        target: { kind: 'statement', statement: statement.statement }, acceptance: { kind: 'global' },
        expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor,
      }, '', randomUUID());
      if (index < 11) dated.push(work);
    }
  };
  // Keep shared vocabulary setup serial; independent Work publication uses bounded HTTP concurrency.
  for (let index = 0; index < 12; index++) await prepare(index);
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    const person = sessions[name];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === `http://127.0.0.1:${Bun.env.MAIN_PORT}`) credentials.set(person, new Headers(init?.headers));
      return original(input, init);
    }, { preconnect: original.preconnect });
    try {
      await answer(person.main('GET', `/v1/works/${short(works[0]!.work)}${person.actingSubject ? `?${acting(person)}` : ''}`));
    } finally { globalThis.fetch = original; }
  }
  // The lifecycle owns shared Discovery refresh; readers never start a competing generation.
  for (const population of [33, 65]) {
    preparationPopulation = population;
    for (let first = works.length; first < population; first += 4) {
      await Promise.all(Array.from({ length: Math.min(4, population - first) }, (_, offset) => prepare(first + offset)));
    }
    await populationReads(population);
  }
  draft = await answer<Work>(owner.main('POST', '/v1/works', { profile: 'metadata-only-v1',
    title: `${phrase} unpublished original animation`, language: 'en', semanticTypes: ['https://schema.org/TVSeries'],
    authoring: 'own-work', actingSubject: actor }), 201);
  } finally {
    preparationDurationMs = Date.now() - started;
    await Bun.write(`.temp/anime-catalogue-preparation-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify({ durationMs: preparationDurationMs, preparationAnswers }, null, 2));
  }
}, 360_000);

async function traverse(person: PersonaSession, values: Record<string, string>, expected: Work[]) {
  const params = new URLSearchParams({ limit: '5', sort: 'newest', ...values });
  const ids: string[] = [];
  const cursors = new Set<string>();
  for (;;) {
    const page = await answer<Page>(person.main('GET',
      `/v1/realms/${short(sessions.realm)}/modules/browse?${params}`));
    ids.push(...page.items.map(item => item.id));
    expect(page.query.appliedSort).toBe(values.sort === 'relevance' ? 'newest' : values.sort ?? 'newest');
    if (values.publicationYear === '2004') expect(page.query.filter.all).toContainEqual({
      facet: 'publicationYear', range: { min: '2004', max: '2004' },
    });
    expect(page.matches.value).toBe(ids.length);
    expect(page.matches.kind).toBe(page.nextCursor ? 'lower-bound' : 'exact');
    if (!page.nextCursor) break;
    expect(cursors.has(page.nextCursor)).toBe(false);
    cursors.add(page.nextCursor);
    params.set('cursor', page.nextCursor);
  }
  expect(ids.length).toBe(expected.length);
  expect(new Set(ids).size).toBe(expected.length);
  expect(ids.sort()).toEqual(expected.map(work => work.work).sort());
  expect(ids).not.toContain(draft.work);
}
async function journey(name: PersonaName) {
  const person = sessions[name];
  const format = await formatResponse(person);
  formatAnswers.push({ persona: name, request: `GET ${formatPath()}`, status: format.status, answer: await format.clone().text() });
  await Bun.write(`.temp/anime-format-answers-${Bun.env.REZICS_QA_RUN_ID}.json`, JSON.stringify({ formatAnswers }, null, 2));
  if (name === 'visitor') await ancestry();
  const opening = await answer<Page>(Promise.resolve(format));
  expect(opening.items).toHaveLength(5);
  expect(opening.matches).toEqual({ value: 5, kind: 'lower-bound' });
  const queries = [
    ...['newest', 'updated', 'relevance'].flatMap(sort => [
      { sort, q: phrase }, ...(sort === 'relevance' ? [] : [{ sort }]),
    ].map(values => ({ values, expected: works }))),
    { values: { concept: tv }, expected: tvWorks },
    { values: { concept: movie }, expected: [works[11]!] },
    { values: { status: 'completed' }, expected: completed },
    { values: { publicationYear: '2004' }, expected: dated },
    { values: { concept: tv, status: 'completed', publicationYear: '2004', q: phrase }, expected: tvWorks },
    { values: { excludeConcept: tv }, expected: works.slice(11) },
    { values: { publicationYear: '1999' }, expected: [works[11]!] },
  ];
  const traversals = await Promise.allSettled(queries.map(query => traverse(person, query.values, query.expected)));
  for (const traversal of traversals) if (traversal.status === 'rejected') throw traversal.reason;
  // A global year template is a year vocabulary, not this Realm's inventory.
  const years: { id: string; year: number }[] = [];
  let cursor: string | null = null;
  const cursors = new Set<string>();
  do {
    const response = await answer<{ result: { items: { id: string; year: number }[]; nextCursor: string | null } }>(
      person.main('POST', '/v1/query', { profile: 'template-query-v1',
        query: 'https://rezics.com/query/work-publication-years', revision: 1,
        parameters: { fromYear: 1999, toYear: 2004 }, limit: 5,
        ...(person.actingSubject ? { presentation: { actingSubject: person.actingSubject } } : {}),
        ...(cursor ? { cursor } : {}),
      }));
    years.push(...response.result.items);
    cursor = response.result.nextCursor;
    if (cursor) { expect(cursors.has(cursor)).toBe(false); cursors.add(cursor); }
  } while (cursor);
  expect(years.map(item => item.year)).toEqual(years.map(item => item.year).sort((a, b) => b - a));
  expect(years.map(item => item.id)).toContain(works[0]!.work);
  expect(years.map(item => item.id)).not.toContain(works[64]!.work);
  const refused = await answer<{ code: string }>(person.main('GET',
    `/v1/realms/${short(sessions.realm)}/modules/browse?sort=relevance&limit=5`), 400);
  expect(refused.code).toBe('unsupported_query_shape');
  const query = person.actingSubject ? `?${acting(person)}` : '';
  const credit = await person.main('GET', `/v1/works/${short(works[0]!.work)}/credits${query}`);
  expect(credit.status).toBe(200);
  expect(await credit.text()).toContain(sessions.owner.actingSubject!);
}
const qualification: { persona: string; passed: boolean; error?: string }[] = [];
async function qualify(name: PersonaName) {
  try {
    await journey(name);
    qualification.push({ persona: name, passed: true });
  } catch (error) {
    qualification.push({ persona: name, passed: false, error: String(error) });
    throw error;
  } finally {
    await Bun.write(`.temp/anime-catalogue-qualification-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify(qualification, null, 2));
  }
}
outcomeTest(catalogue, 'visitor', () => qualify('visitor'));
outcomeTest(catalogue, 'stranger', () => qualify('stranger'));
outcomeTest(catalogue, 'member', () => qualify('member'));
outcomeTest(catalogue, 'owner', () => qualify('owner'));
outcomeTest(catalogue, 'moderator', () => qualify('moderator'));
outcomeTest(catalogue, 'operator', () => qualify('operator'));

import { meterStatements } from '../../feed-read-support.ts';
import { foregroundCounted } from '../../support/operation-cost.ts';

type Observation = { population: number; request: string; status: number; graphStatements: number;
  postgresStatements: number; retries: number; answer: unknown };
const observations: Observation[] = [];
const ancestryFailures: { request: string; status: number; answer: string }[] = [];
const nativeWorks: string[] = [];
async function nativeSearchTraversal() {
  const params = new URLSearchParams({ q: phrase, realm: sessions.realm, limit: '5' });
  const cursors = new Set<string>();
  for (;;) {
    const path = `/v1/search/catalogue?${params}`;
    const response = await sessions.visitor.main('GET', path);
    const raw = await response.text();
    if (response.status !== 200) {
      ancestryFailures.push({ request: `GET ${path}`, status: response.status, answer: raw });
      return;
    }
    const page = JSON.parse(raw) as { results: { work: string }[]; next: string | null };
    nativeWorks.push(...page.results.map(item => item.work));
    if (!page.next) return;
    if (cursors.has(page.next)) throw new Error('Public search repeated its continuation');
    cursors.add(page.next); params.set('cursor', page.next);
  }
}
async function observe(population: number, path: string) {
  const sql = meterStatements();
  const originalFetch = globalThis.fetch;
  let graphStatements = 0, requests = 0;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === new URL(Bun.env.FUSEKI_URL!).origin && url.pathname.endsWith('/query') && foregroundCounted()) graphStatements++;
    if (url.origin === `http://127.0.0.1:${Bun.env.MAIN_PORT}` && url.pathname + url.search === path) requests++;
    return originalFetch(input, init);
  }, { preconnect: originalFetch.preconnect });
  try {
    const response = await sessions.visitor.main('GET', path);
    observations.push({ population, request: `GET ${path}`, status: response.status,
      graphStatements, postgresStatements: sql.count(), retries: Math.max(0, requests - 1),
      answer: await response.json() });
  } finally {
    sql.restore(); globalThis.fetch = originalFetch;
  }
}
async function restriction(population: number) {
  const unrelated = await publish(`Unrelated original animation at ${population}`);
  const owner = sessions.owner, operator = sessions.operator;
  await grant(owner, `work:read:${unrelated.work}`, 'work.read');
  const send = async <T,>(person: PersonaSession, path: string, body: Record<string, unknown>, status = 200) => {
    const key = randomUUID();
    const response = await person.main('POST', path, { ...body, idempotencyKey: key }, key);
    const raw = await response.text();
    if (response.status !== status) {
      ancestryFailures.push({ request: `POST ${path}: ${JSON.stringify(body)}`, status: response.status, answer: raw });
      return null;
    }
    return JSON.parse(raw) as T;
  };
  await grant(operator, 'governance:platform', 'governance.rule.publish');
  const rule = await send<{ ref: string; revision: string; digest: string }>(operator, '/v1/governance/rules', {
    profile: 'governance-rule-v1', ref: `urn:rezics:fixture-animation-rule:${randomUUID()}`,
    scopeId: 'governance:platform', actingSubject: operator.actingSubject, expectedRevision: null,
    document: { policy: 'Temporarily restrict only the named unrelated original fixture Work' },
  }, 201);
  if (!rule) return;
  const header = await answer<{ revision: string }>(owner.main('GET', `/v1/works/${short(unrelated.work)}?${acting(owner)}`));
  const report = await send<{ caseId: string }>(owner, '/v1/rights/complaints', {
    profile: 'rights-complaint-v1', actingSubject: owner.actingSubject,
    authority: { kind: 'platform', scopeId: 'governance:platform' }, context: 'urn:rezics:context:global',
    target: { owner: 'graph', resource: unrelated.work, component: 'name' },
    disclosure: 'parties', reasonCode: 'fixture_rights_review', statement: 'Synthetic dispute over this original fixture only',
    evidence: [{ owner: 'graph', resource: unrelated.work, component: 'name', revision: header.revision, locator: null }],
    complaint: { process: 'ordinary_dispute', claimantKind: 'rights_holder', claimantName: 'Outcome owner',
      claimantContact: null, claimedWork: 'Original fixture animation', claimedRight: 'copyright',
      noticeDigest: '1'.repeat(64), noticeReceivedAt: new Date().toISOString() },
  }, 201);
  if (!report) return;
  await grant(operator, 'governance:platform', 'governance.rights.decide');
  await grant(operator, 'governance:platform', 'governance.moderate');
  const claim = await send(operator, `/v1/safety-cases/${report.caseId}/claim`, { actingSubject: operator.actingSubject });
  if (!claim) return;
  const basis = await answer<{ generation: string; reports: { evidenceDigest: string }[] }>(
    operator.main('GET', `/v1/safety-cases/${report.caseId}?${acting(operator)}`));
  const key = randomUUID();
  const command = { profile: 'rights-restriction-v1', outcome: 'interim_restrict', caseId: report.caseId,
    expectedGeneration: basis.generation, actingSubject: operator.actingSubject,
    targets: [{ owner: 'graph', resource: unrelated.work, component: 'name', locator: null,
      scopeKind: 'component', revision: null, expectedHead: header.revision, effect: 'disclosure' }],
    rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest },
    evidenceDigest: basis.reports[0]!.evidenceDigest, reversesDecisionId: null, answersStepId: null,
    reasons: { facts: 'Synthetic dispute', scope: 'Only the unrelated fixture Work', duration: 'Until fixture review',
      automation: false, appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en' },
    rationale: 'An unrelated restriction must not change the Anime catalogue reader cost',
    disclosure: 'parties', idempotencyKey: key };
  const response = await operator.main('POST', '/v1/rights/restrictions', command, key);
  const raw = await response.text();
  if (![200, 202].includes(response.status)) {
    ancestryFailures.push({ request: `POST /v1/rights/restrictions: ${JSON.stringify(command)}`, status: response.status, answer: raw });
    return;
  }
  if (response.status === 202) {
    // Replaying the same command advances its documented enforcement operation.
    const replay = await operator.main('POST', '/v1/rights/restrictions', command, key);
    if (replay.status !== 200) {
      ancestryFailures.push({ request: 'POST /v1/rights/restrictions (same-key replay)', status: replay.status, answer: await replay.text() });
      return;
    }
  }
  await answer(sessions.visitor.main('GET', `/v1/works/${short(unrelated.work)}`), 404);
}
async function populationReads(population: number) {
  await restriction(population);
  for (const path of [
    `/v1/search/catalogue?q=${phrase}&realm=${encodeURIComponent(sessions.realm)}&limit=5`,
    `/v1/sitemap?after=${encodeURIComponent(works[population - 6]!.work)}`,
    `/v1/works/${short(works[0]!.work)}`,
  ]) await observe(population, path);
  if (population === 65) await nativeSearchTraversal();
  await Bun.write(`.temp/anime-catalogue-cost-${Bun.env.REZICS_QA_RUN_ID}.json`,
    JSON.stringify({ observations, ancestryFailures, nativeWorks }, null, 2));
}
async function ancestry() {
  expect(ancestryFailures, JSON.stringify(ancestryFailures)).toEqual([]);
  expect(observations).toHaveLength(6);
  expect(nativeWorks.length).toBe(65);
  expect(new Set(nativeWorks).size).toBe(65);
  for (let index = 0; index < 3; index++) {
    const before = observations[index]!, after = observations[index + 3]!;
    expect(before.status, JSON.stringify(before)).toBe(200);
    expect(after.status, JSON.stringify(after)).toBe(200);
    expect(before.graphStatements).toBeGreaterThan(0);
    if (index === 0) expect(before.postgresStatements).toBeGreaterThan(0);
    else expect(before.postgresStatements).toBeGreaterThanOrEqual(0);
    expect(after.graphStatements, JSON.stringify({ before, after })).toBeLessThanOrEqual(before.graphStatements);
    expect(after.postgresStatements, JSON.stringify({ before, after })).toBeLessThanOrEqual(before.postgresStatements);
    expect(after.retries, JSON.stringify({ before, after })).toBeLessThanOrEqual(before.retries);
  }
  expect(nativeWorks.slice().sort()).toEqual(works.map(work => work.work).sort());
}

function formatPath() {
  return `/v1/realms/${short(sessions.realm)}/modules/browse?sort=newest&limit=5&concept=${encodeURIComponent(tv)}`;
}

async function formatResponse(person: PersonaSession): Promise<Response> {
  let last: Response | undefined;
  try {
    // These headers came from this persona's actual OAuth-backed HTTP request.
    // The shared helper repeats only work_read_unavailable; retain its last public
    // refusal when the deadline aborts the next fetch.
    return await outcomeResponse(async signal => {
      const response = await fetch(`http://127.0.0.1:${Bun.env.MAIN_PORT}${formatPath()}`, {
        headers: credentials.get(person), signal,
      });
      last = response.clone();
      return response;
    }, 5_000);
  } catch (error) {
    if (last?.status === 503 && (await last.clone().json() as { code?: string }).code === 'work_read_unavailable') return last;
    throw error;
  }
}



