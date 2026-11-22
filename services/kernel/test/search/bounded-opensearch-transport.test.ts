import { expect, spyOn, test } from 'bun:test';
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

test('a small fragmented reply retains capacity proportional to the bytes received', async () => {
  const data = JSON.stringify({ text: '書'.repeat(1024) });
  const encoded = new TextEncoder().encode(data);
  const sizes = [13, 29, 61, 127];
  let at = 0;
  let piece = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at === encoded.length) return controller.close();
        const end = Math.min(encoded.length, at + sizes[piece++ % sizes.length]!);
        controller.enqueue(encoded.subarray(at, end));
        at = end;
      },
    }),
  );
  const reply = spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
  const set = Uint8Array.prototype.set;
  const capacities: number[] = [];
  const copies = spyOn(Uint8Array.prototype, 'set').mockImplementation(function (this: Uint8Array, source, offset) {
    if (source instanceof Uint8Array && source.buffer === encoded.buffer) capacities.push(this.byteLength);
    set.call(this, source, offset);
  });
  try {
    const client = createOpenSearch('http://search.invalid');
    expect((await client.request('GET', '/fragmented')).body).toEqual(JSON.parse(data));
    expect(capacities.length).toBeGreaterThan(1);
    expect(Math.max(...capacities)).toBeLessThanOrEqual(2 * encoded.byteLength);
  } finally {
    copies.mockRestore();
    reply.mockRestore();
  }
});
