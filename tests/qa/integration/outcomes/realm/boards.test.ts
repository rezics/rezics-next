import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import boards from '../../../../../scripts/qa/cases/outcomes/realm/boards.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
beforeAll(async () => {
  sessions = await personaSessions('public');
}, 180_000);
afterAll(async () => {
  await sessions?.close();
});

async function boardContract(name: PersonaName) {
  const person = sessions[name];
  const params = new URLSearchParams();
  if (person.actingSubject) params.set('actingSubject', person.actingSubject);
  const response = await person.main('GET', `/v1/realms/${sessions.realm.slice(-36)}?${params}`);
  expect(response.status, await response.clone().text()).toBe(200);
  // No board operation has been selected. A Realm header is only a reachability
  // control: it cannot establish a board resource, collection or authority.
  throw new Error(
    'Board proof cannot be set up through the public API: board identity, collection, continuation and authority remain undecided',
  );
}

outcomeTest(boards, 'visitor', () => boardContract('visitor'));
outcomeTest(boards, 'stranger', () => boardContract('stranger'));
outcomeTest(boards, 'member', () => boardContract('member'));
outcomeTest(boards, 'owner', () => boardContract('owner'));
outcomeTest(boards, 'moderator', () => boardContract('moderator'));
outcomeTest(boards, 'operator', () => boardContract('operator'));
