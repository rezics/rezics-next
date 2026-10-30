import { expect, test } from 'bun:test';
import { readReceiptKeyRing, receiptKeysFor } from '../../src/command/receipt-key.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { readWorkerConfig, startWorker } from '../../src/worker.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const ring = (versions: number): KeyRing => ({
  current: versions,
  keys: new Map(Array.from({ length: versions }, (_, n) => [n + 1, Buffer.alloc(32, n + 61)])),
});
const encode = (keys: KeyRing) =>
  [...keys.keys].map(([version, key]) => `${version}:${Buffer.from(key).toString('base64url')}`).join(',');
const config = { databaseUrl, poolSize: 3 };
const env = { DATABASE_URL: databaseUrl, KERNEL_RECEIPT_KEYS: encode(ring(4)) };

test('worker configuration validates every retained version before opening a database connection', async () => {
  expect(readWorkerConfig(env).receiptKeys).toEqual({ ...ring(4), current: 1 });
  const excessive = { ...env, KERNEL_RECEIPT_KEYS: encode(ring(5)) };
  expect(() => readWorkerConfig(excessive)).toThrow('between 1 and 4');
  await expect(startWorker(config, [], excessive)).rejects.toThrow('between 1 and 4');
  await expect(startWorker({ ...config, receiptKeys: ring(5) }, [], env)).rejects.toThrow('between 1 and 4');
});

test('environment and injected rings reject current or retained sealing keys on every ingress', async () => {
  for (const version of [1, 4]) {
    const shared = `9:${Buffer.from(ring(4).keys.get(version)!).toString('base64url')}`;
    const reused = { ...env, KERNEL_SESSION_KEYS: shared };
    expect(() => readReceiptKeyRing(reused)).toThrow('must not reuse');
    expect(() => readWorkerConfig(reused)).toThrow('must not reuse');
    await expect(startWorker(config, [], reused)).rejects.toThrow('must not reuse');
    await expect(startWorker({ ...config, receiptKeys: ring(4) }, [], reused)).rejects.toThrow('must not reuse');
  }
});

test('worker startup binds its supplied environment ring to the command pool', async () => {
  let bound: KeyRing | undefined;
  const worker = await startWorker(
    config,
    [
      {
        name: 'receipt-key-config',
        register(context) {
          bound = receiptKeysFor(context.pool);
        },
      },
    ],
    env,
  );
  try {
    expect(bound).toEqual(readWorkerConfig(env).receiptKeys);
    expect(bound?.keys.size).toBe(4);
  } finally {
    await worker.stop();
  }
}, 30_000);
