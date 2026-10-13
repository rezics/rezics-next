import { outcomeTest } from '../../../support/outcome-test.ts';
import { closeRealm, closureCell } from './closure-fixture.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID, createHash } from 'node:crypto';
import declaration from '../../../../../scripts/qa/cases/outcomes/realm/closure-threads-and-replies.ts';
import {
  personaSessions, type PersonaName, type PersonaSession, type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let closed: PersonaSessions;
let live: PersonaSessions;
let work: Awaited<ReturnType<typeof publish>>;
let liveWork: Awaited<ReturnType<typeof publish>>;
type Reply = { reply: string; revisionId: string; revisionDigest: string };
let opener: Reply;
let descendant: Reply;
let liveOpener: Reply;
let setupFailure: string | null = null;
let closureFailure: string | null = null;
const absentRealm = `https://rezics.com/id/${randomUUID()}`;
const before = new Map<string, Answer>();
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
const root = (sessions: PersonaSessions) => `/v1/realms/${short(sessions.realm)}`;
type Answer = { status: number; body: string };
async function observe(person: PersonaSession, path: string): Promise<Answer> {
  const response = await person.main('GET', path);
  return { status: response.status, body: await response.text() };
}
async function command<T>(
  person: PersonaSession, method: string, path: string, body?: unknown,
  status = 200, key?: string,
): Promise<T> {
  const response = await person.main(method, path, body, key);
  const raw = await response.text();
  if (response.status !== status)
    throw new Error(`${method} ${path}: expected ${status}, received ${response.status} ${raw}`);
  return JSON.parse(raw) as T;
}

function concealed(failures: string[], path: string, answer: Answer, absent: Answer) {
  if (answer.status !== absent.status || JSON.stringify(JSON.parse(answer.body)) !==
      JSON.stringify(JSON.parse(absent.body))) {
    failures.push(`GET ${path}: ${answer.status} ${answer.body}; absent: ${absent.status} ${absent.body}`);
  }
}
function reportFailures(failures: string[]) {
  if (failures.length) console.log(failures.join('\n'));
  expect(failures, failures.join('\n')).toEqual([]);
}

type Work = { work: string; mainVersion: string; workRevision: string };
async function publish(sessions: PersonaSessions, adopt: boolean) {
  const owner = sessions.owner;
  const work = await command<Work>(owner, 'POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Independent original closure control',
    language: 'en', authoring: 'own-work', actingSubject: owner.actingSubject,
  }, 201);
  const draft = await command<{ contribution: string; draftRevision: string }>(
    owner, 'POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en',
      body: 'An original fixture story by the owner Person, published independently.',
      actingSubject: owner.actingSubject,
    }, 201,
  );
  const publication = await command<{ publicationDecision: string }>(
    owner, 'POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: owner.actingSubject,
    }, 201,
  );
  const selection = { work: work.work, contribution: draft.contribution,
    publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
    actingSubject: owner.actingSubject };
  await command(owner, 'POST', '/v1/publication-selections', {
    ...selection, profile: 'main-default-selection-v1',
    context: { kind: 'main-version-default', id: work.mainVersion },
    selectionBasis: 'main-maintainer',
  }, 201);
  let decision: string | null = null;
  if (adopt) {
    await role(sessions, ['publication.adopt'], owner);
    decision = (await command<{ selection: string }>(
      owner, 'POST', '/v1/publication-selections', {
        ...selection, profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: sessions.realm }, mainVersion: work.mainVersion,
        selectionBasis: 'realm-manager-review',
      }, 201,
    )).selection;
  }
  return { ...work, decision };
}
async function role(sessions: PersonaSessions, permissions: string[], holder: PersonaSession) {
  const owner = sessions.owner;
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Fixture publishers and reviewers', permissions },
    { kind: 'assignment', roleId, member: holder.actingSubject, assigned: true,
      validUntil: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    const basis = await command<{ generation: string }>(owner, 'GET',
      `${root(sessions)}/roles?${acting(owner)}`);
    const input = { actingSubject: owner.actingSubject, expectedGeneration: basis.generation,
      reason: 'Publish original closure controls', change };
    const impact = await command<{ digest: string }>(
      owner, 'POST', `${root(sessions)}/role-impact`, input);
    await command(owner, 'POST', `${root(sessions)}/role-changes`,
      { ...input, impactDigest: impact.digest }, 201);
  }
}

