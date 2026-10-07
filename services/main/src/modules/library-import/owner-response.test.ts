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
