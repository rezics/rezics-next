import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import hub from '../../../../../scripts/qa/cases/outcomes/visual-novels/work-hub-and-edition-choice.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
const short = (id: string) => id.slice(-36);
const native = () => `https://rezics.com/id/${randomUUID()}`;
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(hub);
let work: { work: string; mainVersion: string };
let realization: { resource: string; revision: string };
const releases: Array<{ resource: string; revision: string; title: string }> = [];
const query = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

beforeAll(async () => {
  sessions = await personaSessions('public');
  await recording.prepare();
  const owner = sessions.owner;
  const actingSubject = owner.actingSubject;
  work = await answer(owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Lantern Orchard', language: 'en',
    semanticTypes: ['https://schema.org/VideoGame'], authoring: 'own-work', actingSubject,
  }), 201);
  const draft = await answer<{ contribution: string; draftRevision: string }>(owner.main('POST', '/v1/contributions', {
    profile: 'text-contribution-v1', work: work.work, language: 'en',
    body: 'An original visual novel: Mira lights the orchard lanterns and chooses which path leads home.', actingSubject,
  }), 201);
  const publication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
  }), 201);
  await answer(owner.main('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
    work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject,
  }), 201);
  const resource = native();
  const text = await answer<{ revision: string }>(owner.main('PUT', `/v1/works/${short(work.work)}/realizations/${short(resource)}`, {
    profile: 'realization-v1', id: resource, expectedHead: null, actingSubject,
    language: 'en', kind: 'original', translators: [], publishers: [],
    source: { kind: 'unresolved', work: work.work }, status: 'official', verification: 'verified', evidence: native(),
  }));
  realization = { resource, revision: text.revision };
  for (const platform of ['Windows', 'Linux']) {
    const id = native();
    const title = `Lantern Orchard ${platform}`;
    const saved = await answer<{ revision: string }>(owner.main('PUT', `/v1/works/${short(work.work)}/releases/${short(id)}`, {
      profile: 'release-v2', id, expectedHead: null, actingSubject, kind: 'formal', status: 'official',
      titleLanguage: 'en', tracklistLanguage: null, title: { value: title, language: 'en' },
      editionStatement: null, publisher: 'Original fixture author', publicationYear: 2026, isbn13: null,
      originalUrl: null, fixedRelease: null, identifiers: [], platform, territory: null,
      coverage: [{ realization: resource, revision: text.revision, completeness: 'complete' }], evidence: null,
    }));
    releases.push({ resource: id, revision: saved.revision, title });
  }
}, 180_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});

type Preference = { work: string; language: string; edition: { kind: string; resource: string; revision: string }; version: number; changedAt: string; replayed?: boolean };

// Stable route labels keep repeated reads and saves distinct without recording fixture setup.
const sampleCounts = new Map<string, number>();
function proofSession(name: PersonaName, session = sessions[name], device = 'primary'): PersonaSession {
  const sample = recording.session(name, session);
  return { ...session, main: (method, path, ...args) => {
    const route = path.split('?')[0]!.split('/').slice(2)
      .filter(part => !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(part)).join('-');
    const label = `${device}-${method.toLowerCase()}-${route}`;
    const key = `${name}:${label}`;
    const index = sampleCounts.get(key) ?? 0;
    sampleCounts.set(key, index + 1);
    return sample(`${label}-${index}`, method, path, ...args);
  } };
}