async function place(sessions: PersonaSessions, target: Work, text: string, parent?: Reply) {
  const member = sessions.member;
  const moderator = sessions.moderator;
  const reply = `https://rezics.com/id/${randomUUID()}`;
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await command<{ revisionId: string; revisionDigest: string }>(
    member, 'POST', '/v1/member-reply-drafts', {
      profile: 'member-reply-draft-v1', reply, variantId,
      rootTarget: target.work, rootRevision: target.workRevision, originRealm: sessions.realm,
      language: 'en', direction: 'ltr', expectedHead: null, body: text,
      actingSubject: member.actingSubject,
    }, 201,
  );
  await command(member, 'POST', '/v1/realm-replies', {
    profile: 'realm-reply-identity-v1', reply, variantId, revisionId: draft.revisionId,
    author: member.actingSubject, rootTarget: target.work, rootRevision: target.workRevision,
    parentReply: parent?.reply ?? null, parentRevision: parent?.revisionId ?? null,
    contextRevision: null,
  }, 201);
  const review = await command<{ decisionId: string }>(
    moderator, 'POST', '/v1/realm-reply-reviews', {
      profile: 'realm-reply-review-v1', realm: sessions.realm, reply,
      revisionId: draft.revisionId, revisionDigest: draft.revisionDigest,
      expectedGeneration: '0', supersedes: null, outcome: 'approved', method: 'human',
      methodRevision: 'realm-manager-v1',
      dependencyDigest: createHash('sha256').update(target.work).digest('hex'),
      reasonReference: null, actingSubject: moderator.actingSubject,
    }, 201,
  );
  await command(moderator, 'POST', '/v1/realm-reply-placements', {
    profile: 'realm-reply-placement-v1', realm: sessions.realm, reply,
    revisionId: draft.revisionId, revisionDigest: draft.revisionDigest,
    reviewDecisionId: review.decisionId, expectedHead: null,
    actingSubject: moderator.actingSubject,
  }, 201);
  return { reply, ...draft };
}
beforeAll(async () => {
  closed = await personaSessions('public');
  live = await personaSessions('public');
  try {
    work = await publish(closed, false);
    liveWork = await publish(live, false);
    await role(closed, ['review.decide', 'publication.adopt'], closed.moderator);
    await role(live, ['review.decide', 'publication.adopt'], live.moderator);
    opener = await place(closed, work, 'Original member opener\nA public discussion retained through closure.');
    descendant = await place(closed, work, 'An original member descendant.', opener);
    liveOpener = await place(live, liveWork, 'Independent live member opener\nThe control Realm remains open.');
    for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const)
      for (const path of paths(closed.realm, work, opener, descendant, closed[name]))
        before.set(`${name}:${path}`, await observe(closed[name], path));
  } catch (error) { setupFailure = String(error); }
  closureFailure = await closeRealm(closed);
  if (setupFailure) console.log(`Discussion prerequisite: ${setupFailure}`);
  if (closureFailure) console.log(`Discussion closure prerequisite: ${closureFailure}`);
}, 180_000);
afterAll(async () => { await closed?.close(); });

