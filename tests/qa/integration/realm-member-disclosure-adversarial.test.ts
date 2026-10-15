import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { personaNames, personaSessions, type PersonaSessions } from '../support/personas.ts';
import { closureCommand } from './outcomes/realm/closure-fixture.ts';

setDefaultTimeout(180_000);
let sessions: PersonaSessions;
let hiddenName: string;
let banned: string;
let retainedCursor: string;
let survivor: string;
const root = () => `/v1/realms/${sessions.realm.slice(-36)}`;
type Roster = { items: { agent: string; displayName: string | null }[]; nextCursor: string | null };

beforeAll(async () => {
  sessions = await personaSessions('public');
  for (const person of [sessions.member, sessions.moderator]) {
    await closureCommand(person, 'PUT', `${root()}/roster/listing`, {
      actingSubject: person.actingSubject, expectedMembershipGeneration: '1', listed: true,
    });
  }
  const before = await closureCommand<Roster>(sessions.visitor, 'GET', `${root()}/roster?limit=1`);
  expect(before.items).toHaveLength(1);
  expect(before.nextCursor).toBe(before.items[0]!.agent);
  retainedCursor = before.nextCursor!;
  // Keep a private name beside a public one. Listing consent permits the Agent
  // identity; it does not publish the Person's currently private name.
  const member = sessions.member;
  const preferences = await closureCommand<{ version: number }>(member, 'GET',
    `/v1/me/person-preferences?actingSubject=${encodeURIComponent(member.actingSubject!)}`);
  const roster = await closureCommand<Roster>(sessions.visitor, 'GET', `${root()}/roster`);
  hiddenName = roster.items.find(item => item.agent === member.actingSubject)!.displayName!;
  expect(hiddenName).toBeString();
  await closureCommand(member, 'PUT', '/v1/me/person-preferences', {
    actingSubject: member.actingSubject, expectedVersion: preferences.version,
    profileVisibility: 'private', followPolicy: 'everyone', hideReadingActivity: false,
    contentLanguages: [], spoilerPolicy: 'hide-unread',
  });
  // Remove the first seek key while a second listed member remains. A cursor
  // is response data too; a sparse page cannot return the hidden member's ID.
  banned = before.items[0]!.agent;
  survivor = [member.actingSubject!, sessions.moderator.actingSubject!].find(agent => agent !== banned)!;
  const actor = sessions.owner.actingSubject!;
  const basis = await closureCommand<{ generation: string }>(sessions.owner, 'GET',
    `${root()}/members?actingSubject=${encodeURIComponent(actor)}`);
  await closureCommand(sessions.owner, 'POST', `${root()}/members`, {
    actingSubject: actor, expectedGeneration: basis.generation, member: banned,
    expectedMembershipGeneration: '1', action: 'ban', durationSeconds: null,
    consent: null, reason: 'Exercise restricted membership disclosure',
  }, 201);
});
afterAll(async () => { await sessions?.close(); });

for (const name of personaNames) {
  test(`${name}: a restricted member cannot survive in roster items or continuation metadata`, async () => {
    const person = sessions[name];
    for (const query of ['', '?limit=1', `?limit=1&after=${encodeURIComponent(retainedCursor)}`, '?featured=true']) {
      const response = await person.main('GET', root() + '/roster' + query, undefined, undefined,
        { headers: { 'if-none-match': '*' } });
      const bytes = await response.text();
      expect(response.status, bytes).toBe(200);
      expect(bytes).not.toContain(banned);
      const page = JSON.parse(bytes) as Roster;
      if (!query.includes('featured')) expect(page.items.map(item => item.agent)).toEqual([survivor]);
      expect(page.nextCursor).toBeNull();
      // The public roster never adopts controller authority from a bearer.
      expect(page.items.find(item => item.agent === sessions.member.actingSubject)?.displayName ?? null).toBeNull();
    }
  });

  test(`${name}: private member profile and its name cannot be recovered through direct IDs or validators`, async () => {
    const person = sessions[name];
    const actor = person.actingSubject ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
    const path = `/v1/agents/${sessions.member.actingSubject!.slice(-36)}${actor}`;
    const response = await person.main('GET', path, undefined, undefined, { headers: { 'if-none-match': '*' } });
    const bytes = await response.text();
    expect(response.status, bytes).toBe(name === 'member' ? 200 : 404);
    if (name === 'member') expect(bytes).toContain(hiddenName);
    else expect(bytes).not.toContain(hiddenName);
  });
}
