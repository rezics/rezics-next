import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { LocalImageClassifier } from '../src/modules/media-screen/classifier.ts';
import { SCREEN_POLICY, screenUnavailable, screenVerdict, type Scores } from '../src/modules/media-screen/policy.ts';
import { avatarImageEligible } from '../src/modules/media/store.ts';

const benign: Scores = { Drawing: 0.05, Hentai: 0.01, Neutral: 0.9, Porn: 0.01, Sexy: 0.03 };
test('G571: clearance requires the policy, complete finite scores, and inclusive explicit thresholds', () => {
  expect(screenVerdict(benign).clearance).toBe('cleared');
  expect(screenVerdict({ ...benign, Neutral: 0.41, Porn: 0.5 }).clearance).toBe('held');
  expect(screenVerdict({ Drawing: 0, Neutral: 0.02, Porn: 0.49, Hentai: 0.49, Sexy: 0 }).clearance).toBe('held');
  expect(screenUnavailable()).toMatchObject({ clearance: 'held', reason: 'screen-unavailable' });
  expect(() => screenVerdict({ ...benign, Neutral: NaN })).toThrow();
  expect(() => screenVerdict({ ...benign, Neutral: 0 })).toThrow();
  const row = { use: 'use', disclosure: 'public', moderation: 'none', lifecycle: 'active',
    availability: 'available', mediaType: 'image/png', width: 40, height: 40, byteLength: 100 };
  for (const clearance of ['screening', 'held', 'rejected', null] as const) {
    expect(avatarImageEligible({ ...row, clearance })).toBe(false);
  }
  expect(avatarImageEligible({ ...row, clearance: 'cleared' })).toBe(true);
});

test('G571: the bundled pinned model and prebuilt decoder classify on Bun CPU without remote weights', async () => {
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#6699cc' } }).png().toBuffer();
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('smoke must not fetch weights'); }) as unknown as typeof fetch;
  try {
    const scores = await new LocalImageClassifier().classify(bytes, 'image/png');
    expect(Object.keys(scores).sort()).toEqual(['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy']);
    expect(screenVerdict(scores).evidence.weightsDigest).toBe(SCREEN_POLICY.weightsDigest);
  } finally { globalThis.fetch = fetchBefore; }
}, 45_000);

test('G571: real decode and inference fail closed on malformed bytes, excess pixels and deadlines', async () => {
  const classifier = new LocalImageClassifier();
  await expect(classifier.classify(new Uint8Array([1, 2, 3]), 'image/png')).rejects.toThrow();
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).png().toBuffer();
  await expect(new LocalImageClassifier(1).classify(bytes, 'image/png')).rejects.toThrow();
  const apngControl = Buffer.alloc(20);
  apngControl.writeUInt32BE(8, 0);
  apngControl.write('acTL', 4);
  apngControl.writeUInt32BE(2, 8);
  const animated = Buffer.concat([bytes.subarray(0, 33), apngControl, bytes.subarray(33)]);
  await expect(classifier.classify(animated, 'image/png')).rejects.toThrow();
  const largeHeader = new Uint8Array(bytes);
  new DataView(largeHeader.buffer).setUint32(16, 16384);
  new DataView(largeHeader.buffer).setUint32(20, 16384);
  await expect(classifier.classify(largeHeader, 'image/png')).rejects.toThrow();
}, 45_000);
