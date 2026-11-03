import { expect, test } from 'bun:test';
import { documentText } from '@rezics/document';
import { routeOf } from '../../src/route/route.ts';
import { participantFixture } from './support/growth-account-erasure-participant-fixture.ts';

test('registered Content participant phases, closure, pending Collection, retention and replay have independent three-scale bounds', async () => {
  const fixture = await participantFixture();
  try {
    const result = await fixture.measure();
    // Empty: nine operations; contributions: thirteen, including Collection,
    // the unchanged ten-minute delay and the registered retention expiry.
    expect(result.reports).toBe(3 * (9 + 13));
    expect(result.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(result.completed.length).toBeGreaterThanOrEqual(3 * 3 * 2 * 2);
    for (const item of fixture.selected) {
      if (!result.completed.includes(item.person.accountId) || item.mode === 'empty') continue;
      const response = await fixture.system.kernel.handle(new Request(
        `https://content.test/v1/posts/${item.published!.firstPost.id}`,
      ));
      expect(response.status).toBe(200);
      const value = await response.json() as { post: { authorId: string; body: Parameters<typeof documentText>[0] } };
      expect(value.post.authorId).toBe(item.person.accountId);
      expect(documentText(value.post.body)).toBe('Selected published body');
      const draft = await fixture.system.database.pool.query(
        'SELECT body,search_text FROM content.revision WHERE route=$1 AND post_id=$2',
        [routeOf(item.draft!.id), item.draft!.firstPost.id],
      );
      expect(draft.rows.length).toBeGreaterThan(0);
      expect(draft.rows.every((row) => row.body === null && row.search_text === null)).toBe(true);
    }
  } finally {
    await fixture.close();
  }
}, 1_800_000);
