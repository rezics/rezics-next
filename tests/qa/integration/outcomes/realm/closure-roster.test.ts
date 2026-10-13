import { outcomeTest } from '../../../support/outcome-test.ts';
import { closeRealm, closureCell } from './closure-fixture.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import declaration from '../../../../../scripts/qa/cases/outcomes/realm/closure-roster.ts';
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
outcomeTest(declaration, 'visitor', () => closureCell(declaration, 'visitor', () => closed, () => reads('visitor')));
outcomeTest(declaration, 'stranger', () => closureCell(declaration, 'stranger', () => closed, () => reads('stranger')));
outcomeTest(declaration, 'member', () => closureCell(declaration, 'member', () => closed, () => reads('member')));
outcomeTest(declaration, 'owner', () => closureCell(declaration, 'owner', () => closed, () => reads('owner')));
outcomeTest(declaration, 'moderator', () => closureCell(declaration, 'moderator', () => closed, () => reads('moderator')));
outcomeTest(declaration, 'operator', () => closureCell(declaration, 'operator', () => closed, () => reads('operator')));
