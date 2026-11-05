import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  ARTWORK_RESPONSE_BYTES,
  artworkResponseBudget,
  readSubjectArtwork,
} from '../src/features/catalogue/subject-artwork/read';
import type { DocumentImagePresentation } from '../src/threads/document-media';

const id = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const image: DocumentImagePresentation = {
  id,
  containerId: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
  digest: 'b'.repeat(64),
  width: 1200,
  height: 800,
  variants: [{ format: 'webp', width: 640, height: 427 }],
  placeholder: null,
  focalPoint: null,
  credit: null,
};
function transport(reply: unknown, status = 200) {
  const calls: Request[] = [];
  const budget = artworkResponseBudget();
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return Response.json(reply, { status });
    },
    { preconnect() {} },
  );
  const client = createKernelClient('https://kernel.test', { fetch: budget.decorate(fetcher) });
  return {
    calls,
    read: (selection = id) => readSubjectArtwork(client, selection, 'Bearer actual-reader', budget.reason),
  };
}

test('one exact media read retains authentic nullable metadata and strict native membership', async () => {
  const current = transport({ images: [image] });
  expect(await current.read()).toEqual({ kind: 'ready', image });
  expect(current.calls).toHaveLength(1);
  expect(new URL(current.calls[0]!.url).pathname).toBe('/v1/media/presentations');
  expect(current.calls[0]!.headers.get('authorization')).toBe('Bearer actual-reader');
  expect(current.calls[0]!.cache).toBe('no-store');
  expect(await current.calls[0]!.json()).toEqual({ ids: [id] });
  for (const payload of [
    { images: [] },
    { images: [image, image] },
    { images: [{ ...image, id: image.containerId }] },
    { images: [{ ...image, variants: [image.variants[0], image.variants[0]] }] },
  ])
    expect(await transport(payload).read()).toEqual({ kind: 'unavailable' });
  for (const status of [403, 404, 503])
    expect(await transport({ type: 'unavailable' }, status).read()).toEqual({ kind: 'unavailable' });
  expect(await current.read('https://private.test/original')).toEqual({ kind: 'unavailable' });
  expect(current.calls).toHaveLength(1);
});

test('the schema-derived UTF-8 budget admits maximum credit and rejects oversized streams without truncation', async () => {
  const credit = {
    rightsHolder: '\u0000'.repeat(1024),
    via: { name: '\u0000'.repeat(1024), url: `https://${'x'.repeat(1016)}` },
    license: 'L'.repeat(80),
    obligations: ['cc:Attribution', 'cc:ShareAlike', 'cc:Notice', 'cc:SourceCode'],
  };
  expect((await transport({ images: [{ ...image, credit }] }).read()).kind).toBe('ready');
  expect(
    await transport({
      images: [{ ...image, placeholder: { thumbhash: 'x'.repeat(ARTWORK_RESPONSE_BYTES), color: '#ffffff' } }],
    }).read(),
  ).toEqual({ kind: 'unavailable', reason: 'oversized' });
  const budget = artworkResponseBudget();
  const timed = Object.assign(
    async () => {
      throw new DOMException('Transport deadline', 'TimeoutError');
    },
    { preconnect() {} },
  );
  expect(
    await readSubjectArtwork(
      createKernelClient('https://kernel.test', { fetch: budget.decorate(timed) }),
      id,
      undefined,
      budget.reason,
    ),
  ).toEqual({ kind: 'unavailable', reason: 'timeout' });
});

test('64/512/4096 unrelated media and obsolete assertions add no Web reads, decoded bytes or retained summaries', async () => {
  const costs: unknown[] = [];
  for (const scale of [64, 512, 4096]) {
    const objects = new Map(
      Array.from({ length: scale }, (_, index) => [`unrelated-${index}`, { ...image, digest: 'c'.repeat(64) }]),
    );
    objects.set(id, image);
    const calls: string[][] = [];
    let responseBytes = 0;
    const client = createKernelClient('https://kernel.test', {
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const { ids } = (await new Request(input, init).json()) as { ids: string[] };
          calls.push(ids);
          const body = JSON.stringify({ images: ids.flatMap((key) => (objects.has(key) ? [objects.get(key)] : [])) });
          responseBytes += new TextEncoder().encode(body).length;
          return new Response(body, { headers: { 'content-type': 'application/json' } });
        },
        { preconnect() {} },
      ),
    });
    const result = await readSubjectArtwork(client, id);
    expect(result).toEqual({ kind: 'ready', image });
    expect(calls).toEqual([[id]]);
    costs.push({
      calls: calls.length,
      responseBytes,
      retained: result.kind === 'ready' ? 1 : 0,
      variants: image.variants.length,
      citations: 0,
    });
  }
  expect(costs[0]).toEqual(costs[1]);
  expect(costs[1]).toEqual(costs[2]);
});
