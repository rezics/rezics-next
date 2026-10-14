import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fromPlainText } from '@rezics/document';
import { sourceIdentity } from '../../../scripts/qa/core.ts';
import { DEFAULT_ZONE_PRESENTATION, ZONE_PUBLIC_READ_SOURCES } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { personaNames, personaSessions, type PersonaSession, type PersonaSessions } from '../support/personas.ts';
import { closureCommand, closureOriginal, closureRole, effectClosure, publishClosureRule }
  from './outcomes/realm/closure-fixture.ts';

type Page = { reference: { revisionId: string; byteDigest: string; resourceId: string;
  provenance: { rightsBasis: string; author: string } }; document: unknown };
type Route = { realm: string | null; revision: string; page?: Page; resource?: { id: string };
  items?: { id: string; inZone: boolean }[]; nextCursor?: string | null };
type Presentation = { realm: string | null; revision: string; home?: Page;
  navigation: { target: string }[]; moduleData: { sources: { state: string; members: unknown[] }[] }[] };
const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession, parameters: Record<string, string> = {}) => {
  const values = new URLSearchParams(parameters);
  if (person.actingSubject) values.set('actingSubject', person.actingSubject);
  return values.size ? `?${values}` : '';
};
const started = performance.now();
const source = sourceIdentity(process.cwd());
const requests: unknown[] = [];
const timings: { phase: string; elapsedMs: number }[] = [];
let sessions: PersonaSessions;
let original: Awaited<ReturnType<typeof closureOriginal>>;
let root: string;
let home: Page;
let revision: string;
let exact: unknown;
let credits: unknown;
let completed = false;