// Work overview, frame and availability reads from work-page and work-levels.
async function pageReads(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  const id = short(work.work);
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${query(person)}`;
  const read = <T>(label: string, path: string) => answer<T>(sample(label, 'GET', viewer(path)));
  const projection = await read<{ sections: Array<{ id: string; href: string }> }>('hub-projection', `/v1/resources/${id}/page`);
  for (const section of projection.sections.filter(section => ['statements', 'relations', 'discussion', 'lists'].includes(section.id))) {
    await read(`hub-${section.id}`, section.href);
  }
  for (const template of ['work-credits', 'work-adoptions', 'work-versions']) {
    await answer(sample(`hub-${template}`, 'POST', '/v1/query', {
      profile: 'template-query-v1', query: `https://rezics.com/query/${template}`, revision: 1,
      parameters: { roots: [work.work], ...(template === 'work-versions' ? { kind: 'text-variant' } : {}) },
      presentation: { actingSubject: person.actingSubject },
    }));
  }
  await read('hub-agent-credits', `/v1/works/${id}/agent-credits`);
  await read('hub-author-profile', `/v1/agents/${short(sessions.owner.actingSubject!)}`);
  await read('hub-author-works', `/v1/agents/${short(sessions.owner.actingSubject!)}/works?limit=12`);
  await read('hub-classifications', `/v1/works/${id}/classifications?scope=global`);
  await answer(sample('hub-facet-labels', 'GET', '/v1/facets'));
  await answer(sample('hub-platform-access', 'GET', '/v1/me/platform-access'));
  const contexts = await read<{ items: Array<{ context: string }> }>('hub-rating-contexts', `/v1/resources/${id}/rating-contexts?scope=global`);
  const context = contexts.items[0]?.context;
  const contextQuery = context ? `&context=${encodeURIComponent(context)}` : '';
  await read('hub-ratings', `/v1/resources/${id}/ratings?scope=global${contextQuery}`);
  await read('hub-reader-stats', `/v1/works/${id}/reader-stats?${contextQuery.slice(1)}`);
  await read('hub-rating-populations', `/v1/rating-populations?target=${encodeURIComponent(work.work)}&limit=20`);
  if (context) await read('hub-reviews-empty', `/v1/resources/${id}/reviews?context=${encodeURIComponent(context)}&sort=helpful&limit=10`);
  await read('hub-also-enjoyed', `/v1/works/${id}/also-enjoyed?limit=12`);
  await read('hub-realizations', `/v1/works/${id}/realizations?limit=20`);
  await read('hub-releases', `/v1/works/${id}/releases?limit=20`);
  await answer(sample('hub-parts-unavailable', 'GET', viewer(`/v1/resources/${id}/parts?limit=1`)), 404);
  await answer(sample('hub-parts-preview-unavailable', 'GET', viewer(`/v1/resources/${id}/parts?limit=7`)), 404);
  const wholes = await sample('hub-wholes-empty', 'GET', viewer(`/v1/resources/${id}/wholes?limit=3`));
  expect([200, 404]).toContain(wholes.status);
  await wholes.body?.cancel();
  await read('hub-relations-empty', `/v1/resources/${id}/relations?limit=20`);
  const contents = await sample('hub-contents', 'GET', viewer(`/v1/works/${id}/contents`));
  expect([200, 404]).toContain(contents.status);
  await contents.body?.cancel();
  await read('hub-reader-state-empty', `/v1/works/${id}/reader-state`);
  await read('hub-progress-empty', `/v1/me/progress-summaries/${id}?language=en`);
  await read('hub-continue-empty', '/v1/me/continue?limit=6');
  await answer(sample('hub-selected-text', 'GET', `/v1/main-versions/${short(work.mainVersion)}/selection?language=en`));
  await answer(sample('hub-showcase-empty', 'POST', '/v1/resources/showcase', { profile: 'work-showcase-batch-v1', targets: [work.work] }));
}

