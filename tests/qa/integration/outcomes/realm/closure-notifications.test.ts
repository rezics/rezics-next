import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import notifications from '../../../../../scripts/qa/cases/outcomes/realm/closure-notifications.ts';
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
  console.log('Closure notification rule prerequisite', JSON.stringify({ request: ruleRequest, answer: ruleAnswer }));
  // Keep an unrelated failure or a changed prerequisite out of expected-failure cells.
  expect(ruleAnswer.status, ruleAnswer.body).toBe(403);
  expect(JSON.parse(ruleAnswer.body)).toMatchObject({ code: 'governance_denied' });
}, 180_000);

afterAll(async () => {
  await sessions?.close();
});

async function recipient(name: Exclude<PersonaName, 'visitor'>) {
  const person = sessions[name];
  await answer(person.main('GET', '/v1/me/notifications'));
  await answer(person.main('GET', '/v1/me/notifications/unread-count'));
  await answer(person.main('GET', `/v1/deliveries/${randomUUID()}`), 404);
  // A refusal of this prerequisite is not evidence of closure suppression.
  // No owner writes, injected subjects or invented public dispatch replace it.
  throw new Error(
    `Public closure fixture unavailable: POST /v1/governance/rules ${JSON.stringify(ruleRequest)} -> ${ruleAnswer.status} ${ruleAnswer.body}. ` +
    `Rule-publisher mandate: ${mandateAnswer.status} ${mandateAnswer.body}. ` +
    'No public assignment ceiling establishes a platform rule publisher. Queue-before-close content, unrelated eligible delivery and permitted Access process fields remain unproved.',
  );
}

outcomeTest(notifications, 'visitor', async () => {
  for (const path of [
    '/v1/me/notifications',
    '/v1/me/notifications/unread-count',
    `/v1/deliveries/${randomUUID()}`,
  ]) {
    const problem = await answer<{ code: string }>(sessions.visitor.main('GET', path), 401);
    expect(problem.code).toBe('account_assertion_denied');
  }
});
outcomeTest(notifications, 'stranger', () => recipient('stranger'));
outcomeTest(notifications, 'member', () => recipient('member'));
outcomeTest(notifications, 'owner', () => recipient('owner'));
outcomeTest(notifications, 'moderator', () => recipient('moderator'));
outcomeTest(notifications, 'operator', () => recipient('operator'));
