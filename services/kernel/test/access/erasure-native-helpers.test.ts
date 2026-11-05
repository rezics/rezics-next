import { expect, test } from 'bun:test';
import { nativeErasurePageValid, verificationErasureReady } from '../../src/access/erasure-native-stores.ts';
import type { ErasureDiscoveryPage } from '../../src/access/erasure-progress.ts';

const page = (keys: string[][], partition = 0): ErasureDiscoveryPage => ({ page: 7, partition, keys, done: false });

test('a durable raw-page replay cannot cross a partition or increase its admitted work', () => {
  const keys = Array.from({ length: 100 }, (_, i) => ['15', String(i)]);
  expect(nativeErasurePageValid(page(keys), 2, 7)).toBe(true);
  expect(nativeErasurePageValid(page([...keys, ['15', '101']]), 2, 7)).toBe(false);
  expect(nativeErasurePageValid(page([['16', 'key']]), 2, 7)).toBe(false);
  expect(nativeErasurePageValid(page([['65536', 'key']], 4095), 2, 7)).toBe(false);
  expect(nativeErasurePageValid(page([['65535', 'key']], 4095), 2, 7)).toBe(true);
  expect(nativeErasurePageValid(page([['', 'key']]), 2, 7)).toBe(false);
  expect(nativeErasurePageValid(page([['NaN', 'key']]), 2, 7)).toBe(false);
  expect(nativeErasurePageValid(page([['15', 'key']]), 3, 7)).toBe(false);
  expect(nativeErasurePageValid(page(keys), 2, 8)).toBe(false);
});

test('byte admission accounts for UTF-8 locators and the entire raw page', () => {
  expect(nativeErasurePageValid(page([['0', 'a'.repeat(1016)]]), 2, 7)).toBe(true);
  expect(nativeErasurePageValid(page([['0', 'a'.repeat(1017)]]), 2, 7)).toBe(false);
  expect(nativeErasurePageValid(page([['0', '漢'.repeat(400)]]), 2, 7)).toBe(false);
  expect(nativeErasurePageValid(page(Array.from({ length: 100 }, () => ['0', 'a'.repeat(700)])), 2, 7)).toBe(false);
});

test('verification decisions require actual terminal state rather than age or an unknown state', () => {
  for (const state of ['approved', 'rejected', 'withdrawn', 'failed'])
    expect(verificationErasureReady(state)).toBe(true);
  for (const state of ['pending', 'approving', 'expired', 'cancelled', ''])
    expect(verificationErasureReady(state)).toBe(false);
});
