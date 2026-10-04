import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { WorkFileStaging } from '../src/modules/work/file-staging.ts';
import { stagedWorkObjectCandidates, discardUnpublishedWorkObjects } from '../src/modules/work/object-gc.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';

test('G1038: concurrent immutable staging preserves a referenced same-key local manifest and discards cancelled candidates', async () => {
  const directory = mkdtempSync(resolve('.temp/g-1038-staging-'));
  try {
    const first = new WorkFileStaging(directory), second = new WorkFileStaging(directory);
    const one = stagedWorkObjectCandidates(), two = stagedWorkObjectCandidates();
    const ids = await Promise.all([first.component('urn:rezics:test:work', { title: 'same intent' }, one),
      second.component('urn:rezics:test:work', { title: 'same intent' }, two)]);
    await Promise.all([first.flush(), second.flush()]);
    expect(ids[0]).toBe(ids[1]);
    const stored = JSON.parse(readFileSync(join(directory, ids[0]!), 'utf8')) as { payload: string };
    expect(existsSync(join(directory, stored.payload.slice(7)))).toBe(true);
    let referenced = true;
    const fuseki = { query: async () => ({ boolean: referenced }) } as unknown as FusekiClient;
    expect(await discardUnpublishedWorkObjects({ fuseki, objectDirectory: directory, candidates: two })).toBe(false);
    expect(existsSync(join(directory, ids[0]!))).toBe(true);
    referenced = false;
    expect(await discardUnpublishedWorkObjects({ fuseki, objectDirectory: directory, candidates: one })).toBe(true);
    expect(existsSync(join(directory, ids[0]!))).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
