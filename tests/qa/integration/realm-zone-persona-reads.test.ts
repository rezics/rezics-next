import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { personaNames, personaSessions, type PersonaSessions } from '../support/personas.ts';
import { closeRealm } from './outcomes/realm/closure-fixture.ts';

let sessions: PersonaSessions;
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
}, 180_000);
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