async function choice(name: PersonaName) {
  if (name === 'member') await pageReads(name);
  const person = proofSession(name);
  const root = `/v1/works/${short(work.work)}`;
  const publicQuery = person.actingSubject ? query(person) : '';
  expect(await answer(person.main('GET', `${root}?${publicQuery}`))).toMatchObject({ id: work.work, title: { value: 'Lantern Orchard' } });
  const credits = await answer<{ items: Array<{ role: string; agent: string }> }>(person.main('GET', `${root}/credits?${publicQuery}`));
  expect(credits.items).toContainEqual(expect.objectContaining({ role: 'author', agent: sessions.owner.actingSubject }));
  expect(await answer(person.main('GET', `${root}/editions?${publicQuery}`))).toMatchObject({ items: [], nextCursor: null });
  const seen: Array<{ id: string; revision: string; title: { value: string } }> = [];
  let after: string | null = null;
  do {
    const page: { items: typeof seen; nextCursor: string | null } = await answer(person.main('GET', `${root}/releases?limit=1&${publicQuery}${after ? `&cursor=${encodeURIComponent(after)}` : ''}`));
    seen.push(...page.items);
    after = page.nextCursor;
  } while (after);
  expect(seen.map(item => item.id).sort()).toEqual(releases.map(item => item.resource).sort());
  for (const release of releases) expect(seen).toContainEqual(expect.objectContaining({ id: release.resource, revision: release.revision, title: expect.objectContaining({ value: release.title }) }));
  const path = `/v1/me/edition-preferences/${short(work.work)}`;
  const victim = name === 'owner' ? sessions.member : sessions.owner;
  const pin = { kind: 'release', resource: releases[0]!.resource, revision: releases[0]!.revision };
  if (name === 'visitor') {
    await answer(person.main('GET', `${path}?${query(victim)}`), 401);
    await answer(person.main('PUT', path, { actingSubject: victim.actingSubject, expectedVersion: 0, language: 'en', edition: pin }), 401);
    expect(await answer(victim.main('GET', `${path}?${query(victim)}`))).toBeNull();
    return;
  }
  const before = await answer(victim.main('GET', `${path}?${query(victim)}`));
  expect(await answer<{ code: string }>(person.main('GET', `${path}?${query(victim)}`), 403)).toMatchObject({ code: 'progress_denied' });
  await answer(person.main('PUT', path, { actingSubject: victim.actingSubject, expectedVersion: 0, language: 'en', edition: pin }), 403);
  expect(await answer(victim.main('GET', `${path}?${query(victim)}`))).toEqual(before);
  if (name === 'stranger') return;
  expect(await answer(person.main('GET', `${path}?${query(person)}`))).toBeNull();
  const body = { actingSubject: person.actingSubject, expectedVersion: 0, language: 'en', edition: pin };
  const key = randomUUID();
  const saved = await answer<Preference>(person.main('PUT', path, body, key));
  expect(saved).toMatchObject({ work: work.work, edition: pin, language: 'en', version: 1, replayed: false });
  const { replayed: _replayed, ...persisted } = saved;
  expect(await answer(person.main('GET', `${path}?${query(person)}`))).toEqual(persisted);
  expect(await answer(person.main('PUT', path, body, key))).toEqual({ ...saved, replayed: true });
  expect(await answer(person.main('PUT', path, { ...body, edition: { kind: 'realization', ...realization } }), 409)).toMatchObject({ code: 'stale_edition_preference', current: persisted });
  const recovered = await answer<Preference>(person.main('PUT', path, { ...body, expectedVersion: 1, edition: { kind: 'realization', ...realization } }));
  expect(recovered).toMatchObject({ edition: { kind: 'realization', ...realization }, version: 2 });
  expect(await answer(person.main('GET', `${path}?${query(person)}`))).toMatchObject({ edition: recovered.edition, version: 2 });
  expect(await answer(person.main('GET', `/v1/me/progress-summaries/${short(work.work)}?language=en&${query(person)}`))).toMatchObject({ preference: { edition: recovered.edition, version: 2 } });
  expect(await answer(victim.main('GET', `${path}?${query(victim)}`))).toEqual(before);
}

outcomeTest(hub, 'visitor', () => choice('visitor'), recording);
outcomeTest(hub, 'stranger', () => choice('stranger'), recording);
outcomeTest(hub, 'member', () => choice('member'), recording);
outcomeTest(hub, 'owner', () => choice('owner'), recording);
outcomeTest(hub, 'moderator', () => choice('moderator'), recording);
outcomeTest(hub, 'operator', () => choice('operator'), recording);
