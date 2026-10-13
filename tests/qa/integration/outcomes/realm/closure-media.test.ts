import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import media from '../../../../../scripts/qa/cases/outcomes/realm/closure-media.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
let ruleAnswer: { status: number; body: string };
let ruleRequest: object;
let mandateAnswer: { status: number; body: string };

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

beforeAll(async () => {
  sessions = await personaSessions('public');
  const operator = sessions.operator;
  const actor = operator.actingSubject!;
  const authority = await answer<{ groups: string[] }>(operator.main('GET', '/v1/me/platform-access'));
  expect(authority.groups).toContain('platform-admin');
  // Request the exact action; platform administration cannot invent its assignment ceiling.
  const path = `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(actor)}`;
  const grants = await answer<{
    authorityEpoch: string;
    items: { permission: string; recipient: { principalId?: string } }[];
  }>(operator.main('GET', path));
  const recipient = grants.items.find(item => item.permission === 'platform:grant')?.recipient;
  expect(recipient?.principalId).toBeDefined();
  const mandateRequest = {
    profile: 'platform-grant-change-v1',
    issuerSubject: actor,
    expectedAuthorityEpoch: grants.authorityEpoch,
    grantId: randomUUID(),
    action: 'create',
    permission: 'platform:resource:governance.rule.publish',
    scopeId: 'governance:platform',
    recipient,
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const mandate = await operator.main('POST', '/v1/access/grant-changes', mandateRequest);
  mandateAnswer = { status: mandate.status, body: await mandate.text() };
  console.log('Closure rule-publisher mandate', JSON.stringify({ request: mandateRequest, answer: mandateAnswer }));
  expect(mandateAnswer.status, mandateAnswer.body).toBe(403);
  expect(JSON.parse(mandateAnswer.body)).toMatchObject({ code: 'grant_denied' });
  const key = randomUUID();
  ruleRequest = {
    profile: 'governance-rule-v1',
    ref: `urn:rezics:rule:${randomUUID()}`,
    scopeId: 'governance:platform',
    actingSubject: actor,
    expectedRevision: null,
    document: { rule: 'Close the affected Realm after reviewing its record' },
    idempotencyKey: key,
  };
  const response = await operator.main('POST', '/v1/governance/rules', ruleRequest, key);
  ruleAnswer = { status: response.status, body: await response.text() };
  console.log('Closure media rule prerequisite', JSON.stringify({ request: ruleRequest, answer: ruleAnswer }));
  // A changed prerequisite needs a complete closure fixture, not a silently green failing test.
  expect(ruleAnswer.status, ruleAnswer.body).toBe(403);
  expect(JSON.parse(ruleAnswer.body)).toMatchObject({ code: 'governance_denied' });
}, 180_000);

afterAll(async () => {
  await sessions?.close();
});

async function delivery(name: PersonaName) {
  const person = sessions[name];
  // Establish the actual reader over HTTP, rather than converting all six to anonymous doubles.
  const query = person.actingSubject
    ? `?actingSubject=${encodeURIComponent(person.actingSubject)}`
    : '';
  await answer(person.main('GET', `/v1/realms/${sessions.realm.slice(-36)}${query}`));
  // No byte or validator assertion can prove closure without a closed occurrence.
  throw new Error(
    `Public closure fixture unavailable: POST /v1/governance/rules ${JSON.stringify(ruleRequest)} -> ${ruleAnswer.status} ${ruleAnswer.body}. ` +
    `Rule-publisher mandate: ${mandateAnswer.status} ${mandateAnswer.body}. ` +
    'No public assignment ceiling establishes a platform rule publisher. Metadata, bare/exact-use bytes, conditional 304, Asset-owner separation, independent uses and final live disclosure remain unproved.',
  );
}

outcomeTest(media, 'visitor', () => delivery('visitor'));
outcomeTest(media, 'stranger', () => delivery('stranger'));
outcomeTest(media, 'member', () => delivery('member'));
outcomeTest(media, 'owner', () => delivery('owner'));
outcomeTest(media, 'moderator', () => delivery('moderator'));
outcomeTest(media, 'operator', () => delivery('operator'));
