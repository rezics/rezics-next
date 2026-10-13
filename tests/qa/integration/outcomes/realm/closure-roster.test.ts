import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import declaration from '../../../../../scripts/qa/cases/outcomes/realm/closure-roster.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions, type PersonaName, type PersonaSession, type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let closed: PersonaSessions;
let live: PersonaSessions;
let setupFailure: string | null = null;
let closureFailure: string | null = null;
let retainedCursor: string;
const absentRealm = `https://rezics.com/id/${randomUUID()}`;
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

async function listMembers(sessions: PersonaSessions) {
  for (const person of [sessions.member, sessions.moderator])
    await command(person, 'PUT', `${root(sessions)}/roster/listing`, {
      actingSubject: person.actingSubject, expectedMembershipGeneration: '1', listed: true,
    });
  await command(sessions.owner, 'PUT', `${root(sessions)}/roster/featured`, {
    actingSubject: sessions.owner.actingSubject, member: sessions.member.actingSubject,
    expectedMembershipGeneration: '1', featured: true,
  });
}
beforeAll(async () => {
  closed = await personaSessions('public');
  live = await personaSessions('public');
  try {
    await listMembers(closed);
    await listMembers(live);
    const first = await command<{ items: { agent: string }[]; nextCursor: string | null }>(
      closed.visitor, 'GET', `${root(closed)}/roster?limit=1`);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    retainedCursor = first.nextCursor!;
    const second = await command<{ items: { agent: string }[]; nextCursor: string | null }>(
      closed.visitor, 'GET', `${root(closed)}/roster?limit=1&after=${encodeURIComponent(retainedCursor)}`);
    expect([...first.items, ...second.items].map(item => item.agent).sort())
      .toEqual([closed.member.actingSubject!, closed.moderator.actingSubject!].sort());
    expect(second.nextCursor).toBeNull();
    const featured = await command<{ items: { agent: string }[] }>(
      closed.visitor, 'GET', `${root(closed)}/roster?featured=true`);
    expect(featured.items.map(item => item.agent)).toEqual([closed.member.actingSubject!]);
  } catch (error) { setupFailure = String(error); }
  closureFailure = await closeRealm(closed);
  if (setupFailure) console.log(`Roster prerequisite: ${setupFailure}`);
  if (closureFailure) console.log(`Roster closure prerequisite: ${closureFailure}`);
}, 180_000);
afterAll(async () => { await closed?.close(); });

async function reads(name: PersonaName) {
  expect(closureFailure, closureFailure ?? '').toBeNull();
  expect(setupFailure, setupFailure ?? '').toBeNull();
  const person = closed[name];
  const failures: string[] = [];
  for (const query of ['', '?featured=true', '?limit=1', `?limit=1&after=${encodeURIComponent(retainedCursor)}`]) {
    const path = `${root(closed)}/roster${query}`;
    // Absent currently returns 403. This qualifies equivalence without selecting
    // a new concealment status for the product.
    concealed(failures, path, await observe(person, path),
      await observe(person, `/v1/realms/${short(absentRealm)}/roster${query}`));
  }
  const controlPath = `${root(live)}/roster`;
  const control = await observe(person, controlPath);
  if (control.status !== 200)
    failures.push(`Live control GET ${controlPath}: ${control.status} ${control.body}`);
  else {
    const body = JSON.parse(control.body) as { items: { agent: string }[] };
    if (JSON.stringify(body.items.map(item => item.agent).sort()) !==
        JSON.stringify([live.member.actingSubject!, live.moderator.actingSubject!].sort()))
      failures.push(`Live consented members GET ${controlPath}: ${control.body}`);
  }
  reportFailures(failures);
}
outcomeTest(declaration, 'visitor', () => reads('visitor'));
outcomeTest(declaration, 'stranger', () => reads('stranger'));
outcomeTest(declaration, 'member', () => reads('member'));
outcomeTest(declaration, 'owner', () => reads('owner'));
outcomeTest(declaration, 'moderator', () => reads('moderator'));
outcomeTest(declaration, 'operator', () => reads('operator'));
