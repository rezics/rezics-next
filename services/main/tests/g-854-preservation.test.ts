import { expect,test } from 'bun:test';
import { importReviewedBatch } from '../src/modules/library-import/batch.ts';
import type { ReaderLibraryImportStore } from '../src/modules/library-import/reader-import.ts';
import { matchLibraryRow } from '../src/modules/library-import/match.ts';
import { emptyRow } from '../src/modules/library-import/formats/contract.ts';
const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const release = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const request = new Request('http://main.local',{ headers: { authorization: 'Bearer owner' } });

test('G-854: every legacy status preserves all supplied dates on first apply and lost-response replay',async () => {
  for (const status of ['want-to-read','reading','read'] as const) {
    const outcomes = new Map<number,unknown>();let body: unknown,writes=0;
    const fake = { beginBatch: async () => {},withBatch: async (_a: string,_k: string,f: () => Promise<unknown>) => f(),
      outcomes: async () => outcomes,recordOutcome: async (_a: string,_k: string,i: number,result: unknown) => { outcomes.set(i,result); },
      planStep: async (_a: string,_k: string,_i: number,_s: string,plan: object) => ({ plan,completed: false }),
      completeStep: async () => {},call: async (r: Request) => {
        if (r.method === 'GET') return Response.json({ status: { status: null,startedOn: null,finishedOn: null,version: 0 },rating: { global: null },customShelves: [] });
        body = await r.json();writes++;return Response.json({ version: 1 });
      } } as unknown as ReaderLibraryImportStore;
    const intent = { actingSubject: agent,context: null,language: 'en',existingShelves: [],rows: [{ work,status,
      startedOn: '2026-01-01',finishedOn: '2026-02-01',rating: null,hasRating: false,review: null,
      reviewVisibility: 'private' as const,shelves: [] }] };
    const result = await importReviewedBatch(fake,request,intent,'dates');
    expect(body).toMatchObject({ status,startedOn: '2026-01-01',finishedOn: '2026-02-01' });
    expect(await importReviewedBatch(fake,request,intent,'dates')).toEqual(result);expect(writes).toBe(1);
  }
});
test('G-854: G-833 ISBN lookup chooses an exact edition; VNDB Work identity never chooses an arbitrary release',async () => {
  const paths: string[] = [];
  const fake = { call: async (r: Request) => { paths.push(r.url);return Response.json({ items: [
    { id: release,title: { value: 'Native title' },coverage: [{ work }] } ],nextCursor: null }); } } as ReaderLibraryImportStore;
  const row = { ...emptyRow('v17','Ever17',{}),identifiers: [{ provider: 'https://vndb.org/vn',value: 'v17' }] };
  expect(await matchLibraryRow(fake,request,agent,row,async () => { throw new Error('Native matches must not contact a source'); })).toMatchObject({ kind: 'matched',work,target: null });
  expect(new URL(paths[0]!).searchParams.get('provider')).toBe('https://vndb.org/vn');
  row.identifiers = [{ provider: 'isbn13',value: '9780306406157' }];
  expect(await matchLibraryRow(fake,request,agent,row,async () => { throw new Error('Native matches must not contact a source'); })).toMatchObject({ kind: 'matched',work,target: release });
  expect(new URL(paths[1]!).searchParams.get('isbn13')).toBe('9780306406157');
});
test('G-854: review metadata is applied even when text is identical, and omitted legacy metadata is preserved',async () => {
  const writes: unknown[] = [];
  const fake = { beginBatch: async () => {},withBatch: async (_a: string,_k: string,f: () => Promise<unknown>) => f(),
    outcomes: async () => new Map(),recordOutcome: async () => {},
    planStep: async (_a: string,_k: string,_i: number,_s: string,plan: object) => ({ plan,completed: false }),completeStep: async () => {},
    call: async (r: Request) => {
      if (r.method !== 'GET') { writes.push(await r.json());return Response.json({ version: 2 }); }
      if (new URL(r.url).pathname === '/v1/me/import-reviews') return Response.json({ items: [{ text: 'Same text',language: 'fr',spoiler: true,version: 1 }] });
      return Response.json({ status: { status: null,startedOn: null,finishedOn: null,version: 0 },rating: { global: null },customShelves: [] });
    } } as unknown as ReaderLibraryImportStore;
  const base = { actingSubject: agent,context: null,language: 'en',existingShelves: [],rows: [{ work,status: null,
    startedOn: null,finishedOn: null,rating: null,hasRating: false,review: 'Same text',reviewVisibility: 'private' as const,
    shelves: [],conflictChoice: 'replace' as const,reviewLanguage: 'de',reviewSpoiler: false }] };
  expect((await importReviewedBatch(fake,request,base,'review-metadata')).items[0]!.result.issues).toEqual([]);
  expect(writes[0]).toMatchObject({ text: 'Same text',language: 'de',spoiler: false });
  const { reviewLanguage: _language,reviewSpoiler: _spoiler,...legacy } = base.rows[0]!;
  await importReviewedBatch(fake,request,{ ...base,rows: [{ ...legacy,review: 'Changed text' }] },'legacy-review');
  expect(writes[1]).toMatchObject({ text: 'Changed text',language: 'fr',spoiler: true });
});
