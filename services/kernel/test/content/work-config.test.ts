import { expect, test } from 'bun:test';
import { readContentWorkConfig } from '../../src/content/work-config.ts';

const env = {
  CONTENT_R2_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
  CONTENT_R2_BUCKET: 'content-media',
  CONTENT_R2_ACCESS_KEY_ID: 'private-access-id',
  CONTENT_R2_SECRET_ACCESS_KEY: 'private-secret',
  CONTENT_SOURCE_HOSTS: 'images.example.org,covers.example.net',
};

test('production R2 and exact HTTPS source hosts are explicit and bounded', () => {
  const config = readContentWorkConfig(env);
  expect(config.storage).toEqual({
    endpoint: env.CONTENT_R2_ENDPOINT,
    bucket: 'content-media',
    accessKeyId: 'private-access-id',
    secretAccessKey: 'private-secret',
    maxObjectBytes: 20 * 1024 * 1024,
    requestTimeoutMs: 30_000,
  });
  expect(config.sourceHosts).toEqual(['images.example.org', 'covers.example.net']);
  expect(Object.isFrozen(config)).toBe(true);
  expect(Object.isFrozen(config.sourceHosts)).toBe(true);
  expect(readContentWorkConfig({ ...env, DATABASE_URL: 'ignored', KERNEL_WORKER_POOL_SIZE: 'invalid' })).toEqual(
    config,
  );
});

test('missing and partial content configuration fail closed without leaking values', () => {
  expect(() => readContentWorkConfig({})).toThrow('CONTENT_R2_ENDPOINT');
  for (const key of Object.keys(env)) {
    const partial: Record<string, string | undefined> = { ...env, [key]: undefined };
    expect(() => readContentWorkConfig(partial)).toThrow(key);
    partial[key] = '';
    expect(() => readContentWorkConfig(partial)).toThrow(key);
  }
  try {
    readContentWorkConfig({ ...env, CONTENT_R2_ENDPOINT: 'https://private-access-id:private-secret@example.org' });
  } catch (error) {
    expect(String(error)).toContain('CONTENT_R2_ENDPOINT');
    expect(String(error)).not.toContain('private-access-id');
    expect(String(error)).not.toContain('private-secret');
  }
});

test('R2 rejects non-R2 origins, plaintext, paths and URL credentials', () => {
  for (const endpoint of [
    'http://127.0.0.1',
    'https://example.org',
    `${env.CONTENT_R2_ENDPOINT}/bucket`,
    `${env.CONTENT_R2_ENDPOINT}?secret=private-secret`,
    env.CONTENT_R2_ENDPOINT.replace('https://', 'https://user:private-secret@'),
  ]) {
    expect(() => readContentWorkConfig({ ...env, CONTENT_R2_ENDPOINT: endpoint })).toThrow('CONTENT_R2_ENDPOINT');
  }
  for (const bucket of ['ab', 'ContainsUppercase', '../other', 'media/bucket'])
    expect(() => readContentWorkConfig({ ...env, CONTENT_R2_BUCKET: bucket })).toThrow('CONTENT_R2_BUCKET');
});

test('source allowlist accepts exact DNS names only and never wildcard or network authority', () => {
  for (const hosts of [
    '*',
    '*.example.org',
    'https://example.org',
    'example.org:443',
    'user@example.org',
    '127.0.0.1',
    '[::1]',
    'example.org/path',
    'example.org,',
    'example.org,example.org',
    ' example.org',
    'Example.org',
    'example.org.',
    Array.from({ length: 129 }, (_, i) => `h${i}.example.org`).join(','),
  ]) {
    expect(() => readContentWorkConfig({ ...env, CONTENT_SOURCE_HOSTS: hosts })).toThrow('CONTENT_SOURCE_HOSTS');
  }
});
