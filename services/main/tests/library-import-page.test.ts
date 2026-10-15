import { expect, test } from 'bun:test';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { FILE_IMPORT_COST, emptyRow } from '../src/modules/library-import/formats/contract.ts';
import type { RowMatch, StoredSourceRow } from '../src/modules/library-import/file-store.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { libraryImportsRoutes } from '../src/routes/library-imports.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const upload = '00000000-0000-4000-8000-000000000002';
function fixture(options: { readOnly?: boolean; revokedWrite?: boolean; denied?: boolean;
  match?: (index: number) => Promise<Response> } = {}) {
  const saved = new Map<number, RowMatch>();
  let reads = 0, writes = 0, matching = 0, active = 0, peak = 0, pages = 0;
  const rows: StoredSourceRow[] = Array.from({ length: FILE_IMPORT_COST.page }, (_, index) => ({
    index, source: { ...emptyRow(String(index), `Book ${index}`, {}),
      work: `https://rezics.com/id/00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}` },
    match: null, resolution: null, outcome: null, version: 1,
  }));
  const deps = {
    account: { verify: async (_request: Request, scopes: string[]) => {
      if (scopes.includes('library:write')) {
        writes++;
        if (options.revokedWrite) throw new AccountAssertionDenied('Write consent revoked');
      } else reads++;
      return { issuer: 'test', subject: 'reader',
        accountScopes: ['work:read', ...(options.readOnly ? [] : ['library:write'])] };
    } },
    access: { canReadAsBaselineMember: async () => !options.denied },
    libraryFiles: {
      page: async () => { pages++; return { rows: rows.map(row => ({ ...row, match: saved.get(row.index) ?? null })), more: true }; },
      saveMatch: async (_agent: string, _id: string, index: number, match: RowMatch) => { saved.set(index, match); },
    },
    libraryImport: { call: async (request: Request) => {
      const index = Number(new URL(request.url).pathname.split('/').at(-1)!.slice(-12)) - 100;
      matching++; active++; peak = Math.max(peak, active);
      try { return options.match ? await options.match(index) : await Promise.resolve(Response.json({})); }
      finally { active--; }
    } },
  } as unknown as MainWorkDependencies;
  const app = libraryImportsRoutes(deps);
  const read = () => app.handle(new Request(
    `http://main.local/v1/me/library-imports/${upload}/rows?actingSubject=${encodeURIComponent(agent)}`,
    { headers: { authorization: 'Bearer reader', 'idempotency-key': 'review-page' } }));
  return { read, saved, counts: () => ({ reads, writes, matching, peak, pages, active }) };
}

test('a review page matches as one bounded batch and rechecks write authority for every retained row', async () => {
  const h = fixture();
  const response = await h.read();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ nextCursor: 7,
    rows: Array.from({ length: 8 }, (_, index) => ({ index, match: { kind: 'matched' } })) });
  expect(h.counts()).toEqual({ reads: 2, writes: 8, matching: 8, peak: FILE_IMPORT_COST.matchConcurrency, pages: 2, active: 0 });
  expect(h.saved.size).toBe(8);
});

test('read-only review never retains matches, revoked write consent never saves, and another owner never starts matching', async () => {
  const readOnly = fixture({ readOnly: true });
  expect((await readOnly.read()).status).toBe(200);
  expect(readOnly.saved.size).toBe(0);
  expect(readOnly.counts()).toMatchObject({ reads: 2, writes: 0, matching: 8 });
  const revoked = fixture({ revokedWrite: true });
  expect((await revoked.read()).status).toBe(401);
  expect(revoked.saved.size).toBe(0);
  expect(revoked.counts()).toMatchObject({ writes: FILE_IMPORT_COST.matchConcurrency,
    matching: FILE_IMPORT_COST.matchConcurrency, active: 0 });
  const denied = fixture({ denied: true });
  expect((await denied.read()).status).toBe(403);
  expect(denied.counts()).toMatchObject({ matching: 0, pages: 0 });
});

test('a failed match drains the other started rows before returning its refusal', async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const entered = new Promise<void>(done => { started = done; });
  const h = fixture({ match: async index => {
    if (index === 0) return new Response('Unavailable', { status: 503 });
    started();
    await gate;
    return Response.json({});
  } });
  let returned = false;
  const reading = h.read().then(response => { returned = true; return response; });
  await entered;
  await new Promise<void>(done => setImmediate(done));
  expect(returned).toBe(false);
  release();
  expect((await reading).status).toBe(503);
  expect(h.counts()).toMatchObject({ matching: 8, active: 0 });
});
