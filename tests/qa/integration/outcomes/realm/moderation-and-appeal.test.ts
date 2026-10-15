import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { BFF_PREFIX, browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { appealClient } from '../../../../../apps/web/features/realm-appeal/api.ts';
import { gateFor } from '../../../../../apps/web/features/api/platform-access.ts';
import type { PlatformAccessSummary } from '../../../../../generated/openapi/main/exposure.ts';
import { readQueueNames } from '../../../../../apps/web/features/manage/queue-api.ts';
import { readDecisionBasis, readManagedRealms, readQueue, readRealmHeader, settle } from '../../../../../apps/web/features/manage/read.ts';
import { readManagementAccess } from '../../../../../apps/web/features/manage/settings-api.ts';
import { realmEditSite } from '../../../../../apps/web/features/manage/realm-site.ts';
import { readAppealReceipt } from '../../../../../apps/web/features/realm-appeal/ban-read.ts';
import moderation from '../../../../../scripts/qa/cases/outcomes/realm/moderation-and-appeal.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { recordFrameReads } from '../../../support/frame-reads.ts';
import { personaNames, personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

type Members = { generation: string; items: { member: string; membershipGeneration: string; banned: boolean }[] };
type Reading = { realm: string; receiptId: string; appeal: {
  state: string; caseId?: string; statement?: string; outcome?: string; rationale?: string | null;
  liftedAt?: string; liftReceiptId?: string | null;
} };
type Fixture = { sessions: PersonaSessions; receiptId: string; path: string; root: string };
setDefaultTimeout(185_000);
const proofDeadlineMs = 60_000; // The original persona proof owns these 60 seconds.
const readDeadlineMs = 120_000;
async function withinDeadline(part: string, milliseconds: number, run: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${part} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
const fixtures = {} as Record<PersonaName, Fixture>;
const recording = new OutcomeRecorder(moderation);
const short = (value: string) => value.slice(-36);
const acting = (person: PersonaSession) => new URLSearchParams(person.actingSubject ? { actingSubject: person.actingSubject } : {});

function productionMain(name: PersonaName, person: PersonaSession, prefix: string) {
  const sample = recording.session(name, person);
  let index = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    const path = `${url.pathname.slice(BFF_PREFIX.length)}${url.search}`;
    const raw = await request.text();
    return sample(`${prefix}-${++index}`, request.method, path, raw ? JSON.parse(raw) as unknown : undefined,
      request.headers.get('idempotency-key') ?? undefined, { headers: Object.fromEntries(request.headers) });
  };
  return { main: browserMainApi('http://localhost', { fetcher, cache: 'no-store' }), fetcher };
}

async function managementReads(name: PersonaName, fixture: Fixture, person: PersonaSession,
  prefix: string, state: 'open' | 'closed', caseId?: string) {
  const { main } = productionMain(name, person, prefix), realm = short(fixture.sessions.realm);
  const actingSubject = person.actingSubject!;
  await readRealmHeader(main, realm, 'en', actingSubject);
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const permissions = await readManagedRealms(main, actingSubject, after);
    if (!permissions.ok || permissions.data.items.some(item => short(item.realm) === realm)
      || !permissions.data.nextCursor) break;
    after = permissions.data.nextCursor;
  }
  await realmEditSite({
    zone: () => settle(() => main.v1.realms({ realm }).zone.get({ query: { actingSubject } })),
    editor: zone => settle(() => main.v1.zones({ zone })['showcase-editor'].get({ query: { actingSubject } })),
  });
  const page = await readQueue(main, realm, { actingSubject, state, type: null });
  if (page.ok) {
    await readQueueNames(main, realm, page.data.items, { language: 'en', actingSubject }, undefined,
      productionMain(name, fixture.sessions.visitor, `${prefix}-public-name`).main);
  }
  if (caseId) await readDecisionBasis(main, realm, caseId, actingSubject);
  // The queue's current sanction appeal reads its basis and receipt on first paint.
  // Selecting a different case reads that case too. The basis of a named case was read above.
  if (!page.ok) {
    // The frame still mounts its section tabs when the queue refuses.
    await readManagementAccess(main, realm, actingSubject);
    return;
  }
  const appeals = page.data.items.filter(item => item.kind === 'realm_sanction_appeal');
  const initial = appeals[0];
  const chosen = caseId ? appeals.find(item => item.id === caseId) ?? initial : initial;
  const seen = new Set<string>();
  for (const item of [initial, chosen]) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    if (item.id !== caseId) await readDecisionBasis(main, realm, item.id, actingSubject);
    if (/^[0-9a-f-]{36}$/.test(item.target.resource)) await readAppealReceipt(main, realm, item.target.resource);
  }
  // Section tabs resolve settings authority after the queue is on screen.
  await readManagementAccess(main, realm, actingSubject);
}

