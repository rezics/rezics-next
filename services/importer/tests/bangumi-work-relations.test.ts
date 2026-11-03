import { expect, test } from 'bun:test';
import { planCrossMediaSeed, type CrossMediaTables } from '../src/cross-media-seed.ts';

test('the production seed coalesces reciprocal subject relation rows into one canonical statement', async () => {
  const rows: CrossMediaTables = {
    async *rows(_provider, table) {
      if (table === 'subject') {
        yield { id: 1, type: 2, name: 'STEINS;GATE' };
        yield { id: 2, type: 2, name: 'STEINS;GATE 0' };
        yield { id: 3, type: 2, name: 'CLANNAD' };
        yield { id: 4, type: 2, name: 'Fate/stay night' };
      }
      if (table === 'vn_titles') {
        yield { id: 'v1', title: 'STEINS;GATE', official: 't', lang: 'en', latin: null };
        yield { id: 'v2', title: 'CLANNAD', official: 't', lang: 'en', latin: null };
        yield { id: 'v3', title: 'Fate/stay night', official: 't', lang: 'en', latin: null };
      }
      if (table === 'vn') {
        yield { id: 'v1', olang: 'en' };
        yield { id: 'v2', olang: 'en' };
        yield { id: 'v3', olang: 'en' };
      }
      if (table === 'entry_meta') {
        yield { id: 'v1', revision: '1' };
        yield { id: 'v2', revision: '1' };
        yield { id: 'v3', revision: '1' };
      }
      if (table === 'subject-relations') {
        yield { subject_id: 1, related_subject_id: 2, relation_type: 2 };
        yield { subject_id: 2, related_subject_id: 1, relation_type: 3 };
      }
    },
  };

  const plan = await planCrossMediaSeed(rows);
  const relations = plan.edges.filter((edge) => edge.table === 'subject-relations');
  expect(relations).toHaveLength(1);
  expect(relations[0]).toMatchObject({ holder: '1', target: '2', property: 'wdt:P155' });
});
