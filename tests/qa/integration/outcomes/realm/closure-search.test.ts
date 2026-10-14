import { closureSetup, closureCell, closureHydrationFence, effectClosure, publishClosureRule } from './closure-fixture.ts';
import closure from '../../../../../scripts/qa/cases/outcomes/realm/closure-search.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { missingRealmSearchStates, realmSearchFixture, type RealmSearchState }
  from '../../../../../apps/web/features/discover/realm-search-fixtures.ts';
import {
  personaSessions,
  personaNames,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(60_000);
type Work = { work: string; mainVersion: string; workRevision: string };
type Publication = Work & { contribution: string; publicationDecision: string; selection: string };
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(closure);
const queryContinuations = new Map<PersonaName, string>();
const publications: Publication[] = [];
let closureUnavailable: string | null = null;
let hydration: ReturnType<typeof closureHydrationFence>;
const raced = new Map<PersonaName, { path: string; status: number; body: string }>();
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
  expect(unavailable.status, path).toBeLessThan(500);
  const body = await unavailable.json() as { code?: string };
  if (unavailable.status === 409 && body.code === 'read_basis_changed') {
    const restarted = new URL(path, 'http://main.local');
    expect(restarted.searchParams.has('cursor'), path).toBe(true);
    expect(JSON.stringify(body), path).not.toContain(sessions.realm);
    restarted.searchParams.delete('cursor');
    await missing(person, restarted.pathname + restarted.search, absent);
    return;
  }
  const ordinary = await person.main('GET', absent);
  expect(ordinary.status, absent).toBe(404);
  expect(unavailable.status, path).toBe(ordinary.status);
  expect(body, path).toEqual(await ordinary.json());
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
  const owner = sessions.owner;
  const root = `/v1/realms/${short(sessions.realm)}`;
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Original catalogue editors', permissions: ['publication.adopt'] },
    {
      kind: 'assignment', roleId, member: owner.actingSubject, assigned: true,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
  ]) {
    const roles = await answer<{ generation: string }>(owner.main('GET', `${root}/roles?${acting(owner)}`));
    const command = {
      actingSubject: owner.actingSubject, expectedGeneration: roles.generation,
      reason: 'Adopt original fixture publications while preserving their authors', change,
    };
    const preview = await answer<{ digest: string }>(owner.main('POST', `${root}/role-impact`, command));
    await answer(owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }), 201);
  }
  // The production query asks for twenty cards; twenty-one public originals
  // provide a real continuation before the Realm closes.
  for (let index = 0; index < 21; index++) {
    const work = await answer<Work>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: `${phrase} ${index} ${realmSearchFixture('global').query.q}`, language: 'en',
      semanticTypes: ['https://schema.org/Book'], authoring: 'own-work',
      actingSubject: owner.actingSubject,
    }), 201);
    const credits = await answer<{ items: { agent: string; role: string }[] }>(
      owner.main('GET', `/v1/works/${short(work.work)}/agent-credits?${acting(owner)}`),
    );
    expect(credits.items).toContainEqual(
      expect.objectContaining({ agent: owner.actingSubject, role: 'author' }),
    );
    const draft = await answer<{ contribution: string; draftRevision: string }>(
      owner.main('POST', '/v1/contributions', {
        profile: 'text-contribution-v1', work: work.work, language: 'en',
        body: `Original ${phrase} story ${index}: a gardener plants a seed.`,
        actingSubject: owner.actingSubject,
      }), 201,
    );
    const published = await answer<{ publicationDecision: string }>(
      owner.main('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1', contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
        rightsBasis: 'original-contribution', disclosure: 'public',
        actingSubject: owner.actingSubject,
      }), 201,
    );
    const selected = {
      work: work.work, contribution: draft.contribution,
      publicationDecision: published.publicationDecision, expectedSelectionHead: null,
      actingSubject: owner.actingSubject,
    };
    await answer(owner.main('POST', '/v1/publication-selections', {
      ...selected, profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion }, selectionBasis: 'main-maintainer',
    }), 201);
    const adoption = await answer<{ selection: string }>(
      owner.main('POST', '/v1/publication-selections', {
        ...selected, profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: sessions.realm }, mainVersion: work.mainVersion,
        selectionBasis: 'realm-manager-review',
      }), 201,
    );
    publications.push({ ...work, ...draft, ...published, selection: adoption.selection });
  }
}

beforeAll(async () => {
  hydration = closureHydrationFence();
  sessions = await personaSessions('public', { graphEndpoint: hydration.url });
  await recording.prepare();
  closureUnavailable = await closureSetup(sessions, async () => {
    const rule = await publishClosureRule(sessions);
    await publishOriginals();
    await prepareSurface();
    for (const name of personaNames) {
      const page = await answer<{ result: { nextCursor: string | null } }>(
        sessions[name].main('POST', '/v1/query', storyQuery('closed')));
      expect(page.result.nextCursor, `${name}: pre-closure query continuation`).not.toBeNull();
      queryContinuations.set(name, page.result.nextCursor!);
    }
    hydration.arm(publications.map(publication => publication.work), personaNames.length);
    const params = new URLSearchParams({ q: phrase, realm: sessions.realm, limit: '1' });
    const path = `/v1/search/catalogue?${params}`;
    const pending = personaNames.map(async name => {
      const response = await sessions[name].main('GET', path);
      raced.set(name, { path, status: response.status, body: await response.text() });
    });
    const finished = Promise.allSettled(pending);
    try {
      await hydration.blocked();
      await effectClosure(sessions, rule);
    } finally {
      hydration.resume();
      const results = await finished;
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    }
  });
}, 180_000);

