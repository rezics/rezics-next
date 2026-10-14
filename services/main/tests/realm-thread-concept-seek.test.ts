import { expect, test } from 'bun:test';
import { realmRankSeek } from '../src/modules/rankings/realm-threads.ts';
import { replyBoards } from '../src/modules/realm-reply/boards.ts';
import { RealmReplyInvalid } from '../src/modules/realm-reply/content-store.ts';

const concepts = Array.from({ length: 9 }, (_, n) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
test('the maintained seek binds Concept before ordering and limit for every view and history population', () => {
  const seek = realmRankSeek as (...args: unknown[]) => string;
  for (const sort of ['new', 'best', 'top']) for (const privatePopulation of [false, true]) {
    const sql = seek(sort, true, privatePopulation, true);
    expect(sql).toContain('AND concept=$12');
    expect(sql.indexOf('AND concept=$12')).toBeLessThan(sql.indexOf('ORDER BY'));
    expect(sql).toContain('(rank_key,time_key,placement)>');
    expect(sql).not.toContain('OFFSET');
  }
});
test('eight distinct selected Concepts and one selected primary are admitted; a ninth is refused', () => {
  expect(replyBoards({ concepts: concepts.slice(0, 8), primaryConcept: concepts[7] })).toEqual({
    concepts: concepts.slice(0, 8), primaryConcept: concepts[7],
  });
  expect(() => replyBoards({ concepts, primaryConcept: concepts[0] })).toThrow(RealmReplyInvalid);
  expect(() => replyBoards({ concepts: concepts.slice(0, 8), primaryConcept: concepts[8] })).toThrow(RealmReplyInvalid);
});
