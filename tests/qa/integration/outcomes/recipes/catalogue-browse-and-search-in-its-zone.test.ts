import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import catalogue from '../../../../../scripts/qa/cases/outcomes/recipes/catalogue-browse-and-search-in-its-zone.ts';
import { recipeCatalogue, short } from '../../../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(120_000);
let sessions: PersonaSessions;
let inventory: Awaited<ReturnType<typeof recipeCatalogue>>;
const phrase = `Recipegarden${randomUUID().replaceAll('-', '')}`;
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

async function browse(name: PersonaName) {
  const person = sessions[name];
  const path = `/v1/realms/${short(sessions.realm)}/modules/browse`;
  const refused = await answer<{ code: string }>(person.main('GET', `${path}?sort=relevance&type=https%3A%2F%2Fschema.org%2FRecipe`), 400);
  expect(refused.code).toBe('unsupported_query_shape');
  for (const sort of ['newest', 'updated', 'relevance']) {
    for (const q of sort === 'relevance' ? [phrase] : ['', phrase]) {
      const query = new URLSearchParams({ sort, limit: '20', language: 'en', type: 'https://schema.org/Recipe', ...(q ? { q } : {}) });
      const seen: string[] = [];
      let page: Page;
      do {
        expect(seen.length).toBeLessThan(22);
        page = await answer<Page>(person.main('GET', `${path}?${query}`));
        expect(page.items.some(item => inventory.excluded.includes(item.id))).toBe(false);
        seen.push(...page.items.map(item => item.id));
        if (page.nextCursor) query.set('cursor', page.nextCursor);
      } while (page.nextCursor);
      expect(seen).toHaveLength(21);
      expect(new Set(seen).size).toBe(21);
      expect(seen.sort()).toEqual([...inventory.matching].sort());
      expect(page.matches).toEqual({ value: 21, kind: 'exact' });
      expect(page.window.complete).toBe(true);
    }
  }
  const none = await answer<Page>(person.main('GET', `${path}?q=${phrase}Missing&type=https%3A%2F%2Fschema.org%2FRecipe&language=en`));
  expect(none.items).toEqual([]);
  expect(none.nextCursor).toBeNull();
  expect(none.matches).toEqual({ value: 0, kind: 'exact' });
}
outcomeTest(catalogue, 'visitor', () => browse('visitor'));
outcomeTest(catalogue, 'stranger', () => browse('stranger'));
outcomeTest(catalogue, 'member', () => browse('member'));
outcomeTest(catalogue, 'owner', () => browse('owner'));
outcomeTest(catalogue, 'moderator', () => browse('moderator'));
outcomeTest(catalogue, 'operator', () => browse('operator'));