async function pageReads(name: PersonaName) {
  const fixture = fixtures[name], { sessions } = fixture, person = sessions[name];
  await recordFrameReads(recording, name, person, sessions.visitor, sessions.realm, sessions.zone,
    'space', short(sessions.zone), '/');
  const sample = recording.session(name, person);
  if (person.actingSubject) {
    for (const [label, path] of [
      ['page-agent-choices', '/v1/me/agents?languages=en'],
      ['page-acting-contexts', '/v1/me/acting-contexts?task=work.create'],
      ['page-acting-agent-profile', `/v1/agents/${short(person.actingSubject)}?${acting(person)}`],
    ] as const) await (await sample(label, 'GET', path)).body?.cancel();
  }
  if (name === 'member') {
    const platform = await answer<PlatformAccessSummary>(sample('form-platform-access', 'GET', '/v1/me/platform-access'));
    const operationOpen = gateFor(platform);
    if (operationOpen('getV1RealmsByRealmMember-ban')) {
      const own = await ban(sessions, person);
      await (await sample('form-own-ban', 'GET', `${fixture.root}/member-ban?${acting(person)}`)).body?.cancel();
      await appealClient(sessions.realm, own.receiptId, productionMain(name, person, 'appeal-form').fetcher,
        operationOpen).submit('My original statement contests this sanction.', randomUUID());
    }
  }
  if (name === 'moderator') {
    await managementReads(name, fixture, person, 'moderator-management', 'closed');
    const own = await ban(sessions, sessions.member);
    const openedFixture = { ...fixture, receiptId: own.receiptId,
      path: `${fixture.root}/member-receipts/${own.receiptId}/appeal` };
    const { caseId } = await open(openedFixture);
    await managementReads(name, fixture, person, 'moderator-open', 'open', caseId);
    await managementReads(name, fixtures.owner, person, 'moderator-other-realm', 'open');
  }
  if (name === 'owner') {
    const own = await ban(sessions, sessions.member);
    const decidedFixture = { ...fixture, receiptId: own.receiptId,
      path: `${fixture.root}/member-receipts/${own.receiptId}/appeal` };
    const { caseId } = await open(decidedFixture);
    await managementReads(name, fixture, person, 'owner-before-decision', 'open', caseId);
    await decide(sessions.moderator, decision(sessions.moderator, caseId, 'dismiss', randomUUID(), 'private'), 200);
    await managementReads(name, fixture, person, 'owner-decided', 'closed', caseId);
  }
}

