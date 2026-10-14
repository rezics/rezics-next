import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaSessions, type PersonaSessions } from '../support/personas.ts';
import { grantPersonaFixtureAuthority } from '../support/persona-fixture-authority.ts';

let sessions: PersonaSessions;
let concept: string;

async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}

beforeAll(async () => {
  sessions = await personaSessions('public');
  await grantPersonaFixtureAuthority(sessions.owner, [
    { scope: 'classification:define:global', action: 'classification.proposition.define' },
    { scope: `classification:context:${sessions.realm}`, action: 'classification.context.configure' },
  ]);
  await answer(sessions.owner.main('POST', '/v1/classification-contexts', {
    profile: 'classification-context-v1', realm: sessions.realm,
    actingSubject: sessions.owner.actingSubject,
  }), 201);
  ({ concept } = await answer<{ concept: string }>(sessions.owner.main('POST', '/v1/classification-vocabulary', {
    profile: 'classification-proposition-v2', scheme: null,
    labels: [{ language: 'en', value: `Empty placement Concept ${randomUUID()}` }],
    alternativeLabels: [], broader: [], narrower: [], actingSubject: sessions.owner.actingSubject,
  }), 201));
  await answer(sessions.visitor.main('GET', `/v1/concepts/${concept.slice(-36)}`));
}, 180_000);

afterAll(async () => { await sessions?.close(); });

for (const sort of ['new', 'best', 'top']) {
  test(`a live empty Concept group is traversable in Realm ${sort} order`, async () => {
    const root = `/v1/realms/${sessions.realm.slice(-36)}/threads`;
    const query = new URLSearchParams({ sort, window: 'all', limit: '1' });
    const control = await answer<{ items: unknown[] }>(sessions.visitor.main('GET', `${root}?${query}`));
    expect(control.items).toEqual([]);
    query.set('concept', concept);
    const page = await answer<{ items: unknown[]; nextCursor: string | null; count: { value: number } }>(
      sessions.visitor.main('GET', `${root}?${query}`));
    expect(page.items).toEqual([]);
    expect(page.count.value).toBe(0);
    expect(page.nextCursor).toBeNull();
  }, 120_000);
}
