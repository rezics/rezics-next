import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import moderation from '../../../../../scripts/qa/cases/outcomes/realm/moderation-and-appeal.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaNames, personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

type Members = { generation: string; items: { member: string; membershipGeneration: string; banned: boolean }[] };
type Reading = { realm: string; receiptId: string; appeal: {
  state: string; caseId?: string; statement?: string; outcome?: string; rationale?: string | null;
  liftedAt?: string; liftReceiptId?: string | null;
} };
type Fixture = { sessions: PersonaSessions; receiptId: string; path: string; root: string };
setDefaultTimeout(60_000);
const fixtures = {} as Record<PersonaName, Fixture>;
const short = (value: string) => value.slice(-36);
const acting = (person: PersonaSession) => new URLSearchParams(person.actingSubject ? { actingSubject: person.actingSubject } : {});
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
async function ban(sessions: PersonaSessions, person: PersonaSession) {
  const owner = sessions.owner, root = `/v1/realms/${short(sessions.realm)}`;
  const members = await answer<Members>(owner.main('GET', `${root}/members?${acting(owner)}`));
  const member = members.items.find(item => item.member === person.actingSubject);
  return answer<{ receiptId: string }>(owner.main('POST', `${root}/members`, {
    actingSubject: owner.actingSubject, member: person.actingSubject,
    expectedGeneration: members.generation, expectedMembershipGeneration: member?.membershipGeneration ?? '0',
    reason: 'Synthetic sanction for the appeal outcome proof', action: 'ban', consent: null, durationSeconds: null }), 201);
}
beforeAll(async () => {
  for (const name of personaNames) {
    const sessions = await personaSessions('private'), root = `/v1/realms/${short(sessions.realm)}`;
    const { receiptId } = await ban(sessions, sessions.member);
    const path = `${root}/member-receipts/${receiptId}/appeal`;
    fixtures[name] = { sessions, root, receiptId, path };
    // A successful own-ban read establishes the explicitly admitted QA gate.
    // Gate admission supplies no appellant or Realm-management authority.
    await answer(sessions.member.main('GET', `${root}/member-ban?${acting(sessions.member)}`));
  }
}, 180_000);
afterAll(async () => { await fixtures.visitor?.sessions.close(); });

