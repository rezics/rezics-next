import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalImageClassifier, classifyInProcess } from '../src/modules/media-screen/classifier.ts';
import { SCREEN_POLICY, screenUnavailable, screenVerdict, type Scores } from '../src/modules/media-screen/policy.ts';
import { avatarImageEligible, avatarSelectionEligible } from '../src/modules/media/store.ts';

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
    expect(avatarSelectionEligible({ ...row, clearance })).toBe(clearance === 'screening');
  }
  expect(avatarImageEligible({ ...row, clearance: 'cleared' })).toBe(true);
  expect(avatarSelectionEligible({ ...row, clearance: 'cleared' })).toBe(true);
  expect(avatarSelectionEligible({ ...row, clearance: 'screening', moderation: 'suppressed' })).toBe(false);
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

test('G571: fatal child exit and an unresponsive decoder leave Main alive and no orphan process; abort also kills the child', async () => {
  const root = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'g571-process-'));
  try {
    for (const mode of ['fatal', 'deadline', 'abort'] as const) {
      const pidFile = join(directory, `${mode}.pid`);
      const script = join(directory, `${mode}.ts`);
      writeFileSync(script, `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
        ${mode === 'fatal' ? "process.kill(process.pid, 'SIGKILL');" : 'while (true) {}'}
      `);
      const controller = new AbortController();
      const result = classifyInProcess(new Uint8Array([1]), 'image/png', 2000, controller.signal, pathToFileURL(script))
        .then(() => null, (error: Error) => error);
      // Observe that the child actually started, so a startup timeout cannot satisfy the assertion.
      let pid = 0;
      for (let attempt = 0; attempt < 100 && !pid; attempt++) {
        try { pid = Number(readFileSync(pidFile, 'utf8')); } catch { await Bun.sleep(5); }
      }
      expect(pid).toBeGreaterThan(0);
      expect(pid).not.toBe(process.pid);
      if (mode === 'abort') controller.abort();
      expect((await result)?.message).toBe('local classifier unavailable');
      expect(() => process.kill(pid, 0)).toThrow();
    }
    // Main's JS process remains functional after each child signal/deadline.
    expect(screenVerdict(benign).clearance).toBe('cleared');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
