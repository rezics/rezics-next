import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  commitVerified,
  CorruptBytes,
  pace,
  pacedFetch,
  readVerified,
  RetriesExhausted,
  sha256,
  writeVerified,
} from '../../../scripts/lib/paced-fetch.ts';

const root = resolve(import.meta.dir, '../../..');
const temporary = () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  return mkdtempSync(join(root, '.temp', 'paced-fetch-'));
};
function clock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    pace: pace(
      async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
      () => time,
    ),
  };
}
const limit = {
  intervalMs: 100,
  maxAttempts: 3,
  timeoutMs: 1_000,
  retryAfterCapMs: 120_000,
  serverErrorFrom: 500,
};

test('verified bytes are reread, and corrupt bytes are refused until a verified write replaces them', () => {
  const directory = temporary();
  try {
    const body = Buffer.from('{"ok":true}');
    const digest = sha256(body);
    const path = join(directory, digest);
    expect(writeVerified(path, body)).toBe(digest);
    expect(readVerified(path, digest).equals(body)).toBe(true);
    writeFileSync(path, 'corrupt');
    expect(() => readVerified(path, digest)).toThrow(CorruptBytes);
    writeVerified(path, body, digest);
    expect(readVerified(path, digest).equals(body)).toBe(true);
    writeFileSync(path, 'corrupt');
    const staged = `${path}.download`;
    writeFileSync(staged, body);
    commitVerified(path, staged, digest);
    expect(readVerified(path, digest).equals(body)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a 429 waits for Retry-After or its cap and stops at the attempt bound', async () => {
  const paced = clock();
  let requests = 0;
  await expect(
    pacedFetch(paced.pace, 'https://example.test/a', 'example.test', limit, async () => {
      requests++;
      return new Response('', { status: 429, headers: { 'retry-after': '2' } });
    }),
  ).rejects.toBeInstanceOf(RetriesExhausted);
  expect(requests).toBe(3);
  expect(paced.sleeps).toEqual([2_000, 2_000]);
  const capped = clock();
  requests = 0;
  const text = await pacedFetch(
    capped.pace,
    'https://example.test/b',
    'example.test',
    { ...limit, maxAttempts: 2, retryAfterCapMs: 30_000 },
    async () => {
      requests++;
      return requests === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '999' } })
        : new Response('ok');
    },
  );
  expect(await text.text()).toBe('ok');
  expect(capped.sleeps).toEqual([30_000]);
  const dated = clock();
  requests = 0;
  await pacedFetch(
    dated.pace,
    'https://example.test/d',
    'example.test',
    { ...limit, maxAttempts: 2 },
    async () => {
      requests++;
      return requests === 1
        ? new Response('', {
            status: 429,
            headers: { 'retry-after': new Date(5_000).toUTCString() },
          })
        : new Response('ok');
    },
  );
  expect(dated.sleeps).toEqual([5_000]);
});

test('requests on one key are spaced from the start of the previous turn', async () => {
  const paced = clock();
  const fetchOk = async () => new Response('ok');
  await pacedFetch(
    paced.pace,
    'https://example.test/c',
    'musicbrainz.org',
    { ...limit, intervalMs: 1_100 },
    fetchOk,
  );
  await pacedFetch(
    paced.pace,
    'https://example.test/c',
    'musicbrainz.org',
    { ...limit, intervalMs: 1_100 },
    fetchOk,
  );
  expect(paced.sleeps).toEqual([1_100]);
});
