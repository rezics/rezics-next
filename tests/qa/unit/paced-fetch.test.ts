import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  commitVerified,
  CorruptBytes,
  PaceClock,
  pacedFetch,
  PacedRetriesExhausted,
  readVerified,
  retryAfterSeconds,
  retryAfterSecondsOrHttpDate,
  sha256,
  writeVerified,
  type PacedFetchPolicy,
} from '../../../scripts/lib/paced-fetch.ts';

const root = resolve(import.meta.dir, '../../..');
const temporary = () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  return mkdtempSync(join(root, '.temp', 'paced-fetch-'));
};
function virtualClock() {
  let time = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    time += ms;
  };
  return { sleeps, clock: new PaceClock(sleep, () => time), now: () => time };
}
const policy = (overrides: Partial<PacedFetchPolicy> = {}): PacedFetchPolicy => ({
  spacing: 'start',
  intervalMs: 100,
  maxAttempts: 3,
  retryAfterCapMs: 120_000,
  retryStatus: (status) => status === 429 || status >= 500,
  fallbackWaitMs: (attempt) => 1_000 * 2 ** attempt,
  retryAfterMs: retryAfterSecondsOrHttpDate,
  onTransport: (cause) => new Error(`transport failed: ${String(cause)}`),
  ...overrides,
});

test('verified bytes are reused, corrupt bytes are refused, and a commit can replace them', () => {
  const directory = temporary();
  try {
    const body = Buffer.from('{"complete":true}');
    const digest = sha256(body);
    const path = join(directory, digest);
    writeVerified(path, body, digest);
    expect(readVerified(path, digest).equals(body)).toBe(true);
    writeVerified(path, body, digest);
    expect(readFileSync(path).equals(body)).toBe(true);
    writeFileSync(path, 'corrupt');
    expect(() => readVerified(path, digest)).toThrow(CorruptBytes);
    expect(() => writeVerified(path, body, digest)).toThrow(CorruptBytes);
    const staged = `${path}.download`;
    writeFileSync(staged, body);
    commitVerified(path, staged, digest);
    expect(readVerified(path, digest).equals(body)).toBe(true);
    expect(readFileSync(path).equals(body)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a 429 waits for Retry-After, clamps the cap, and stops at the attempt bound', async () => {
  const paced = virtualClock();
  let requests = 0;
  const fetcher = async () => {
    requests++;
    return new Response('', { status: 429, headers: { 'retry-after': '2' } });
  };
  await expect(
    pacedFetch(
      paced.clock,
      policy(),
      { url: 'https://example.test/item', paceKey: 'example.test', timeoutMs: 1_000 },
      fetcher,
      async () => 'accepted',
    ),
  ).rejects.toBeInstanceOf(PacedRetriesExhausted);
  expect(requests).toBe(3);
  expect(paced.sleeps).toEqual([2_000, 2_000]);

  const capped = virtualClock();
  requests = 0;
  const value = await pacedFetch(
    capped.clock,
    policy({ retryAfterCapMs: 30_000, maxAttempts: 2 }),
    { url: 'https://example.test/capped', paceKey: 'example.test', timeoutMs: 1_000 },
    async () => {
      requests++;
      return requests === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '999' } })
        : new Response('ok');
    },
    async (response) => response.text(),
  );
  expect(value).toBe('ok');
  expect(capped.sleeps).toEqual([30_000]);

  const dated = virtualClock();
  const header = new Date(5_000).toUTCString();
  expect(retryAfterSecondsOrHttpDate(header, 0)).toBe(5_000);
  requests = 0;
  await pacedFetch(
    dated.clock,
    policy({ maxAttempts: 2 }),
    { url: 'https://example.test/dated', paceKey: 'example.test', timeoutMs: 1_000 },
    async () => {
      requests++;
      return requests === 1
        ? new Response('', { status: 429, headers: { 'retry-after': header } })
        : new Response('ok');
    },
    async (response) => response.text(),
  );
  expect(dated.sleeps).toEqual([5_000]);
  expect(retryAfterSeconds(null)).toBe(0);
});

test('start spacing separates requests and transport failures stay inside the attempt bound', async () => {
  const paced = virtualClock();
  const fetcher = async () => new Response('ok');
  const request = {
    url: 'https://example.test/pace',
    paceKey: 'musicbrainz.org',
    timeoutMs: 1_000,
  };
  await pacedFetch(paced.clock, policy({ intervalMs: 1_100 }), request, fetcher, async (response) =>
    response.text(),
  );
  await pacedFetch(paced.clock, policy({ intervalMs: 1_100 }), request, fetcher, async (response) =>
    response.text(),
  );
  expect(paced.sleeps).toEqual([1_100]);

  const transport = virtualClock();
  let requests = 0;
  await expect(
    pacedFetch(
      transport.clock,
      policy({
        maxAttempts: 3,
        onTransport: (_cause, _attempt, remaining) =>
          remaining ? undefined : new Error('gave up'),
      }),
      request,
      async () => {
        requests++;
        throw new Error('offline');
      },
      async () => 'accepted',
    ),
  ).rejects.toThrow('gave up');
  expect(requests).toBe(3);
  expect(transport.sleeps).toEqual([1_000, 2_000]);
});

test('end spacing waits after completion and a refused read can retry inside the bound', async () => {
  const paced = virtualClock();
  const request = { url: 'https://example.test/end', paceKey: 'wikidata', timeoutMs: 1_000 };
  const end = policy({ spacing: 'end', intervalMs: 1_000 });
  await pacedFetch(
    paced.clock,
    end,
    request,
    async () => new Response('one'),
    async (response) => response.text(),
  );
  await pacedFetch(
    paced.clock,
    end,
    request,
    async () => new Response('two'),
    async (response) => response.text(),
  );
  expect(paced.sleeps).toEqual([1_000]);

  const reads = virtualClock();
  let attempts = 0;
  const value = await pacedFetch(
    reads.clock,
    policy({
      retryRead: (cause, _attempt, remaining) =>
        remaining && cause instanceof Error && cause.message === 'again',
    }),
    request,
    async () => new Response('body'),
    async () => {
      attempts++;
      if (attempts === 1) throw new Error('again');
      return 'kept';
    },
  );
  expect(value).toBe('kept');
  expect(attempts).toBe(2);
  expect(reads.sleeps).toEqual([1_000]);
});
