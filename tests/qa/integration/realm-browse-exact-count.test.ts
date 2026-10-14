import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { recipeCatalogue, short } from '../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { personaSessions, type PersonaSessions } from '../support/personas.ts';

type Page = { items: { id: string }[]; nextCursor: string | null;
  matches: { value: number; kind: string }; window: { complete: boolean };
  sourcePosition: { dataEpoch: string; sequence: string } };
let sessions: PersonaSessions;
let inventory: Awaited<ReturnType<typeof recipeCatalogue>>;
const phrase = `Firstrecipecount${randomUUID().replaceAll('-', '')}`;
const evidence: unknown[] = [];
const save = () => Bun.write(`.temp/realm-browse-exact-count-${Bun.env.REZICS_QA_RUN_ID}.json`,
  JSON.stringify({ source: Bun.env.REZICS_QA_SOURCE_REVISION ?? null, inventory, evidence }, null, 2));

beforeAll(async () => {
  const started = Date.now();
  try {
    sessions = await personaSessions('public', { observeMain: async event => {
      if (event.request.method !== 'GET') evidence.push({ phase: 'preparation', ...event,
        caller: event.caller.accountId });
    } });
    // Command receipts define the inventory. No browse read, projection probe,
    // persona sequence or readiness loop precedes the first public request.
    inventory = await recipeCatalogue(sessions, phrase);
  } finally {
    evidence.push({ phase: 'preparation-end', elapsedMs: Date.now() - started });
    await save();
  }
  expect(Date.now() - started).toBeLessThan(600_000);
}, 300_000);
afterAll(async () => { try { await save(); } finally { await sessions?.close(); } });

test('the preparation boundary reports an incomplete cut or traverses the independent Recipe inventory exactly', async () => {
  const path = `/v1/realms/${short(sessions.realm)}/modules/browse`;
  const read = async (reader: string, query: URLSearchParams, initial = false): Promise<Page | null> => {
    const request = `GET ${path}?${query}`;
    const started = Date.now();
    // Direct anonymous HTTP preserves the first answer, including a 503.
    const response = await fetch(`http://127.0.0.1:${Bun.env.MAIN_PORT}${path}?${query}`,
      { signal: AbortSignal.timeout(30_000) });
    const raw = await response.text();
    evidence.push({ phase: 'read', reader, request, status: response.status, answer: raw,
      elapsedMs: Date.now() - started });
    await save();
    if (initial && response.status === 503) {
      // The owner cannot count an unadmitted projection. A refusal must carry
      // no catalogue result or cursor; it is never an exact empty inventory.
      const problem = JSON.parse(raw) as Record<string, unknown>;
      expect(problem.code).toBe('work_read_unavailable');
      for (const field of ['items', 'matches', 'window', 'nextCursor']) expect(problem).not.toHaveProperty(field);
      return null;
    }
    expect(response.status, raw).toBe(200);
    return JSON.parse(raw) as Page;
  };
  for (const reader of ['first', 'later']) {
    for (const sort of ['newest', 'updated', 'relevance']) {
      const query = new URLSearchParams({ q: phrase, sort, language: 'en',
        type: 'https://schema.org/Recipe', limit: '20' });
      const first = await read(reader, query, reader === 'first' && sort === 'newest');
      if (!first) return;
      if (!first.window.complete && first.nextCursor === null) {
        expect(first.matches).toEqual({ value: first.items.length, kind: 'lower-bound' });
        expect(first.items.every(item => inventory.matching.includes(item.id))).toBe(true);
        expect(first.sourcePosition.dataEpoch).toBeString();
        expect(first.sourcePosition.sequence).toMatch(/^\d+$/);
        return;
      }
      expect(first.items).toHaveLength(20);
      expect(first.matches).toEqual({ value: 20, kind: 'lower-bound' });
      expect(first.window.complete).toBe(false);
      expect(first.nextCursor).toBeString();
      query.set('cursor', first.nextCursor!);
      const last = await read(reader, query);
      if (!last) throw new Error('An admitted traversal lost its catalogue answer');
      if (!last.window.complete && last.nextCursor === null) {
        expect(last.matches).toEqual({ value: first.items.length + last.items.length, kind: 'lower-bound' });
        expect(last.items.every(item => inventory.matching.includes(item.id))).toBe(true);
        return;
      }
      expect(last.items).toHaveLength(1);
      const ids = [...first.items, ...last.items].map(item => item.id);
      expect(new Set(ids).size).toBe(21);
      expect(ids.sort()).toEqual([...inventory.matching].sort());
      expect(ids.some(id => inventory.excluded.includes(id))).toBe(false);
      expect(last.nextCursor).toBeNull();
      expect(last.matches).toEqual({ value: 21, kind: 'exact' });
      expect(last.window.complete).toBe(true);
    }
    const none = await read(reader, new URLSearchParams({ q: `${phrase}Missing`, language: 'en',
      type: 'https://schema.org/Recipe' }));
    if (!none) throw new Error('An admitted reader lost its empty-query answer');
    expect(none.items).toEqual([]);
    expect(none.matches).toEqual({ value: 0, kind: 'exact' });
    expect(none.window.complete).toBe(true);
  }
}, 120_000);