function recordedProof(name: PersonaName, proof: () => Promise<void>) {
  return async () => {
    await withinDeadline(`${name} proof`, proofDeadlineMs, proof);
    await withinDeadline(`${name} page reads`, readDeadlineMs, () => pageReads(name));
  };
}
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
  await recording.prepare();
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
afterAll(async () => {
  try { await recording.publish(); }
  finally { await fixtures.visitor?.sessions.close(); }
});

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
async function read(fixture: Fixture, person = fixture.sessions.member,
  sample?: ReturnType<OutcomeRecorder['session']>, label = 'appeal-reading') {
  const reading = await answer<Reading>(sample ? sample(label, 'GET', fixture.path)
    : person.main('GET', fixture.path));
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
async function restored(fixture: Fixture, caseId: string, sample?: ReturnType<OutcomeRecorder['session']>) {
  const reading = await read(fixture, fixture.sessions.member, sample, 'appeal-restored');
  expect(reading.appeal).toMatchObject({ state: 'decided', caseId, outcome: 'reversed',
    rationale: 'The original fixture sanction was reviewed.' });
  expect(reading.appeal.liftedAt).toEqual(expect.any(String));
  expect(reading.appeal.liftReceiptId).toMatch(/^[0-9a-f-]{36}$/);
  // Lifting the active ban retains the appellant's authorized receipt history.
  const path = `${fixture.root}/member-ban?${acting(fixture.sessions.member)}`;
  const history = await answer<Reading>(sample ? sample('own-ban-restored', 'GET', path)
    : fixture.sessions.member.main('GET', path));
  expect(history.appeal).toMatchObject({ state: 'decided', caseId, outcome: 'reversed',
    liftReceiptId: reading.appeal.liftReceiptId });
  protectedIdentity(history, fixture.sessions);
  const members = await answer<Members>(fixture.sessions.owner.main('GET', `${fixture.root}/members?${acting(fixture.sessions.owner)}`));
  expect(members.items.find(item => item.member === fixture.sessions.member.actingSubject)?.banned).toBe(false);
}

outcomeTest(moderation, 'visitor', recordedProof('visitor', async () => {
  const fixture = fixtures.visitor, person = fixture.sessions.visitor;
  const sample = recording.session('visitor', person);
  for (const path of [fixture.path, `${fixture.root}/member-ban?${acting(fixture.sessions.member)}`])
    await answer(sample(path === fixture.path ? 'appeal-sign-in-required' : 'ban-sign-in-required', 'GET', path), 401);
  await cannotImpersonate(fixture, person, 401);
  await answer(person.main('GET', fixture.root), 404);
  expect((await read(fixture)).appeal).toEqual({ state: 'none' });
}), recording);
outcomeTest(moderation, 'stranger', recordedProof('stranger', async () => {
  const fixture = fixtures.stranger, person = fixture.sessions.stranger;
  const sample = recording.session('stranger', person);
  await answer(sample('another-members-appeal-hidden', 'GET', fixture.path), 404);
  await answer(sample('another-members-ban-hidden', 'GET', `${fixture.root}/member-ban?${acting(fixture.sessions.member)}`), 404);
  await cannotImpersonate(fixture, person);
  const { caseId } = await open(fixture), before = await read(fixture);
  await decide(person, decision(person, caseId, 'restore'), 403);
  expect(await read(fixture)).toEqual(before);
  // Membership and appellant control are separate: an unjoined sanctioned
  // Person still controls their own appeal, never the member's appeal.
  const own = await ban(fixture.sessions, person), path = `${fixture.root}/member-receipts/${own.receiptId}/appeal`;
  await answer(person.main('GET', `${fixture.root}?${acting(person)}`), 404);
  await answer(person.main('POST', path, { statement: 'My own unjoined-subject sanction is appealed.' }), 201);
  const reading = await answer<Reading>(sample('unjoined-appellant-open', 'GET', path));
  expect(reading.appeal.state).toBe('open'); protectedIdentity(reading, fixture.sessions);
}), recording);
outcomeTest(moderation, 'member', recordedProof('member', async () => {
  const fixture = fixtures.member, person = fixture.sessions.member;
  const sample = recording.session('member', person);
  await answer(sample('appeal-access', 'GET', '/v1/me/platform-access'));
  await answer(sample('own-ban', 'GET', `${fixture.root}/member-ban?${acting(person)}`));
  await answer(sample('realm-header-banned', 'GET', `${fixture.root}?${acting(person)}`), 404);
  expect((await read(fixture, person, sample, 'appeal-none')).appeal).toEqual({ state: 'none' });
  const key = randomUUID(), input = { statement: 'My original statement contests this sanction.' };
  const opened = await answer<{ caseId: string }>(sample('appeal-opened', 'POST', fixture.path, input, key), 201);
  expect(await answer(person.main('POST', fixture.path, input, key))).toMatchObject({ caseId: opened.caseId, replayed: true });
  expect(await answer(sample('appeal-intent-conflict', 'POST', fixture.path, { statement: 'Changed intent.' }, key), 409)).toMatchObject({ code: 'idempotency_conflict' });
  expect(await answer(person.main('POST', fixture.path, input), 409)).toMatchObject({ code: 'appeal_already_open' });
  const before = await read(fixture, person, sample, 'appeal-open');
  await decide(person, decision(person, opened.caseId, 'restore'), 403);
  expect(await read(fixture)).toEqual(before);
  await decide(fixture.sessions.owner, decision(fixture.sessions.owner, opened.caseId, 'restore'), 200);
  await restored(fixture, opened.caseId, sample);
}), recording);
outcomeTest(moderation, 'owner', recordedProof('owner', async () => {
  const fixture = fixtures.owner, person = fixture.sessions.owner;
  const sample = recording.session('owner', person);
  for (const [label, path] of [
    ['session-agent', '/v1/me/session-agent'],
    ['agent-choices', '/v1/me/agents?languages=en'],
    ['acting-contexts', '/v1/me/acting-contexts?task=work.create'],
    ['acting-agent-profile', `/v1/agents/${person.actingSubject!.slice(-36)}?${acting(person)}`],
  ] as const) await (await sample(label, 'GET', path)).body?.cancel();
  await answer(sample('management-realm-header', 'GET', `${fixture.root}?${acting(person)}&language=en`));
  await answer(sample('moderation-queue-empty', 'GET', `${fixture.root}/moderation?${acting(person)}&state=open`));
  // The frame can render without a site link; retain the API's refusal too.
  await (await sample('management-site', 'GET', `${fixture.root}/zone?${acting(person)}`)).body?.cancel();
  await (await sample('site-editor-access', 'GET', `/v1/zones/${fixture.sessions.zone.slice(-36)}/showcase-editor?${acting(person)}`)).body?.cancel();
  await cannotImpersonate(fixture, person);
  await answer(person.main('GET', `${fixture.root}/member-ban?${acting(fixture.sessions.member)}`), 404);
  const { caseId } = await open(fixture), before = await read(fixture);
  expect((await read(fixture, person, sample, 'manager-appeal-open')).appeal.caseId).toBe(caseId);
  await answer(sample('moderation-queue-appeal', 'GET', `${fixture.root}/moderation?${acting(person)}&state=open`));
  await (await sample('appeal-decision-basis', 'GET', `${fixture.root}/moderation/${caseId}?${acting(person)}`)).body?.cancel();
  const stale = { ...decision(person, caseId, 'restore'), expectedGeneration: '9' };
  await decide(person, stale, 409); expect(await read(fixture)).toEqual(before);
  const command = decision(person, caseId, 'restore');
  await decide(person, command, 200); await restored(fixture, caseId);
  expect(await decide(person, command, 200)).toMatchObject({ replayed: true });
  await decide(person, { ...command, rationale: 'Changed intent under the same key.' }, 409);
  await restored(fixture, caseId);
}), recording);
outcomeTest(moderation, 'moderator', recordedProof('moderator', async () => {
  const fixture = fixtures.moderator, person = fixture.sessions.moderator;
  const sample = recording.session('moderator', person);
  await answer(sample('moderator-realm-header', 'GET', `${fixture.root}?${acting(person)}`));
  await cannotImpersonate(fixture, person);
  const { caseId } = await open(fixture), before = await read(fixture);
  expect((await read(fixture, person, sample, 'moderator-appeal-open')).appeal.caseId).toBe(caseId);
  await answer(person.main('GET', fixtures.owner.path), 404);
  await decide(person, decision(person, caseId, 'restore'), 403);
  expect(await read(fixture)).toEqual(before);
  await decide(person, decision(person, caseId, 'dismiss', randomUUID(), 'private'), 200);
  expect((await read(fixture, fixture.sessions.member,
    recording.session('moderator', fixture.sessions.member), 'appeal-dismissed-private')).appeal).toMatchObject({ state: 'decided', outcome: 'dismiss', rationale: null });
  const banReading = await answer<Reading>(fixture.sessions.member.main('GET', `${fixture.root}/member-ban?${acting(fixture.sessions.member)}`));
  expect(banReading.appeal).toMatchObject({ state: 'decided', outcome: 'dismiss', rationale: null });
  protectedIdentity(banReading, fixture.sessions);
}), recording);
outcomeTest(moderation, 'operator', recordedProof('operator', async () => {
  const fixture = fixtures.operator, person = fixture.sessions.operator;
  const sample = recording.session('operator', person);
  expect(await answer<{ groups: string[] }>(sample('platform-access', 'GET', '/v1/me/platform-access'))).toMatchObject({ groups: expect.arrayContaining(['platform-admin']) });
  await answer(person.main('GET', `${fixture.root}?${acting(person)}`), 404);
  await answer(sample('appeal-hidden', 'GET', fixture.path), 404);
  await answer(person.main('GET', `${fixture.root}/member-ban?${acting(fixture.sessions.member)}`), 404);
  await cannotImpersonate(fixture, person);
  const { caseId } = await open(fixture), before = await read(fixture);
  await decide(person, decision(person, caseId, 'restore'), 403);
  await decide(person, decision(person, caseId, 'dismiss'), 403);
  expect(await read(fixture)).toEqual(before);
}), recording);
