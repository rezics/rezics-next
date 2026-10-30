import { expect, test } from 'bun:test';
import { createOpenSearch, SearchUnavailableError } from '../../src/search/opensearch.ts';

test('an actual oversized JSON response is refused before it becomes a successful native reply', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ padding: 'x'.repeat(4 * 1024 * 1024) }),
  });
  try {
    const client = createOpenSearch(server.url.toString());
    await expect(client.request('GET', '/oversized')).rejects.toBeInstanceOf(SearchUnavailableError);
  } finally {
    server.stop(true);
  }
});