afterAll(async () => {
  try { await recording.publish(); }
  finally { try { await sessions?.close(); } finally { await hydration?.close(); } }
});

function storyQuery(kind: RealmSearchState, cursor?: string) {
  const fixture = realmSearchFixture(kind);
  return { ...fixture.query,
    ...(fixture.state.scope.kind === 'realm'
      ? { context: { realm: sessions.realm }, scope: { kind: 'realm' as const, realm: sessions.realm } } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

async function storySearches(name: PersonaName) {
  const sample = recording.session(name, sessions[name]);
  for (const fixture of missingRealmSearchStates) {
    // Public commands can close a Realm, but cannot make Discovery unavailable.
    if (fixture.kind === 'error') continue;
    const query = storyQuery(fixture.kind,
      fixture.kind === 'closed-continuation' ? queryContinuations.get(name) : undefined);
    await answer(sample(fixture.kind, fixture.method, fixture.path, query), fixture.status);
  }
}

type CataloguePage = { results: { work: string }[]; next: string | null; count: { value: number; precision: string } };
let continuation: string;
async function prepareSurface() {
  const params = new URLSearchParams({ q: phrase, realm: sessions.realm, limit: '1' });
  const page = await answer<CataloguePage>(sessions.visitor.main('GET', `/v1/search/catalogue?${params}`));
  expect(page.results).toHaveLength(1);
  expect(page.count).toEqual({ value: 1, precision: 'lower-bound' });
  expect(page.next).not.toBeNull();
  continuation = page.next!;
  await independent(sessions.visitor);
}
async function delivered(name: PersonaName) {
  const person = sessions[name];
  await requireClosure(person);
  await storySearches(name);
  const during = raced.get(name)!;
  expect(during.status, during.path).toBeLessThan(500);
  const body = JSON.parse(during.body) as { results?: unknown[]; count?: { value: number }; code?: string };
  console.log('Realm search during hydration', JSON.stringify({ persona: name, ...during }));
  expect(JSON.stringify(body), during.path).not.toContain(sessions.realm);
  for (const publication of publications) {
    expect(JSON.stringify(body), during.path).not.toContain(publication.selection);
    expect(JSON.stringify(body), during.path).not.toContain(publication.work);
  }
  if (during.status === 200) {
    expect(body.results, during.path).toEqual([]);
    expect(body.count?.value, during.path).toBe(0);
  } else if (during.status === 409) expect(body.code, during.path).toBe('read_basis_changed');
  else {
    const ordinary = await person.main('GET', `/v1/search/catalogue?q=${phrase}&realm=${encodeURIComponent(`https://rezics.com/id/${randomUUID()}`)}`);
    expect(ordinary.status, during.path).toBe(404);
    expect(during.status, during.path).toBe(ordinary.status);
    expect(body, during.path).toEqual(await ordinary.json());
  }
  const params = new URLSearchParams({ q: phrase, realm: sessions.realm, limit: '1' });
  const absent = new URLSearchParams({ q: phrase, realm: `https://rezics.com/id/${randomUUID()}`, limit: '1' });
  await missing(person, `/v1/search/catalogue?${params}`, `/v1/search/catalogue?${absent}`);
  params.set('cursor', continuation);
  await missing(person, `/v1/search/catalogue?${params}`, `/v1/search/catalogue?${absent}`);
  const query = {
    profile: 'public-realm-phrase-v1', context: { kind: 'realm-local', id: sessions.realm },
    phrase, language: 'en',
  };
  const unavailable = await person.main('POST', '/v1/queries', query);
  const ordinary = await person.main('POST', '/v1/queries', {
    ...query, context: { kind: 'realm-local', id: `https://rezics.com/id/${randomUUID()}` },
  });
  expect(ordinary.status).toBe(404);
  expect(unavailable.status).toBe(404);
  expect(await unavailable.json()).toEqual(await ordinary.json());
  const global = new URLSearchParams({ q: phrase, limit: '1' });
  const seen: string[] = [];
  let page: CataloguePage;
  do {
    page = await answer<CataloguePage>(person.main('GET', `/v1/search/catalogue?${global}`));
    seen.push(...page.results.map(result => result.work));
    expect(page.count).toEqual({ value: seen.length, precision: page.next ? 'lower-bound' : 'exact' });
    if (page.next) global.set('cursor', page.next);
  } while (page.next);
  expect(page.count).toEqual({ value: publications.length, precision: 'exact' });
  expect(page.next).toBeNull();
  expect(seen.sort()).toEqual(publications.map(publication => publication.work).sort());
  const typeahead = await answer<unknown>(
    person.main('GET', `/v1/search/typeahead?prefix=${encodeURIComponent(phrase)}`),
  );
  for (const publication of publications) expect(JSON.stringify(typeahead)).toContain(publication.work);
  await independent(person);
}

outcomeTest(closure, 'visitor', () => closureCell(closure, 'visitor', () => sessions, () => delivered('visitor')), recording);
outcomeTest(closure, 'stranger', () => closureCell(closure, 'stranger', () => sessions, () => delivered('stranger')), recording);
outcomeTest(closure, 'member', () => closureCell(closure, 'member', () => sessions, () => delivered('member')), recording);
outcomeTest(closure, 'owner', () => closureCell(closure, 'owner', () => sessions, () => delivered('owner')), recording);
outcomeTest(closure, 'moderator', () => closureCell(closure, 'moderator', () => sessions, () => delivered('moderator')), recording);
outcomeTest(closure, 'operator', () => closureCell(closure, 'operator', () => sessions, () => delivered('operator')), recording);

