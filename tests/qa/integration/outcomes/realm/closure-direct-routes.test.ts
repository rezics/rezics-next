import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import declaration from '../../../../../scripts/qa/cases/outcomes/realm/closure-direct-routes.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions, type PersonaName, type PersonaSession, type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let closed: PersonaSessions;
let live: PersonaSessions;
let privateRealm: PersonaSessions;
let setupFailure: string | null = null;
let closureFailure: string | null = null;
let privateClosureFailure: string | null = null;
let adopted: Awaited<ReturnType<typeof publish>>;
let liveAdoption: Awaited<ReturnType<typeof publish>>;
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
async function closeRealm(sessions: PersonaSessions): Promise<string | null> {
  const operator = sessions.operator;
  try {
    const basis = await command<{ revision: string }>(
      sessions.owner, 'GET', `${root(sessions)}?${acting(sessions.owner)}`,
    );
    const ruleKey = randomUUID();
    const published = await command<{ ref: string; revision: string; digest: string }>(
      operator, 'POST', '/v1/governance/rules', {
        profile: 'governance-rule-v1', ref: `urn:rezics:rule:${randomUUID()}`,
        scopeId: 'governance:platform', actingSubject: operator.actingSubject,
        expectedRevision: null, document: { rule: 'Conceal this synthetic closure fixture' },
        idempotencyKey: ruleKey,
      }, 201, ruleKey,
    );
    const reportKey = randomUUID();
    const report = await command<{ caseId: string }>(
      sessions.stranger, 'POST', '/v1/reports', {
        profile: 'content-report-v1', actingSubject: sessions.stranger.actingSubject,
        authority: { kind: 'platform', scopeId: 'governance:platform' },
        context: 'urn:rezics:context:global',
        target: { owner: 'graph', resource: sessions.realm, component: 'record' },
        disclosure: 'parties', reasonCode: 'reviewed_removal',
        statement: 'Review this synthetic Realm record independently of its public Works.',
        evidence: [{ owner: 'graph', resource: sessions.realm, component: 'record',
          revision: null, locator: null }],
        idempotencyKey: reportKey,
      }, 201, reportKey,
    );
    const claimKey = randomUUID();
    await command(operator, 'POST', `/v1/safety-cases/${report.caseId}/claim`, {
      actingSubject: operator.actingSubject, idempotencyKey: claimKey,
    }, 200, claimKey);
    const safety = await command<{ generation: string; reports: { evidenceDigest: string }[] }>(
      operator, 'GET', `/v1/safety-cases/${report.caseId}?${acting(operator)}`,
    );
    const key = randomUUID();
    const input = {
      profile: 'moderation-decision-v1', caseId: report.caseId,
      expectedGeneration: safety.generation, actingSubject: operator.actingSubject,
      outcome: 'restrict',
      targets: [{ owner: 'graph', resource: sessions.realm, component: 'record',
        locator: null, scopeKind: 'component', revision: null,
        expectedHead: basis.revision, effect: 'disclosure' }],
      rule: { ref: published.ref, revision: published.revision, digest: published.digest },
      evidenceDigest: safety.reports[0]!.evidenceDigest,
      reversesDecisionId: null, answersStepId: null,
      rationale: 'Close only the exact Realm record', disclosure: 'parties',
      reasons: {
        facts: 'The synthetic report and exact Realm record were reviewed.',
        scope: 'Only the declared Realm record.', duration: 'Until a later staff decision.',
        automation: false, appealRoute: '/v1/public-reports/{caseId}/correspondence',
        contentLanguage: 'en',
      },
      idempotencyKey: key,
    };
    // Replay the same admitted command; a 202 is not an effective closure.
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await operator.main('POST', '/v1/moderation/decisions', input, key);
      const raw = await response.text();
      const result = JSON.parse(raw) as { operation?: { status: string } };
      if (response.status === 200 && result.operation?.status === 'completed') return null;
      if (response.status !== 202 || attempt === 3)
        throw new Error(`POST /v1/moderation/decisions: ${response.status} ${raw}`);
    }
    throw new Error('Platform closure did not complete');
  } catch (error) {
    return String(error);
  }
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

