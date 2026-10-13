import { outcomeTest } from '../../../support/outcome-test.ts';
import { closureSetup, closureCell, effectClosure, publishClosureRule } from './closure-fixture.ts';
import closure from '../../../../../scripts/qa/cases/outcomes/realm/closure-feed.ts';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
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
const publications: Publication[] = [];
let closureUnavailable: string | null = null;
let journeyStarted = 0;
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

export async function publishFeedOriginals(sessions: PersonaSessions, publications: Publication[]) {
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
  for (let index = 0; index < 3; index++) {
    const work = await answer<Work>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: `${phrase} ${index}`, language: 'en',
      semanticTypes: ['https://schema.org/Book'], authoring: 'own-work',
      actingSubject: owner.actingSubject,
    }), 201);
    // Own-work creation supplies the native author credit; consume its public inventory.
    const credits = await answer<{ items: { id: string; agent: string; role: string }[]; nextCursor: string | null }>(
      owner.main('GET', `/v1/works/${short(work.work)}/agent-credits?${acting(owner)}`),
    );
    expect(credits.nextCursor).toBeNull();
    expect(credits.items).toHaveLength(1);
    expect(credits.items[0]).toMatchObject({ agent: owner.actingSubject, role: 'author' });
    expect(credits.items[0]!.id).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
    console.log('Local original credit', JSON.stringify({ row: closure.rowId, work: work.work, inventory: credits }));
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

type FeedPage = {
  items: { id: string; realm: { id: string } | null; target: { work: string | null }; actor: { id: string } }[];
  nextCursor: string | null;
};
async function feed(person: PersonaSession, scope: 'all' | 'following', realm?: string) {
  const params = new URLSearchParams({ scope, sort: 'new', limit: '20' });
  if (person.actingSubject) params.set('actingSubject', person.actingSubject);
  if (realm) params.set('realms', realm);
  const items: FeedPage['items'] = [];
  let page: FeedPage;
  do {
    page = await answer<FeedPage>(person.main('GET', `/v1/feed?${params}`));
    items.push(...page.items);
    if (page.nextCursor) params.set('cursor', page.nextCursor);
  } while (page.nextCursor);
  return items;
}
async function prepareSurface() {
  for (const name of ['stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    const person = sessions[name];
    await answer(person.main('POST', '/v1/follows', {
      profile: 'follow-command-v1', target: sessions.realm,
      actingSubject: person.actingSubject, following: true, level: 'all', expectedRevision: null,
    }));
  }
  const baseline = await feed(sessions.visitor, 'all', sessions.realm);
  expect(baseline.some(item => item.realm?.id === sessions.realm)).toBe(true);
  await independent(sessions.visitor);
}
async function delivered(name: PersonaName) {
  const person = sessions[name];
  await requireClosure(person);
  const all = await feed(person, 'all');
  for (const items of [all, await feed(person, 'all', sessions.realm),
    ...(person.actingSubject ? [await feed(person, 'following')] : [])]) {
    const bytes = JSON.stringify(items);
    expect(bytes).not.toContain(sessions.realm);
    for (const publication of publications) expect(bytes).not.toContain(publication.selection);
  }
  // The shared Work identity remains eligible on its independent main publication.
  for (const publication of publications) {
    expect(all.some(item => item.target.work === publication.work && item.realm === null)).toBe(true);
  }
  const scopes = ['all', ...(person.actingSubject ? ['following', `realm:${sessions.realm}`] : [])];
  for (const scope of scopes) {
    const params = new URLSearchParams({ after: '0', scope });
    if (person.actingSubject) params.set('actingSubject', person.actingSubject);
    const head = await answer<{ newPosts: { value: number; kind: string } }>(
      person.main('GET', `/v1/feed/head?${params}`),
    );
    if (scope.startsWith('realm:')) expect(head.newPosts).toEqual({ value: 0, kind: 'exact' });
  }
  await independent(person);
}

describe('feed closure journey', () => {
  beforeAll(async () => {
    const started = performance.now();
    sessions = await personaSessions('public');
    for (const persona of personaNames) {
      const person = sessions[persona];
      const call = person.main;
      person.main = async (method, path, body, key, options) => {
        const idempotencyKey = key ?? (method === 'POST' ? randomUUID() : undefined);
        const at = performance.now();
        const response = await call(method, path, body, idempotencyKey, options);
        console.log('Local closure request', JSON.stringify({ row: closure.rowId, persona,
          caller: person.accountId, actingSubject: person.actingSubject, method, path, body, idempotencyKey,
          phase: journeyStarted ? 'journey' : 'preparation', source: import.meta.path,
          elapsedMs: performance.now() - at, sinceStartMs: performance.now() - started,
          answer: { status: response.status, body: await response.clone().text() } }));
        return response;
      };
    }
    closureUnavailable = await closureSetup(sessions, async () => {
      const rule = await publishClosureRule(sessions);
      await publishFeedOriginals(sessions, publications);
      await prepareSurface();
      await effectClosure(sessions, rule);
    });
    console.log('Local closure preparation', JSON.stringify({ row: closure.rowId,
      personaSeconds: sessions.elapsedSeconds, preparationSeconds: (performance.now() - started) / 1000,
      source: import.meta.path, failure: closureUnavailable }));
    journeyStarted = performance.now();
  }, 180_000);

  afterAll(async () => {
    console.log('Local closure journey timing', JSON.stringify({ row: closure.rowId,
      journeySeconds: (performance.now() - journeyStarted) / 1000 }));
    await sessions?.close();
  });

  outcomeTest(closure, 'visitor', () => closureCell(closure, 'visitor', () => sessions, () => delivered('visitor')));
  outcomeTest(closure, 'stranger', () => closureCell(closure, 'stranger', () => sessions, () => delivered('stranger')));
  outcomeTest(closure, 'member', () => closureCell(closure, 'member', () => sessions, () => delivered('member')));
  outcomeTest(closure, 'owner', () => closureCell(closure, 'owner', () => sessions, () => delivered('owner')));
  outcomeTest(closure, 'moderator', () => closureCell(closure, 'moderator', () => sessions, () => delivered('moderator')));
  outcomeTest(closure, 'operator', () => closureCell(closure, 'operator', () => sessions, () => delivered('operator')));

});
