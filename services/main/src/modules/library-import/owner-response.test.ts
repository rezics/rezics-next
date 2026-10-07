import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { ImportCommands } from './batch.ts';
import { ReaderImportUnavailable, ReaderLibraryImportStore } from './reader-import.ts';
import { readSessionImportState } from './session-import.ts';

const request = new Request('http://main.local/import', { headers: { authorization: 'Bearer reader' } });
const batch = { actingSubject: 'reader', context: null, language: 'und', existingShelves: [], rows: [] };
function commands(status: number) {
  const store = new ReaderLibraryImportStore({} as Pool);
  store.setDispatch(async () => Response.json({ code: 'owner_refused' }, { status }));
  store.planStep = async (_agent, _key, _row, _step, plan) => ({ plan: plan as Record<string, unknown>, completed: false });
  return { store, commands: new ImportCommands(store, request, batch, 'file') };
}

test.each([400, 401, 403, 404, 409, 429, 500, 503])('owner read %i is a real refusal rather than accepted progress', async status => {
  await expect(commands(status).commands.read('/v1/collections/shelf')).rejects.toBeInstanceOf(ReaderImportUnavailable);
});

test.each([429, 500, 503])('owner command %i refuses this apply instead of leaving it pending', async status => {
  const { store, commands: owner } = commands(status);
  await expect(owner.step(0, 'status', 'PUT', '/v1/works/work/reader-status', {})).rejects.toBeInstanceOf(ReaderImportUnavailable);
  await expect(readSessionImportState(store, request, '/v1/me/sessions')).rejects.toBeInstanceOf(ReaderImportUnavailable);
});

test('an owner 202 remains accepted pending work', async () => {
  const { store, commands: owner } = commands(202);
  expect(await owner.read('/v1/collections/shelf')).toBeNull();
  expect(await owner.step(0, 'status', 'PUT', '/v1/works/work/reader-status', {})).toBe('retry');
  expect(await readSessionImportState(store, request, '/v1/me/sessions')).toBeNull();
});

test.each([[403, 'failed'], [409, 'stale']] as const)('owner command %i retains its row outcome %s', async (status, outcome) => {
  expect(await commands(status).commands.step(0, 'status', 'PUT', '/v1/works/work/reader-status', {})).toBe(outcome);
});

test('a hung owner request is refused after its bounded timeout', async () => {
  const store = new ReaderLibraryImportStore({} as Pool, undefined, 20);
  store.setDispatch(() => new Promise<Response>(() => {}));
  await expect(store.call(request)).rejects.toBeInstanceOf(ReaderImportUnavailable);
});

test('an aborted lease cancels the owner request and releases the batch lock', async () => {
  const queries: string[] = [];
  let released = false;
  const pool = { connect: async () => ({
    query: async (sql: string) => { queries.push(sql);return { rows: [{ locked: true }] }; },
    release: () => { released = true; } }) } as unknown as Pool;
  const store = new ReaderLibraryImportStore(pool);
  store.setDispatch(() => new Promise<Response>(() => {}));
  const lease = new AbortController();
  const owned = new Request('http://main.local/import', { signal: lease.signal });
  const reason = new Error('lease expired');
  const applying = store.withBatch('reader', 'key', () => store.call(owned), lease.signal);
  setTimeout(() => lease.abort(reason), 10);
  await expect(applying).rejects.toBe(reason);
  expect(queries.some(sql => sql.includes('pg_advisory_unlock'))).toBe(true);
  expect(released).toBe(true);
  await expect(store.call(owned)).rejects.toBe(reason);
});

test('an aborted lease releases the batch lock even when the action ignores cancellation', async () => {
  const queries: string[] = [];
  const pool = { connect: async () => ({
    query: async (sql: string) => { queries.push(sql);return { rows: [{ locked: true }] }; },
    release: () => {} }) } as unknown as Pool;
  const lease = new AbortController();
  setTimeout(() => lease.abort(new Error('lease expired')), 10);
  await expect(new ReaderLibraryImportStore(pool).withBatch('reader', 'key', () => new Promise<never>(() => {}), lease.signal)).rejects.toThrow('lease expired');
  expect(queries.some(sql => sql.includes('pg_advisory_unlock'))).toBe(true);
});

test('a lease cancelled while a step is being planned starts no owner write', async () => {
  const lease = new AbortController();
  const reason = new Error('lease expired');
  const store = new ReaderLibraryImportStore({} as Pool);
  let dispatched = 0;
  store.setDispatch(async () => { dispatched++;return Response.json({}, { status: 200 }); });
  store.planStep = async (_agent, _key, _row, _step, plan) => {
    lease.abort(reason);
    return { plan: plan as Record<string, unknown>, completed: false };
  };
  const owned = new Request('http://main.local/import', { signal: lease.signal });
  const owner = new ImportCommands(store, owned, batch, 'file');
  await expect(owner.step(0, 'status', 'PUT', '/v1/works/work/reader-status', {})).rejects.toBe(reason);
  expect(dispatched).toBe(0);
});