// Setup uses public commands. A product refusal remains an explicit pending
// prerequisite; OAuth/application failures escape beforeAll as infrastructure errors.
beforeAll(async () => {
  closed = await personaSessions('public');
  live = await personaSessions('public');
  privateRealm = await personaSessions('private');
  try {
    adopted = await publish(closed, true);
    liveAdoption = await publish(live, true);
    for (const fixture of [closed, live]) {
      // The persona helper attaches a separate Space's Zone. D6 needs a
      // Realm-owned Zone, so detach that site and create one in the Realm Space.
      const owner = fixture.owner;
      const path = `/v1/zones/${short(fixture.zone)}/configuration`;
      const config = await command<{ revision: string }>(owner, 'GET', `${path}?${acting(owner)}`);
      await command(owner, 'PUT', path, {
        actingSubject: owner.actingSubject, expectedHead: config.revision, defaultRealm: null,
      });
      const zone = `https://rezics.com/id/${randomUUID()}`;
      const created = await command<{ revision: string }>(owner, 'POST', '/v1/zones', {
        zone, space: fixture.space, disclosure: 'public', name: 'Realm-owned original fixture site',
        language: 'en', actingSubject: owner.actingSubject,
      }, 201);
      await command(owner, 'PUT', `/v1/zones/${short(zone)}/configuration`, {
        actingSubject: owner.actingSubject, expectedHead: created.revision, defaultRealm: fixture.realm,
      });
    }
    const owner = privateRealm.owner;
    const settings = await command<{ generation: string }>(owner, 'GET',
      `/v1/spaces/${short(privateRealm.space)}/settings?${acting(owner)}`);
    await command(owner, 'PUT', `/v1/spaces/${short(privateRealm.space)}/settings`, {
      actingSubject: owner.actingSubject, expectedGeneration: settings.generation,
      settings: { visibility: 'private', listing: 'listed', admission: 'request', history: 'everything' },
      reason: 'Retain a private request-admission teaser control',
    }, 201);
    for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
      for (const path of paths(closed, adopted.decision!, closed[name]))
        before.set(`${name}:${path}`, await observe(closed[name], path));
      const teaser = `${root(privateRealm)}/join-page?${acting(privateRealm[name])}`;
      before.set(`${name}:${teaser}`, await observe(privateRealm[name], teaser));
    }
  } catch (error) { setupFailure = String(error); }
  // Closure commands are independent of adoption/teaser setup.
  closureFailure = await closeRealm(closed);
  privateClosureFailure = await closeRealm(privateRealm);
  if (setupFailure) console.log(`Direct-read prerequisite: ${setupFailure}`);
  if (closureFailure) console.log(`Direct-read closure prerequisite: ${closureFailure}`);
  if (privateClosureFailure) console.log(`Private teaser closure prerequisite: ${privateClosureFailure}`);
}, 180_000);
afterAll(async () => { await closed?.close(); });

function paths(sessions: PersonaSessions, decision: string, person: PersonaSession) {
  return ['', '/works', '/decisions', `/decisions/${short(decision)}`, '/zone']
    .map(suffix => `${root(sessions)}${suffix}?${acting(person)}`);
}
async function reads(name: PersonaName) {
  expect(closureFailure, closureFailure ?? '').toBeNull();
  expect(privateClosureFailure, privateClosureFailure ?? '').toBeNull();
  expect(setupFailure, setupFailure ?? '').toBeNull();
  const person = closed[name];
  const failures: string[] = [];
  const closedPaths = paths(closed, adopted.decision!, person);
  const livePaths = paths(live, liveAdoption.decision!, person);
  const absentPaths = paths({ ...closed, realm: absentRealm }, adopted.decision!, person);
  for (let index = 0; index < closedPaths.length; index++) {
    const path = closedPaths[index]!;
    const control = before.get(`${name}:${path}`)!;
    const liveAnswer = await observe(person, livePaths[index]!);
    if (control.status !== 200 || liveAnswer.status !== 200)
      failures.push(`Live control GET ${path}: before ${control.status} ${control.body}; independent ${liveAnswer.status} ${liveAnswer.body}`);
    concealed(failures, path, await observe(person, path), await observe(person, absentPaths[index]!));
  }
  const teaser = `${root(privateRealm)}/join-page?${acting(privateRealm[name])}`;
  const teaserBefore = before.get(`${name}:${teaser}`)!;
  // Joined readers get the home, so join-page intentionally refuses a teaser.
  const teaserStatus = ['member', 'owner', 'moderator'].includes(name) ? 404 : 200;
  if (teaserBefore.status !== teaserStatus)
    failures.push(`Live private teaser GET ${teaser}: ${teaserBefore.status} ${teaserBefore.body}`);
  concealed(failures, teaser, await observe(privateRealm[name], teaser),
    await observe(privateRealm[name], `/v1/realms/${short(absentRealm)}/join-page?${acting(privateRealm[name])}`));
  // A Realm adoption is not ancestry for this independent public publication.
  const independent = await observe(person, `/v1/works/${short(adopted.work)}?${acting(person)}`);
  if (independent.status !== 200)
    failures.push(`Independent GET /v1/works/${short(adopted.work)}: ${independent.status} ${independent.body}`);
  const publicationPath = `/v1/main-versions/${short(adopted.mainVersion)}/selection`;
  const publication = await observe(person, publicationPath);
  if (publication.status !== 200 || (JSON.parse(publication.body) as { body?: string }).body !==
      'An original fixture story by the owner Person, published independently.')
    failures.push(`Independent publication GET ${publicationPath}: ${publication.status} ${publication.body}`);
  reportFailures(failures);
}
outcomeTest(declaration, 'visitor', () => reads('visitor'));
outcomeTest(declaration, 'stranger', () => reads('stranger'));
outcomeTest(declaration, 'member', () => reads('member'));
outcomeTest(declaration, 'owner', () => reads('owner'));
outcomeTest(declaration, 'moderator', () => reads('moderator'));
outcomeTest(declaration, 'operator', () => reads('operator'));
