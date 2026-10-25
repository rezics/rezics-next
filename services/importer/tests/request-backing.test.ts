import { expect, test } from 'bun:test';
import { createImportFetch, MAX_IMPORT_BODY_BYTES } from '../src/import-fetch.ts';

const url = 'https://api.example.test/v1/subjects:batchWrite';
function client() {
  const observed = { tokens: 0, fetches: 0 };
  const fetch = createImportFetch({
    origin: 'https://api.example.test',
    token: async () => {
      observed.tokens++;
      return 'ordinary-token';
    },
    fetch: (async () => {
      observed.fetches++;
      return Response.json({ ok: true });
    }) as typeof fetch,
  });
  return { fetch, observed };
}

test('request init rejects a tiny view of excessive backing before credentials or fetch', async () => {
  const { fetch, observed } = client();
  const body = new Uint8Array(new ArrayBuffer(MAX_IMPORT_BODY_BYTES + 1), 0, 1);
  await expect(fetch(url, { method: 'POST', body })).rejects.toBeInstanceOf(RangeError);
  expect(observed).toEqual({ tokens: 0, fetches: 0 });
});

test('both request-stream entrypoints cancel excessive backing after one pull before credentials or fetch', async () => {
  for (const suppliedRequest of [false, true]) {
    const { fetch, observed } = client();
    let pulls = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          if (pulls > 1) throw new Error('must not pull the tail');
          controller.enqueue(new Uint8Array(new ArrayBuffer(MAX_IMPORT_BODY_BYTES + 1), 0, 1));
        },
        cancel() {
          cancellations++;
        },
      },
      { highWaterMark: 0 },
    );
    const result = suppliedRequest
      ? fetch(new Request(url, { method: 'POST', body }))
      : fetch(url, { method: 'POST', body });
    await expect(result).rejects.toBeInstanceOf(RangeError);
    expect(pulls).toBe(1);
    expect(cancellations).toBe(1);
    expect(body.locked).toBe(false);
    expect(observed).toEqual({ tokens: 0, fetches: 0 });
  }
});

test('exact hard backing with bounded visible content remains accepted', async () => {
  for (const streamed of [false, true]) {
    const { fetch, observed } = client();
    const body = new Uint8Array(new ArrayBuffer(MAX_IMPORT_BODY_BYTES), 0, 2);
    body.set([123, 125]);
    const source = streamed
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        })
      : body;
    expect((await fetch(url, { method: 'POST', body: source })).status).toBe(200);
    expect(observed).toEqual({ tokens: 1, fetches: 1 });
  }
});
