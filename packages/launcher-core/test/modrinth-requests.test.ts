import { expect, test } from 'bun:test';
import { setTimeout } from 'node:timers/promises';
import { ModrinthRequests, modrinthApi } from '../src/modrinth-requests.ts';

const metadata = new URL(`${modrinthApi}/search`);
const download = new URL('https://cdn.modrinth.com/data/project/mod.jar');

test('honors Retry-After without blocking another origin or obscuring cancellation', async () => {
  const origins: string[] = [];
  let cancelled = false;
  const fetcher = (async (input, init) => {
    const url = new URL(String(input));
    origins.push(url.origin);
    expect(new Headers(init?.headers).get('user-agent')).toContain('REZICS/launcher-fixture');
    expect(init?.credentials).toBe('omit');
    if (origins.length !== 1) return Response.json({ ok: true });
    return new Response(
      new ReadableStream({
        cancel: () => {
          cancelled = true;
        },
      }),
      {
        status: 429,
        headers: { 'retry-after': '1', 'x-ratelimit-reset': '60' },
      },
    );
  }) as typeof fetch;
  const requests = new ModrinthRequests(fetcher, 'fixture');

  await expect(requests.metadata(metadata)).rejects.toThrow('Retry in 1s');
  expect(cancelled).toBeTrue();
  await expect(requests.metadata(metadata)).rejects.toThrow('rate limiting');
  const stop = new AbortController();
  stop.abort(new Error('Caller cancelled the request.'));
  await expect(requests.metadata(metadata, stop.signal)).rejects.toThrow('Caller cancelled the request.');
  expect((await requests.fetch(download)).ok).toBeTrue();
  expect(origins).toEqual([metadata.origin, download.origin]);

  await setTimeout(1050);
  expect(await requests.metadata(metadata)).toEqual({ ok: true });
  expect(origins).toEqual([metadata.origin, download.origin, metadata.origin]);
});

test('prefers an HTTP date and falls back safely when a rate-limit header is invalid', async () => {
  const until = new Date(Date.now() + 60_000).toUTCString();
  const fetcher = (async (input) => {
    const url = new URL(String(input));
    const after = url.origin === metadata.origin ? 'invalid' : until;
    return new Response(null, { status: 429, headers: { 'retry-after': after } });
  }) as typeof fetch;
  const requests = new ModrinthRequests(fetcher, 'fixture');

  await expect(requests.fetch(download)).rejects.toThrow(/download service.*Retry in (?:59|60)s/);
  await expect(requests.metadata(metadata)).rejects.toThrow('Retry in 10s');
});

test('distinguishes service outages and missing catalogue entries without replaying the request', async () => {
  const statuses = [503, 404, 200];
  const fetcher = (async (_input, _init) => Response.json({ ok: true }, { status: statuses.shift() })) as typeof fetch;
  const requests = new ModrinthRequests(fetcher, 'fixture');

  await expect(requests.metadata(metadata)).rejects.toThrow('temporarily unavailable (HTTP 503)');
  expect(statuses).toEqual([404, 200]);
  await expect(requests.metadata(metadata)).rejects.toThrow('project, release or file is unavailable (HTTP 404)');
  expect(await requests.metadata(metadata)).toEqual({ ok: true });
});
