import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { personaNames, personaSessions, type PersonaSession, type PersonaSessions } from '../support/personas.ts';
import { closeRealm } from './outcomes/realm/closure-fixture.ts';

let sessions: PersonaSessions;
let publicAttachment: PersonaSessions;
const absent = randomUUID();
const evidence = `.temp/goal/${Bun.env.REZICS_QA_RUN_ID ?? 'local'}-realm-zone-personas.jsonl`;
beforeAll(async () => {
  mkdirSync('.temp/goal', { recursive: true });
  // Exactly the roles-and-team setup: private Realm, invited member/moderator,
  // independent Zone Space and a saved attachment, with no site publication.
  sessions = await personaSessions('private', { observeMain: async answer => {
    appendFileSync(evidence, `${JSON.stringify({
      caller: answer.caller.actingSubject, request: answer.request,
      response: answer.response, durationMs: answer.answeredAt - answer.requestStartedAt,
    })}\n`);
  } });
  // The attachment controls advance one public Realm through three states.
  // Create fixtures serially: they share listeners and failure cleanup.
  publicAttachment = await personaSessions('public');
}, 180_000);

async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}
const acting = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
async function configuration(person: PersonaSession, zone: string) {
  return answer<{ revision: string; configuration: { defaultRealm?: string } }>(
    person.main('GET', `/v1/zones/${zone.slice(-36)}/configuration?${acting(person)}`));
}
async function attach(person: PersonaSession, zone: string, revision: string, realm: string | null, status = 200) {
  return answer<{ code?: string }>(person.main('PUT', `/v1/zones/${zone.slice(-36)}/configuration`, {
    actingSubject: person.actingSubject, expectedHead: revision, defaultRealm: realm,
  }), status);
}
async function createZone(person: PersonaSession) {
  return answer<{ zone: string; space: string; zoneRevision: string }>(person.main('POST', '/v1/spaces', {
    profile: 'space-zone-v1', name: 'Independent attachment control', language: 'en',
    capabilities: ['zone'], visibility: 'public', listing: 'listed', actingSubject: person.actingSubject,
  }), 201);
}
async function anonymousEntry(fixture: PersonaSessions, state: string) {
  const path = `/v1/realms/${fixture.realm.slice(-36)}/zone`;
  const response = await fixture.visitor.main('GET', path), body = await response.text();
  appendFileSync(evidence, `${JSON.stringify({ state, caller: null,
    request: { method: 'GET', path }, response: { status: response.status, body } })}\n`);
  const missing = await fixture.visitor.main('GET', `/v1/realms/${absent}/zone`);
  expect(response.status, `${state}: ${body}`).toBe(404);
  expect(response.status).toBe(missing.status);
  expect(body).toBe(await missing.text());
}

test('anonymous Realm entry after attachment under both authorities consumes only the public selection', async () => {
  const fixture = publicAttachment;
  // The public persona fixture attaches an independently owned Zone through
  // its owner, who also holds Realm stewardship. It saves without publication.
  expect((await configuration(fixture.owner, fixture.zone)).configuration.defaultRealm).toBe(fixture.realm);
  await anonymousEntry(fixture, 'attached under both authorities');
}, 60_000);

test('anonymous Realm entry after delegated stewardship preserves independent Zone authority', async () => {
  const fixture = publicAttachment;
  const original = await configuration(fixture.owner, fixture.zone);
  await attach(fixture.owner, fixture.zone, original.revision, null);
  const target = await createZone(fixture.moderator);
  expect(target.space).not.toBe(fixture.space);
  const denied = await attach(fixture.moderator, target.zone, target.zoneRevision, fixture.realm, 400);
  expect(denied.code).toBe('invalid_zone_configuration');
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Delegated Realm steward', permissions: ['realm.settings.manage'] },
    { kind: 'assignment', roleId, member: fixture.moderator.actingSubject, assigned: true,
      validUntil: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    const root = `/v1/realms/${fixture.realm.slice(-36)}`;
    const basis = await answer<{ generation: string }>(fixture.owner.main('GET', `${root}/roles?${acting(fixture.owner)}`));
    const command = { actingSubject: fixture.owner.actingSubject, expectedGeneration: basis.generation,
      reason: 'Delegate the exact Realm attachment authority', change };
    const impact = await answer<{ digest: string }>(fixture.owner.main('POST', `${root}/role-impact`, command));
    await answer(fixture.owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: impact.digest }), 201);
  }
  await attach(fixture.moderator, target.zone, target.zoneRevision, fixture.realm);
  expect((await configuration(fixture.moderator, target.zone)).configuration.defaultRealm).toBe(fixture.realm);
  await anonymousEntry(fixture, 'attached by a delegated steward');
}, 60_000);