function paths(realm: string, target: Work, first: Reply, child: Reply, person: PersonaSession) {
  const base = `/v1/realms/${short(realm)}`;
  const actor = acting(person);
  // Supply syntactically valid coordinates even without a bearer, so the
  // visitor proves authentication rather than missing-query validation.
  const requiredActor = actor || `actingSubject=${encodeURIComponent(absentRealm)}`;
  return [
    ...['new', 'best', 'top'].map(sort => `${base}/threads?sort=${sort}&${actor}`),
    `${base}/threads/${short(first.reply)}?${actor}`,
    `${base}/threads/${short(child.reply)}?${actor}`,
    `${base}/about-thread?about=${encodeURIComponent(target.work)}&${actor}`,
    // These two routes declare full native IRIs, rather than UUID path parameters.
    `/v1/realms/${encodeURIComponent(realm)}/replies/${encodeURIComponent(child.reply)}?${requiredActor}`,
    `/v1/realms/${encodeURIComponent(realm)}/reply-roots/${encodeURIComponent(target.work)}/count?${requiredActor}`,
  ];
}
async function reads(name: PersonaName) {
  expect(closureFailure, closureFailure ?? '').toBeNull();
  expect(setupFailure, setupFailure ?? '').toBeNull();
  const person = closed[name];
  const failures: string[] = [];
  const closedPaths = paths(closed.realm, work, opener, descendant, person);
  const absentPaths = paths(absentRealm, work, opener, descendant, person);
  const livePaths = paths(live.realm, liveWork, liveOpener, liveOpener, person);
  for (let index = 0; index < closedPaths.length; index++) {
    const path = closedPaths[index]!;
    const control = before.get(`${name}:${path}`)!;
    const liveAnswer = await observe(person, livePaths[index]!);
    // Signed-out requests to the two authenticated routes retain their auth refusal.
    if (name === 'visitor' && index >= 6) {
      if (control.status !== 401 || liveAnswer.status !== 401)
        failures.push(`Authentication control GET ${path}: ${control.status} ${control.body}; live ${liveAnswer.status} ${liveAnswer.body}`);
    } else if (control.status !== 200 || liveAnswer.status !== 200) {
      failures.push(`Live control GET ${path}: before ${control.status} ${control.body}; independent ${liveAnswer.status} ${liveAnswer.body}`);
    } else {
      const body = JSON.parse(control.body) as {
        items?: { reply: string }[]; thread?: string | { reply: string }; count?: number;
      };
      if (index < 5 && !body.items?.some(item => item.reply === (index === 4 ? descendant.reply : opener.reply)))
        failures.push(`Populated control GET ${path}: ${control.body}`);
      // Legacy placed discussions do not establish the canonical about-post key.
      // A valid live lookup is null; even that lookup is refused after closure.
      if (index === 5 && body.thread !== null)
        failures.push(`Unregistered canonical lookup control GET ${path}: ${control.body}`);
      if (index === 7 && body.count !== 2)
        failures.push(`Populated count control GET ${path}: ${control.body}`);
    }
    concealed(failures, path, await observe(person, path), await observe(person, absentPaths[index]!));
  }
  const independent = await observe(person, `/v1/works/${short(work.work)}?${acting(person)}`);
  if (independent.status !== 200)
    failures.push(`Independent root GET /v1/works/${short(work.work)}: ${independent.status} ${independent.body}`);
  const publicationPath = `/v1/main-versions/${short(work.mainVersion)}/selection`;
  const publication = await observe(person, publicationPath);
  if (publication.status !== 200 || (JSON.parse(publication.body) as { body?: string }).body !==
      'An original fixture story by the owner Person, published independently.')
    failures.push(`Independent publication GET ${publicationPath}: ${publication.status} ${publication.body}`);
  reportFailures(failures);
}
outcomeTest(declaration, 'visitor', () => closureCell(declaration, 'visitor', () => closed, () => reads('visitor')));
outcomeTest(declaration, 'stranger', () => closureCell(declaration, 'stranger', () => closed, () => reads('stranger')));
outcomeTest(declaration, 'member', () => closureCell(declaration, 'member', () => closed, () => reads('member')));
outcomeTest(declaration, 'owner', () => closureCell(declaration, 'owner', () => closed, () => reads('owner')));
outcomeTest(declaration, 'moderator', () => closureCell(declaration, 'moderator', () => closed, () => reads('moderator')));
outcomeTest(declaration, 'operator', () => closureCell(declaration, 'operator', () => closed, () => reads('operator')));
