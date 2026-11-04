import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { developmentKeys, localDatabase, publicKey } from '../scripts/dev-stack.ts';

test('first-run secrets remain private and stable across setup retries', async () => {
  await mkdir(resolve(import.meta.dir, '../../../.temp'), { recursive: true });
  const directory = await mkdtemp(resolve(import.meta.dir, '../../../.temp/local-keys-'));
  try {
    const keys = await developmentKeys(directory);
    expect(await developmentKeys(directory)).toEqual(keys);
    expect((await stat(resolve(directory, 'keys.json'))).mode & 0o777).toBe(0o600);
    expect(new Set([keys.signing.kid, keys.website.kid, keys.importer.kid]).size).toBe(3);
    expect(publicKey(keys.importer).d).toBeUndefined();
    expect(keys.secret).not.toBe(keys.staging);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local setup refuses remote databases', () => {
  expect(() => localDatabase('postgres://rezics:rezics@production.example/rezics')).toThrow('127.0.0.1');
  expect(localDatabase('postgres://rezics:rezics@127.0.0.1:54329/rezics').hostname).toBe('127.0.0.1');
});
