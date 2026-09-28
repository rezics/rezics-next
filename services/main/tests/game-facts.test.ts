import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { gameFacts, GAME_FACTS_COST } from '../src/modules/game-facts/contract.ts';
import { FACTS_COST, FactsTooLarge, RevisionedFactsStore } from '../src/modules/game-facts/store.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const sample = { profile: 'game-facts-v1', pitch: 'A game to explore.', source: 'https://example.org/game',
  observedAt: '2026-09-28T00:00:00.000Z', status: 'upcoming', releaseDate: null,
  platforms: ['Windows'], languages: ['English'], tags: ['Exploration'], screenshots: [],
  modsZone: false, review: null } as const;

test('a game release and review are qualified; unknown dates and reviews remain null', () => {
  expect(Value.Check(gameFacts, sample)).toBe(true);
  expect(Value.Check(gameFacts, { ...sample, status: 'released', review: { label: 'Very positive',
    count: 128, period: 'overall', source: sample.source, observedAt: sample.observedAt } })).toBe(true);
  expect(Value.Check(gameFacts, { ...sample, review: { label: 'Very positive', count: 128 } })).toBe(false);
  expect(Value.Check(gameFacts, { ...sample, platforms: Array(GAME_FACTS_COST.platformItems + 1).fill('Windows') })).toBe(false);
});

test('game facts read one indexed row and reject a record beyond the byte budget before SQL', async () => {
  const statements: string[] = [];
  const pool = { query: async (sql: string) => {
    statements.push(sql); return { rows: [{ work, revision: 1, facts: sample }] };
  } } as unknown as Pool;
  const store = new RevisionedFactsStore(pool, 'game');
  expect(await store.read(work)).toEqual({ work, revision: 1, facts: sample });
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain('WHERE work = $1');
  await expect(store.write('00000000-0000-4000-8000-000000000002', 'key', work, null,
    { ...sample, pitch: 'x'.repeat(FACTS_COST.maxBytes) }, work)).rejects.toBeInstanceOf(FactsTooLarge);
  expect(statements).toHaveLength(1);
});
