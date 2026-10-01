import { expect, test } from 'bun:test';
import { rateLimitFamily } from '../src/modules/rate-limit/budgets.ts';
import { LIBRARY_UPLOAD_RETENTION_DAYS } from '../src/modules/library-import/file-store.ts';

test('G-854 review: import matching consumes writes, export consumes reads, and deletion is classified', () => {
  for (const [method,path] of [['POST','/v1/me/library-imports'],['GET','/v1/me/library-imports/123/rows'],
    ['PUT','/v1/me/library-imports/123/rows/0'],['POST','/v1/me/library-imports/123/apply'],
    ['POST','/v1/me/library-imports/123/rows/0/adoptions'],['DELETE','/v1/me/library-imports/123']]) {
    expect(rateLimitFamily(method!,path!)).toBe('write');
  }
  expect(rateLimitFamily('GET','/v1/me/library-export')).toBeNull();
  expect(LIBRARY_UPLOAD_RETENTION_DAYS).toBe(7);
});

import { findImportSession } from '../src/modules/library-import/session-import.ts';
import { importDigest, storedImportSource } from '../src/modules/library-import/file-store.ts';
import { emptyRow } from '../src/modules/library-import/formats/contract.ts';
import type { ReaderLibraryImportStore } from '../src/modules/library-import/reader-import.ts';

test('G-854 review: an earlier matching page cannot replace a source-bound attempt with later manual changes', async () => {
  const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
  const desired = { target: work,state: 'finished' as const,startedOn: '2026-01-01',finishedOn: '2026-02-01',selections: [{ target: work }],locators: [] };
  const candidate = { ...desired,id: 'candidate',target: { work,resource: work },selections: [] };
  const original = { ...candidate,id: 'original',state: 'paused',finishedOn: null };
  let calls = 0;
  const store = { pool: { query: async () => ({ rows: [{ session_id: original.id,desired_digest: importDigest(desired) }] }) },
    call: async (request: Request) => {
      expect(new URL(request.url).searchParams.get('work')).toBe(work);
      calls++;
      return Response.json(calls===1 ? { items: [candidate],nextCursor: 'older-page' } : { items: [original],nextCursor: null });
    } } as unknown as ReaderLibraryImportStore;
  const found = await findImportSession(store,new Request('http://main.local',{ headers: { authorization: 'Bearer owner' } }),
    agent,{ ...emptyRow('source-one','Book',{}),work },'rezics',desired);
  expect(calls).toBe(2);
  expect(found).toMatchObject({ session: { id: original.id,state: 'paused' },replay: true });
});

test('G-854 review: portable source envelopes share canonical bytes and retain their private view fields', () => {
  const original = emptyRow('external-row','Original book',{ note: 'Private evidence' });
  const digest = importDigest(original);
  const archive = { ...emptyRow(`source:${digest}`,'Original book',{ source: original,outcome: { issues: [] },extension: 'Kept' }),kind: 'retained' as const };
  const held = storedImportSource(archive);
  expect(held.digest).toBe(digest);
  expect(held.source).toEqual(original);
  expect(held.view?.raw).toEqual({ outcome: { issues: [] },extension: 'Kept' });
  expect(storedImportSource({ ...archive,sourceId: `source:${'0'.repeat(64)}` }).source).toEqual({ ...archive,sourceId: `source:${'0'.repeat(64)}` });
});
