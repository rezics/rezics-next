import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pagination from '../../../../../scripts/qa/cases/outcomes/recipes/catalogue-pagination-in-its-zone.ts';
import { recipeCatalogue, short } from '../../../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(120_000);
let sessions: PersonaSessions;
let inventory: Awaited<ReturnType<typeof recipeCatalogue>>;
const phrase = `Recipepages${randomUUID().replaceAll('-', '')}`;
type Page = { items: Array<{ id: string }>; nextCursor: string | null;
  matches: { value: number; kind: string }; window: { complete: boolean } };
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
beforeAll(async () => {
  sessions = await personaSessions('public');
  inventory = await recipeCatalogue(sessions, phrase);
}, 300_000);
afterAll(async () => { await sessions?.close(); });

async function traverse(name: PersonaName) {
  const person = sessions[name], path = `/v1/realms/${short(sessions.realm)}/modules/browse`;
  for (const sort of ['newest', 'updated', 'relevance']) {
    const query = new URLSearchParams({ q: phrase, sort, limit: '20', language: 'en', type: 'https://schema.org/Recipe' });
    const first = await answer<Page>(person.main('GET', `${path}?${query}`));
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeString();
    expect(first.matches.kind).toBe('lower-bound');
    expect(first.matches.value).toBeGreaterThanOrEqual(20);
    expect(first.window.complete).toBe(false);
    query.set('cursor', first.nextCursor!);
    const second = await answer<Page>(person.main('GET', `${path}?${query}`));
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.matches).toEqual({ value: 21, kind: 'exact' });
    expect(second.window.complete).toBe(true);
    const ids = [...first.items, ...second.items].map(item => item.id);
    expect(ids.sort()).toEqual([...inventory.matching].sort());
    expect(new Set(ids).size).toBe(21);
    expect(ids.some(id => inventory.excluded.includes(id))).toBe(false);
    const replay = await answer<Page>(person.main('GET', `${path}?${query}`));
    expect(replay.items.map(item => item.id)).toEqual(second.items.map(item => item.id));
    for (const [field, value] of [['q', `${phrase}Missing`], ['language', 'it'], ['type', 'https://schema.org/Book'], ['sort', sort === 'newest' ? 'updated' : 'newest']]) {
      const changed = new URLSearchParams(query);
      changed.set(field!, value!);
      await answer(person.main('GET', `${path}?${changed}`), 400);
    }
  }
}
outcomeTest(pagination, 'visitor', () => traverse('visitor'));
outcomeTest(pagination, 'stranger', () => traverse('stranger'));
outcomeTest(pagination, 'member', () => traverse('member'));
outcomeTest(pagination, 'owner', () => traverse('owner'));
outcomeTest(pagination, 'moderator', () => traverse('moderator'));
outcomeTest(pagination, 'operator', () => traverse('operator'));