test('anonymous Realm entry after a Zone mandate refuses attachment without Realm stewardship', async () => {
  const fixture = publicAttachment;
  const target = await createZone(fixture.owner);
  const operator = fixture.operator;
  const grants = await answer<{ authorityEpoch: string; items: {
    permission: string; recipient: { principalId?: string };
  }[] }>(operator.main('GET', `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(operator.actingSubject!)}`));
  const principalId = grants.items.find(grant => grant.permission === 'platform:grant')?.recipient.principalId;
  expect(principalId).toBeDefined();
  const mandate = await answer<{ grant: { active: boolean; permission: string; scopeId: string } }>(
    operator.main('POST', '/v1/access/grant-changes', {
      profile: 'platform-grant-change-v1', issuerSubject: operator.actingSubject,
      expectedAuthorityEpoch: grants.authorityEpoch, grantId: randomUUID(), action: 'create',
      permission: 'platform:resource:zone.edit', scopeId: `zone:edit:${target.zone}`, recipient: { principalId },
      validUntil: new Date(Date.now() + 1_800_000).toISOString(),
    }));
  expect(mandate.grant).toMatchObject({ active: true, permission: 'platform:resource:zone.edit',
    scopeId: `zone:edit:${target.zone}` });
  const before = await configuration(operator, target.zone);
  const refused = await attach(operator, target.zone, before.revision, fixture.realm, 400);
  expect(refused.code).toBe('invalid_zone_configuration');
  expect(await configuration(operator, target.zone)).toEqual(before);
  await anonymousEntry(fixture, 'refused for a Zone mandate without stewardship');
}, 60_000);
afterAll(async () => { await sessions?.close(); });

for (const name of personaNames) test(`${name}: Realm Zone frame read preserves selected publication and persona authority`, async () => {
  const person = sessions[name];
  const acting = person.actingSubject ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
  const root = `/v1/realms/${sessions.realm.slice(-36)}`;
  const missing = await person.main('GET', `/v1/realms/${absent}/zone${acting}`);
  const missingBody = await missing.text();
  expect(missing.status, missingBody).toBe(404);
  const zone = await person.main('GET', `${root}/zone${acting}`);
  const zoneBody = await zone.text();
  expect(zone.status, `${name}: ${zoneBody}`).toBe(missing.status);
  expect(zoneBody).toBe(missingBody);
  const header = await person.main('GET', `${root}${acting}`);
  expect(header.status, await header.text()).toBe(['owner', 'member', 'moderator'].includes(name) ? 200 : 404);
  const administrationActing = `?actingSubject=${encodeURIComponent(person.actingSubject ?? sessions.owner.actingSubject!)}`;
  const roles = await person.main('GET', `${root}/roles${administrationActing}`);
  expect(roles.status, await roles.text()).toBe(name === 'owner' ? 200 : name === 'visitor' ? 401 : 403);
  const editor = await person.main('GET', `/v1/zones/${sessions.zone.slice(-36)}/showcase-editor${administrationActing}`);
  expect(editor.status, await editor.text()).toBe(name === 'owner' ? 200 : name === 'visitor' ? 401 : 404);
}, 60_000);

test('completed Realm closure keeps all six Zone frame reads equal to actual absence', async () => {
  await closeRealm(sessions);
  for (const name of personaNames) {
    const person = sessions[name];
    const acting = person.actingSubject ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
    for (const suffix of ['', '/zone']) {
      const missing = await person.main('GET', `/v1/realms/${absent}${suffix}${acting}`);
      const closed = await person.main('GET', `/v1/realms/${sessions.realm.slice(-36)}${suffix}${acting}`);
      expect(missing.status).toBe(404);
      expect(closed.status).toBe(missing.status);
      expect(await closed.text()).toBe(await missing.text());
    }
  }
}, 180_000);
