import { outcomeTest } from '../../../support/outcome-test.ts';
import { closureSetup, closureCell, effectClosure, publishClosureRule } from './closure-fixture.ts';
import closure from '../../../../../scripts/qa/cases/outcomes/realm/closure-feed.ts';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createClosureCreditEvidence, publishClosureOriginals, type ClosureOriginal } from './closure-original-credit-setup.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(60_000);
type Publication = ClosureOriginal;
let sessions: PersonaSessions;
const publications: Publication[] = [];
let closureUnavailable: string | null = null;
let journeyStarted = 0;
let evidence: ReturnType<typeof createClosureCreditEvidence>;
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
    await answer(person.main('GET', `/v1/works/${short(publication.work)}?${acting(person)}`));
    const credits = await answer<{ items: { agent: string; role: string }[] }>(
      person.main('GET', `/v1/works/${short(publication.work)}/agent-credits?${acting(person)}`),
    );
    expect(credits.items).toContainEqual(
      expect.objectContaining({ agent: sessions.owner.actingSubject, role: 'author' }),
    );
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
    const current = await answer<{ revision: string | null }>(person.main('GET',
      `/v1/me/follow-state?target=${encodeURIComponent(sessions.realm)}&${acting(person)}`));
    await answer(person.main('POST', '/v1/follows', {
      profile: 'follow-command-v1', target: sessions.realm,
      actingSubject: person.actingSubject, following: true, level: 'all', expectedRevision: current.revision,
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
    evidence = createClosureCreditEvidence('realm/closure-feed', 'journey', import.meta.path);
    sessions = await evidence.phase('persona-preparation', () => personaSessions('public'));
    evidence.observe(sessions);
    closureUnavailable = await closureSetup(sessions, () => evidence.phase('preparation', async () => {
      const rule = await evidence.phase('closure-rule', () => publishClosureRule(sessions));
      await evidence.phase('original-publication', () => publishClosureOriginals(sessions, publications, phrase));
      await evidence.phase('surface-preparation', prepareSurface);
      await evidence.phase('effect-closure', () => effectClosure(sessions, rule));
    }));
    evidence.record({ kind: 'preparation-result', row: closure.rowId,
      personaSeconds: sessions.elapsedSeconds, preparationSeconds: (performance.now() - started) / 1000,
      source: import.meta.path, failure: closureUnavailable });
    journeyStarted = performance.now();
  }, 180_000);

  afterAll(async () => {
    try {
      evidence?.record({ kind: 'journey-timing', row: closure.rowId,
        journeySeconds: journeyStarted ? (performance.now() - journeyStarted) / 1000 : null });
    } finally {
      await sessions?.close();
    }
  });

  outcomeTest(closure, 'visitor', () => evidence.phase('journey-visitor', () => closureCell(closure, 'visitor', () => sessions, () => delivered('visitor'))));
  outcomeTest(closure, 'stranger', () => evidence.phase('journey-stranger', () => closureCell(closure, 'stranger', () => sessions, () => delivered('stranger'))));
  outcomeTest(closure, 'member', () => evidence.phase('journey-member', () => closureCell(closure, 'member', () => sessions, () => delivered('member'))));
  outcomeTest(closure, 'owner', () => evidence.phase('journey-owner', () => closureCell(closure, 'owner', () => sessions, () => delivered('owner'))));
  outcomeTest(closure, 'moderator', () => evidence.phase('journey-moderator', () => closureCell(closure, 'moderator', () => sessions, () => delivered('moderator'))));
  outcomeTest(closure, 'operator', () => evidence.phase('journey-operator', () => closureCell(closure, 'operator', () => sessions, () => delivered('operator'))));

});