function protectedIdentity(body: unknown, sessions: PersonaSessions) {
  const keys: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      keys.push(key); walk(item);
    }
  };
  walk(body);
  expect(keys.filter(key => /acting.?subject|decider|moderator|principal/i.test(key))).toEqual([]);
  const text = JSON.stringify(body);
  for (const name of ['owner', 'moderator', 'operator'] as const) {
    expect(text.includes(sessions[name].actingSubject!)).toBe(false);
    expect(text.includes(sessions[name].accountId!)).toBe(false);
  }
}
async function read(fixture: Fixture, person = fixture.sessions.member) {
  const reading = await answer<Reading>(person.main('GET', fixture.path));
  protectedIdentity(reading, fixture.sessions);
  return reading;
}
async function open(fixture: Fixture) {
  const { sessions, path } = fixture;
  return answer<{ caseId: string }>(sessions.member.main('POST', path, {
    statement: 'This original fixture statement requests review of my own sanction.' }), 201);
}
function decision(person: PersonaSession, caseId: string, outcome: 'restore' | 'dismiss', key = randomUUID(), disclosure = 'parties') {
  return { profile: 'moderation-decision-v1', outcome, caseId, expectedGeneration: '0',
    actingSubject: person.actingSubject, targets: [],
    rule: { ref: 'urn:rule:unused', revision: '1', digest: 'a'.repeat(64) }, evidenceDigest: 'b'.repeat(64),
    reversesDecisionId: null, answersStepId: null, rationale: 'The original fixture sanction was reviewed.',
    disclosure, idempotencyKey: key,
    reasons: { facts: 'The appellant statement was reviewed.', scope: 'Realm membership',
      duration: 'A permanent fixture sanction', automation: false,
      appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en' } };
}
async function decide(person: PersonaSession, input: ReturnType<typeof decision>, status: number) {
  return answer(person.main('POST', '/v1/moderation/decisions', input, input.idempotencyKey), status);
}
async function cannotImpersonate(fixture: Fixture, person: PersonaSession, status = 404) {
  const before = await read(fixture);
  await answer(person.main('POST', fixture.path, { statement: 'Staff cannot write the appellant statement.' }), status);
  expect(await read(fixture)).toEqual(before);
}
async function restored(fixture: Fixture, caseId: string) {
  const reading = await read(fixture);
  expect(reading.appeal).toMatchObject({ state: 'decided', caseId, outcome: 'reversed',
    rationale: 'The original fixture sanction was reviewed.' });
  expect(reading.appeal.liftedAt).toEqual(expect.any(String));
  expect(reading.appeal.liftReceiptId).toMatch(/^[0-9a-f-]{36}$/);
  // Lifting the active ban retains the appellant's authorized receipt history.
  const history = await answer<Reading>(fixture.sessions.member.main('GET',
    `${fixture.root}/member-ban?${acting(fixture.sessions.member)}`));
  expect(history.appeal).toMatchObject({ state: 'decided', caseId, outcome: 'reversed',
    liftReceiptId: reading.appeal.liftReceiptId });
  protectedIdentity(history, fixture.sessions);
  const members = await answer<Members>(fixture.sessions.owner.main('GET', `${fixture.root}/members?${acting(fixture.sessions.owner)}`));
  expect(members.items.find(item => item.member === fixture.sessions.member.actingSubject)?.banned).toBe(false);
}

outcomeTest(moderation, 'visitor', async () => {
  const fixture = fixtures.visitor, person = fixture.sessions.visitor;
  for (const path of [fixture.path, `${fixture.root}/member-ban?${acting(fixture.sessions.member)}`])
    await answer(person.main('GET', path), 401);
  await cannotImpersonate(fixture, person, 401);
  await answer(person.main('GET', fixture.root), 404);
  expect((await read(fixture)).appeal).toEqual({ state: 'none' });
});
outcomeTest(moderation, 'stranger', async () => {
  const fixture = fixtures.stranger, person = fixture.sessions.stranger;
  await answer(person.main('GET', fixture.path), 404);
  await answer(person.main('GET', `${fixture.root}/member-ban?${acting(fixture.sessions.member)}`), 404);
  await cannotImpersonate(fixture, person);
  const { caseId } = await open(fixture), before = await read(fixture);
  await decide(person, decision(person, caseId, 'restore'), 403);
  expect(await read(fixture)).toEqual(before);
  // Membership and appellant control are separate: an unjoined sanctioned
  // Person still controls their own appeal, never the member's appeal.
  const own = await ban(fixture.sessions, person), path = `${fixture.root}/member-receipts/${own.receiptId}/appeal`;
  await answer(person.main('GET', `${fixture.root}?${acting(person)}`), 404);
  await answer(person.main('POST', path, { statement: 'My own unjoined-subject sanction is appealed.' }), 201);
  const reading = await answer<Reading>(person.main('GET', path));
  expect(reading.appeal.state).toBe('open'); protectedIdentity(reading, fixture.sessions);
});
outcomeTest(moderation, 'member', async () => {
  const fixture = fixtures.member, person = fixture.sessions.member;
  expect((await read(fixture)).appeal).toEqual({ state: 'none' });
  const key = randomUUID(), input = { statement: 'My original statement contests this sanction.' };
  const opened = await answer<{ caseId: string }>(person.main('POST', fixture.path, input, key), 201);
  expect(await answer(person.main('POST', fixture.path, input, key))).toMatchObject({ caseId: opened.caseId, replayed: true });
  expect(await answer(person.main('POST', fixture.path, { statement: 'Changed intent.' }, key), 409)).toMatchObject({ code: 'idempotency_conflict' });
  expect(await answer(person.main('POST', fixture.path, input), 409)).toMatchObject({ code: 'appeal_already_open' });
  const before = await read(fixture);
  await decide(person, decision(person, opened.caseId, 'restore'), 403);
  expect(await read(fixture)).toEqual(before);
  await decide(fixture.sessions.owner, decision(fixture.sessions.owner, opened.caseId, 'restore'), 200);
  await restored(fixture, opened.caseId);
});
outcomeTest(moderation, 'owner', async () => {
  const fixture = fixtures.owner, person = fixture.sessions.owner;
  await cannotImpersonate(fixture, person);
  await answer(person.main('GET', `${fixture.root}/member-ban?${acting(fixture.sessions.member)}`), 404);
  const { caseId } = await open(fixture), before = await read(fixture);
  expect((await read(fixture, person)).appeal.caseId).toBe(caseId);
  const stale = { ...decision(person, caseId, 'restore'), expectedGeneration: '9' };
  await decide(person, stale, 409); expect(await read(fixture)).toEqual(before);
  const command = decision(person, caseId, 'restore');
  await decide(person, command, 200); await restored(fixture, caseId);
  expect(await decide(person, command, 200)).toMatchObject({ replayed: true });
  await decide(person, { ...command, rationale: 'Changed intent under the same key.' }, 409);
  await restored(fixture, caseId);
});
outcomeTest(moderation, 'moderator', async () => {
  const fixture = fixtures.moderator, person = fixture.sessions.moderator;
  await answer(person.main('GET', `${fixture.root}?${acting(person)}`));
  await cannotImpersonate(fixture, person);
  const { caseId } = await open(fixture), before = await read(fixture);
  expect((await read(fixture, person)).appeal.caseId).toBe(caseId);
  await answer(person.main('GET', fixtures.owner.path), 404);
  await decide(person, decision(person, caseId, 'restore'), 403);
  expect(await read(fixture)).toEqual(before);
  await decide(person, decision(person, caseId, 'dismiss', randomUUID(), 'private'), 200);
  expect((await read(fixture)).appeal).toMatchObject({ state: 'decided', outcome: 'dismiss', rationale: null });
  const banReading = await answer<Reading>(fixture.sessions.member.main('GET', `${fixture.root}/member-ban?${acting(fixture.sessions.member)}`));
  expect(banReading.appeal).toMatchObject({ state: 'decided', outcome: 'dismiss', rationale: null });
  protectedIdentity(banReading, fixture.sessions);
});
outcomeTest(moderation, 'operator', async () => {
  const fixture = fixtures.operator, person = fixture.sessions.operator;
  expect(await answer<{ groups: string[] }>(person.main('GET', '/v1/me/platform-access'))).toMatchObject({ groups: expect.arrayContaining(['platform-admin']) });
  await answer(person.main('GET', `${fixture.root}?${acting(person)}`), 404);
  await answer(person.main('GET', fixture.path), 404);
  await answer(person.main('GET', `${fixture.root}/member-ban?${acting(fixture.sessions.member)}`), 404);
  await cannotImpersonate(fixture, person);
  const { caseId } = await open(fixture), before = await read(fixture);
  await decide(person, decision(person, caseId, 'restore'), 403);
  await decide(person, decision(person, caseId, 'dismiss'), 403);
  expect(await read(fixture)).toEqual(before);
});