beforeAll(async () => {
  sessions = await personaSessions('public', { observeMain: async evidence => {
    requests.push({ caller: evidence.caller.accountId, actingSubject: evidence.caller.actingSubject,
      request: evidence.request, answer: evidence.response, requestedAt: evidence.requestStartedAt,
      answeredAt: evidence.answeredAt, elapsedMs: evidence.answeredAt - evidence.requestStartedAt });
  } });
  timings.push({ phase: 'persona-preparation', elapsedMs: performance.now() - started });
  const owner = sessions.owner;
  root = `/v1/zones/${short(sessions.zone)}`;
  const rule = await publishClosureRule(sessions);
  original = await closureOriginal(owner, `Independent Zone original ${randomUUID()}`);
  await closureRole(sessions, owner, ['publication.adopt']);
  await closureCommand(owner, 'POST', '/v1/publication-selections', {
    profile: 'realm-local-selection-v1', work: original.work, contribution: original.contribution,
    publicationDecision: original.publicationDecision, expectedSelectionHead: null,
    context: { kind: 'realm-local', id: sessions.realm }, mainVersion: original.mainVersion,
    selectionBasis: 'realm-manager-review', actingSubject: owner.actingSubject,
  }, 201);
  const configuration = await closureCommand<{ revision: string }>(owner, 'GET', `${root}/configuration${query(owner)}`);
  await closureCommand(owner, 'PUT', `${root}/configuration`, {
    actingSubject: owner.actingSubject, expectedHead: configuration.revision, defaultRealm: sessions.realm,
    prepareHomeDocument: true, presentation: { ...DEFAULT_ZONE_PRESENTATION,
      modules: ZONE_PUBLIC_READ_SOURCES.map(block => ({ id: block, type: 'shelf', title: block,
        source: { kind: 'query-block', block } })) },
  });
  const prepared = await closureCommand<{ revision: string; configuration: { homeDocument: string } }>(owner,
    'GET', `${root}/configuration${query(owner)}`);
  const homeDocument = prepared.configuration.homeDocument;
  expect(homeDocument).not.toBe(sessions.zone);
  const navigation = await closureCommand<{ revision: string }>(owner, 'GET', `${root}${query(owner)}`);
  let mount = await closureCommand<{ revision: string }>(owner, 'POST', `${root}/mounts`, {
    expectedHead: navigation.revision, target: original.work, routeSegment: 'original',
    disclosure: 'public', actingSubject: owner.actingSubject,
  });
  const collection = `https://rezics.com/id/${randomUUID()}`;
  const curated = await closureCommand<{ structure: string; revision: string }>(owner, 'POST', '/v1/collections', {
    collection, name: 'Independent originals', disclosure: 'public', actingSubject: owner.actingSubject,
  }, 201);
  await closureCommand(owner, 'POST', `/v1/collections/${short(collection)}/changes`, {
    expectedHead: curated.revision, actingSubject: owner.actingSubject, operations: [{ op: 'insert',
      parent: curated.structure, position: 'last', role: 'member', target: original.work,
      selection: { mode: 'follow-context' } }],
  });
  mount = await closureCommand<{ revision: string }>(owner, 'POST', `${root}/mounts`, {
    expectedHead: mount.revision, target: collection, routeSegment: 'picks', disclosure: 'public',
    actingSubject: owner.actingSubject,
  });
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const document = fromPlainText('Independent original Zone home survives Realm closure', 'blocks');
  const saved = await closureCommand<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    owner, 'POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: homeDocument,
      variantId, expectedHead: null, document, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: 'ltr', actingSubject: owner.actingSubject }, 201);
  const current = await closureCommand<{ revision: string }>(owner, 'GET', `${root}/configuration${query(owner)}`);
  const receipt = await closureCommand<{ revision: string }>(owner, 'POST', `${root}/site-publications`, {
    routesRevision: mount.revision, navigationRevision: mount.revision, expectedHead: current.revision,
    actingSubject: owner.actingSubject, pages: [{ page: homeDocument, variantId, revisionId: saved.revisionId,
      byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch }],
  }, 201);
  revision = receipt.revision;
  const baseline = await closureCommand<Route>(sessions.visitor, 'GET', `${root}/routes?path=%2F`);
  home = baseline.page!;
  expect(home).toMatchObject({ document, reference: { resourceId: homeDocument, revisionId: saved.revisionId,
    byteDigest: saved.byteDigest, provenance: { rightsBasis: 'original-contribution', author: owner.actingSubject } } });
  exact = await closureCommand(sessions.visitor, 'GET', `/v1/content-revisions/${saved.revisionId}`);
  credits = await closureCommand(sessions.visitor, 'GET', `/v1/works/${short(original.work)}/agent-credits`);
  expect(credits).toMatchObject({ items: expect.arrayContaining([
    expect.objectContaining({ agent: owner.actingSubject, role: 'author' }),
  ]) });
  for (const name of personaNames) {
    const person = sessions[name];
    const live = await closureCommand<Route>(person, 'GET', `${root}/routes${query(person, { path: '/' })}`);
    expect(live).toMatchObject({ realm: sessions.realm, revision, page: home });
    const presentation = await closureCommand<Presentation>(person, 'GET', `${root}/presentation${query(person)}`);
    expect(presentation.realm).toBe(sessions.realm);
    expect(presentation.moduleData.flatMap(module => module.sources.map(item => item.state)))
      .toEqual(ZONE_PUBLIC_READ_SOURCES.map(() => 'public-read'));
    const adopted = await closureCommand<Route>(person, 'GET', `${root}/routes${query(person, { path: `/w/${short(original.work)}` })}`);
    expect(adopted).toMatchObject({ realm: sessions.realm, resource: { id: original.work } });
    const index = await closureCommand<Route>(person, 'GET', `${root}/routes${query(person, { path: '/picks' })}`);
    expect(index).toMatchObject({ realm: sessions.realm, items: [{ id: original.work, inZone: true }], nextCursor: null });
  }
  timings.push({ phase: 'publication-and-live-controls', elapsedMs: performance.now() - started });
  await effectClosure(sessions, rule);
  completed = true;
  timings.push({ phase: 'completed-closure', elapsedMs: performance.now() - started });
}, 180_000);

