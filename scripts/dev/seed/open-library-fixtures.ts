import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixtureLock } from '../../fixtures/pull.ts';

/** Main's local-dev provider fetcher. Every URL is locked to verified committed bytes. */
export function openLibraryFixtureFetch(root: string): typeof fetch {
  const lock = JSON.parse(readFileSync(join(root, 'tests/fixtures/fixtures.lock.json'), 'utf8')) as FixtureLock;
  if (lock.version !== 1) throw new Error('Unsupported Open Library fixture lock');
  const byUrl = new Map(lock.entries.filter(entry => entry.source === 'open-library')
    .map(entry => [entry.requestUrl, entry]));
  return (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if ((init?.method ?? 'GET') !== 'GET' || !url.startsWith('https://openlibrary.org/')) {
      throw new Error(`Open Library fixture fetch rejected ${url}`);
    }
    const entry = byUrl.get(url);
    if (!entry) return new Response(null, { status: 404 });
    const bytes = readFileSync(join(root, entry.seed));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.sha256 || bytes.byteLength !== entry.size) {
      throw new Error(`Open Library fixture integrity mismatch: ${entry.id}`);
    }
    return new Response(bytes, { status: 200,
      headers: { 'content-type': 'application/json',
        'content-length': String(bytes.byteLength) } });
  }) as typeof fetch;
}
