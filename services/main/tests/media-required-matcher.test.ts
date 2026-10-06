import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import {
  LocalRequiredSafetyMatcher,
  UnavailableRequiredSafetyMatcher,
} from '../src/modules/media-screen/required-matcher.ts';
import { RequiredMediaMatchWorker } from '../src/modules/media-screen/required-match-worker.ts';
import type {
  RequiredMediaMatchStore,
  RequiredMatchLease,
} from '../src/modules/media-screen/required-match-store.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';

const bytes = new Uint8Array([1, 2, 3]);
const digest = createHash('sha256').update(bytes).digest('hex');

test('local required matching reads the current exact corpus; missing, corrupt and aborted providers never clear media', async () => {
  const directory = `.temp/media-matcher-unit-${randomUUID()}`;
  mkdirSync(directory, { recursive: true });
  const path = `${directory}/corpus.json`;
  const matcher = new LocalRequiredSafetyMatcher(path);
  const signal = new AbortController().signal;
  try {
    await expect(matcher.match(bytes, 'image/png', signal)).rejects.toThrow();
    await Bun.write(path, '[]');
    expect(await matcher.match(bytes, 'image/png', signal)).toBe('clear');
    await Bun.write(path, JSON.stringify([digest]));
    expect(await matcher.match(bytes, 'image/png', signal)).toBe('blocked');
    await Bun.write(path, '["invalid"]');
    await expect(matcher.match(bytes, 'image/png', signal)).rejects.toThrow('corpus is invalid');
    await Bun.write(path, '[]');
    await expect(matcher.match(bytes, 'image/png', AbortSignal.abort())).rejects.toThrow();
    await expect(matcher.match(new Uint8Array(), 'image/png', signal)).rejects.toThrow(
      'byte bound',
    );
    await expect(new UnavailableRequiredSafetyMatcher().match()).rejects.toThrow('not configured');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('required matcher worker fences integrity failures, deadlines and late provider answers without issuing clearance', async () => {
  const lease: RequiredMatchLease = {
    job: randomUUID(),
    asset: randomUUID(),
    source: randomUUID(),
    token: randomUUID(),
    epoch: '0',
    digest,
    namespace: 'media/asset/',
    mediaType: 'image/png',
  };
  let settled = 0;
  let matched = 0;
  const store = {
    leaseNext: async () => lease,
    settle: async () => {
      settled++;
      return true;
    },
  } as unknown as RequiredMediaMatchStore;
  const objects = (returned: Uint8Array) => () =>
    ({ get: async () => returned }) as unknown as ImmutableObjects;
  await new RequiredMediaMatchWorker(
    store,
    {
      match: async () => {
        matched++;
        return 'clear';
      },
    },
    objects(new Uint8Array([9])),
    10,
  ).tick();
  expect(matched).toBe(0);
  expect(settled).toBe(0);
  let answer: ((value: 'clear') => void) | undefined;
  let providerSignal: AbortSignal | undefined;
  await new RequiredMediaMatchWorker(
    store,
    {
      match: (_bytes, _mediaType, signal) => {
        providerSignal = signal;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    },
    objects(bytes),
    10,
  ).tick();
  expect(providerSignal?.aborted).toBe(true);
  answer!('clear');
  await Bun.sleep(1);
  expect(settled).toBe(0);
  await new RequiredMediaMatchWorker(
    store,
    { match: async () => 'clear' },
    objects(bytes),
    10,
  ).tick();
  expect(settled).toBe(1);
});