afterAll(async () => {
  try {
    const packet = { run: Bun.env.REZICS_QA_RUN_ID, source, sourceAfter: sourceIdentity(process.cwd()),
      completed, timings, elapsedMs: performance.now() - started, requests };
    mkdirSync('.temp/goal', { recursive: true });
    writeFileSync(`.temp/goal/zone-route-closure-${Bun.env.REZICS_QA_RUN_ID ?? 'local'}.json`, JSON.stringify(packet, null, 2));
    console.log('Zone route closure proof', JSON.stringify(packet));
  } finally { await sessions?.close(); }
});

for (const name of personaNames) test(`${name}: closed Realm identity and modules vanish while independent publication and credit survive`, async () => {
  expect(completed, 'Public closure must have a confirmed completed receipt').toBe(true);
  const person = sessions[name];
  const route = await closureCommand<Route>(person, 'GET', `${root}/routes${query(person, { path: '/' })}`);
  expect(route).toMatchObject({ realm: null, revision, page: home });
  const mounted = await closureCommand<Route>(person, 'GET', `${root}/routes${query(person, { path: '/original' })}`);
  expect(mounted).toMatchObject({ realm: null, revision, resource: { id: original.work } });
  const index = await closureCommand<Route>(person, 'GET', `${root}/routes${query(person, { path: '/picks' })}`);
  expect(index).toMatchObject({ realm: null, revision, items: [{ id: original.work, inZone: true }], nextCursor: null });
  for (const tab of ['', '/discussion']) {
    const detail = await closureCommand<Route>(person, 'GET',
      `${root}/routes${query(person, { path: `/picks/${short(original.work)}${tab}` })}`);
    expect(detail).toMatchObject({ realm: null, revision, resource: { id: original.work } });
  }
  const presentation = await closureCommand<Presentation>(person, 'GET', `${root}/presentation${query(person)}`);
  expect(presentation).toMatchObject({ realm: null, revision, home });
  expect(presentation.navigation).toContainEqual(expect.objectContaining({ target: original.work }));
  expect(presentation.moduleData.flatMap(module => module.sources.map(item => item.state)))
    .toEqual(ZONE_PUBLIC_READ_SOURCES.map(() => 'unavailable'));
  expect(presentation.moduleData.flatMap(module => module.sources.flatMap(item => item.members))).toEqual([]);
  expect(await closureCommand(person, 'GET', `/v1/content-revisions/${home.reference.revisionId}${query(person)}`)).toEqual(exact);
  await closureCommand(person, 'GET', `/v1/works/${short(original.work)}${query(person)}`);
  expect(await closureCommand(person, 'GET', `/v1/works/${short(original.work)}/agent-credits${query(person)}`)).toEqual(credits);
  const missing = await person.main('GET', `${root}/routes${query(person, { path: `/w/${randomUUID()}` })}`);
  const dependent = await person.main('GET', `${root}/routes${query(person, { path: `/w/${short(original.work)}` })}`);
  expect(missing.status).toBe(404);
  expect(dependent.status).toBe(missing.status);
  expect(await dependent.json()).toEqual(await missing.json());
  const closed = `/v1/realms/${short(sessions.realm)}`, absent = `/v1/realms/${randomUUID()}`;
  for (const suffix of ['', '/zone', `/about-thread${query(person, { about: original.work })}`,
    ...ZONE_PUBLIC_READ_SOURCES.map(block => `/modules/${block}`)]) {
    const path = suffix.includes('?') ? suffix : `${suffix}${query(person)}`;
    const reference = await person.main('GET', `${absent}${path}`);
    const response = await person.main('GET', `${closed}${path}`);
    expect(reference.status).toBe(404);
    expect(response.status).toBe(reference.status);
    expect(await response.json()).toEqual(await reference.json());
  }
}, 60_000);
