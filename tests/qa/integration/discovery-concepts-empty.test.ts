import { expect, test } from 'bun:test';
import { startMediaStack } from './media-support.ts';

test('concept search is an empty complete page before any discovery generation exists', async () => {
  const stack = await startMediaStack('discovery-concepts-empty');
  try {
    const head = await stack.accessPool.query(
      `SELECT 1 FROM access.derived_generation_head WHERE family = 'discovery'`,
    );
    expect(head.rowCount ?? 0).toBe(0);
    const response = await stack.call('GET', '/v1/discovery/concepts');
    expect(response.status).toBe(200);
    const page = await response.json() as {
      profile: string;
      items: unknown[];
      nextCursor: string | null;
      complete: boolean;
      stale: boolean;
      count: { value: number; kind: string };
      sourcePosition: { dataEpoch: string; sequence: string };
    };
    expect(page).toMatchObject({
      profile: 'concept-search-v1',
      items: [],
      nextCursor: null,
      complete: true,
      stale: false,
      count: { value: 0, kind: 'exact' },
    });
    expect(typeof page.sourcePosition.dataEpoch).toBe('string');
    expect(page.sourcePosition.dataEpoch.length).toBeGreaterThan(0);
    expect(typeof page.sourcePosition.sequence).toBe('string');
    expect(page.sourcePosition.sequence.length).toBeGreaterThan(0);
  } finally {
    await stack.stop();
  }
});
