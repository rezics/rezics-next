import { outcomeTest } from '../../../support/outcome-test.ts';
import { closureSetup, closureCell, effectClosure, publishClosureRule } from './closure-fixture.ts';
import { fromPlainText } from '@rezics/document';
import closure from '../../../../../scripts/qa/cases/outcomes/realm/closure-zone-discussion-entry-and-modules.ts';
import { publishClosureOriginals } from './closure-original-credit-setup.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(60_000);
type Work = { work: string; mainVersion: string; workRevision: string };
type Publication = Work & { contribution: string; publicationDecision: string; selection: string };
let sessions: PersonaSessions;
const publications: Publication[] = [];
let closureUnavailable: string | null = null;
const phrase = `Closuregarden${randomUUID().replaceAll('-', '')}`;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `HTTP ${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

async function missing(person: PersonaSession, path: string, absent: string) {
  const unavailable = await person.main('GET', path);
  const ordinary = await person.main('GET', absent);
  expect(ordinary.status, absent).toBe(404);
  expect(unavailable.status, path).toBe(ordinary.status);
  expect(await unavailable.json(), path).toEqual(await ordinary.json());
}

async function requireClosure(person: PersonaSession) {
  // A refused prerequisite is not an observed delivery defect. Each person
  // confirms the still-open public Realm through their own HTTP session.
  if (closureUnavailable) {
    await answer(person.main('GET', `/v1/realms/${short(sessions.realm)}?${acting(person)}`));
    throw new Error(closureUnavailable);
  }
}

async function independent(person: PersonaSession) {
  for (const publication of publications) {
    await answer(person.main('GET', `/v1/works/${short(publication.work)}`));
    const credits = await answer<{ items: { agent: string; role: string }[] }>(
      person.main('GET', `/v1/works/${short(publication.work)}/agent-credits`),
    );
    expect(credits.items).toContainEqual(
      expect.objectContaining({ agent: sessions.owner.actingSubject, role: 'author' }),
    );
  }
}

async function publishOriginals() {
  await publishClosureOriginals(sessions, publications, phrase);
}

beforeAll(async () => {
  sessions = await personaSessions('public');
  closureUnavailable = await closureSetup(sessions, async () => {
    const rule = await publishClosureRule(sessions);
    await publishOriginals();
    await prepareSurface();
    await effectClosure(sessions, rule);
  });
}, 180_000);

afterAll(async () => { await sessions?.close(); });

let homeRevision: string;
async function prepareSurface() {
  const owner = sessions.owner;
  const root = `/v1/zones/${short(sessions.zone)}`;
  const config = await answer<{ revision: string }>(owner.main('GET', `${root}/configuration?${acting(owner)}`));
  await answer(owner.main('PUT', `${root}/configuration`, {
    actingSubject: owner.actingSubject, expectedHead: config.revision, defaultRealm: sessions.realm,
    presentation: {
      profile: 'zone-presentation-v2', preset: 'clean',
      tokens: {
        colorScheme: 'system', accent: '#2563eb', density: 'comfortable',
        cardRadius: 'md', headingFontScale: 'md', surfaceTint: 'none',
        fontPairing: 'sans', pageSurface: 'flat', coverStyle: 'portrait', titleEffect: 'plain',
      },
      navigation: [], slides: [], modules: [{
      id: 'latest', type: 'shelf', title: 'Original Realm adoptions',
      source: { kind: 'query-block', block: 'new-adoptions' },
      }],
    },
  }));
  const navigation = await answer<{ revision: string }>(owner.main('GET', `${root}?${acting(owner)}`));
  const mount = await answer<{ revision: string }>(owner.main('POST', `${root}/mounts`, {
    expectedHead: navigation.revision, target: publications[0]!.work, routeSegment: 'original',
    disclosure: 'public', actingSubject: owner.actingSubject,
  }));
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    owner.main('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: sessions.zone, variantId, expectedHead: null,
      document: fromPlainText('Independent original Zone home document', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      actingSubject: owner.actingSubject,
    }), 201,
  );
  homeRevision = draft.revisionId;
  const current = await answer<{ revision: string }>(owner.main('GET', `${root}/configuration?${acting(owner)}`));
  // Zone site publication has no rights-basis input; this fixture authors its
  // own home document and does not infer an imported license.
  await answer(owner.main('POST', `${root}/site-publications`, {
    routesRevision: mount.revision, navigationRevision: mount.revision,
    expectedHead: current.revision, actingSubject: owner.actingSubject,
    pages: [{ page: sessions.zone, variantId, revisionId: draft.revisionId,
      byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch }],
  }), 201);
  const baseline = await answer<{ realm: string | null; moduleData: { sources: { state: string }[] }[] }>(
    sessions.visitor.main('GET', `${root}/presentation`),
  );
  expect(baseline.realm).toBe(sessions.realm);
  expect(baseline.moduleData[0]!.sources[0]!.state).toBe('public-read');
  await independent(sessions.visitor);
}

async function delivered(name: PersonaName) {
  const person = sessions[name];
  await requireClosure(person);
  const root = `/v1/realms/${short(sessions.realm)}`;
  const absent = `/v1/realms/${randomUUID()}`;
  for (const suffix of [
    '/zone', `/about-thread?about=${encodeURIComponent(publications[0]!.work)}`,
    ...['new-adoptions', 'recently-completed', 'recent-decisions', 'latest-chapters',
      'discussions', 'reader-quotes', 'editor-lists', 'browse'].map(module => `/modules/${module}`),
  ]) await missing(person, `${root}${suffix}`, `${absent}${suffix}`);
  const zone = `/v1/zones/${short(sessions.zone)}`;
  const route = await answer<{ realm: string | null; page: unknown }>(person.main('GET', `${zone}/routes?path=/`));
  expect(route.realm).toBeNull();
  expect(JSON.stringify(route.page)).toContain('Independent original Zone home document');
  const presentation = await answer<{ realm: string | null; moduleData: { id: string; sources: { state: string }[] }[] }>(
    person.main('GET', `${zone}/presentation`),
  );
  expect(presentation.realm).toBeNull();
  expect(presentation.moduleData.find(module => module.id === 'latest')!.sources[0]!.state).toBe('unavailable');
  const mounted = await answer<{ resource: { id: string } }>(person.main('GET', `${zone}/routes?path=/original`));
  expect(mounted.resource.id).toBe(publications[0]!.work);
  const home = await answer<unknown>(person.main('GET', `/v1/content-revisions/${homeRevision}`));
  expect(JSON.stringify(home)).toContain('Independent original Zone home document');
  await independent(person);
}

outcomeTest(closure, 'visitor', () => closureCell(closure, 'visitor', () => sessions, () => delivered('visitor')));
outcomeTest(closure, 'stranger', () => closureCell(closure, 'stranger', () => sessions, () => delivered('stranger')));
outcomeTest(closure, 'member', () => closureCell(closure, 'member', () => sessions, () => delivered('member')));
outcomeTest(closure, 'owner', () => closureCell(closure, 'owner', () => sessions, () => delivered('owner')));
outcomeTest(closure, 'moderator', () => closureCell(closure, 'moderator', () => sessions, () => delivered('moderator')));
outcomeTest(closure, 'operator', () => closureCell(closure, 'operator', () => sessions, () => delivered('operator')));

