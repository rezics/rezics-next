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
  expect(queries.some(sql => sql.includes('pg_advisory_unlock'))).toBe(false);
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
  expect(queries.some(sql => sql.includes('pg_advisory_unlock'))).toBe(false);
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

test('file and reviewed batches share one checkout across owner reads and per-row commits', async () => {
  const { LibraryFileStore } = await import('./file-store.ts');
  const { ReaderLibraryStatusStore } = await import('../library/status.ts');
  const { MediaStore, DEFAULT_MEDIA_CONTEXT } = await import('../media/store.ts');
  const { withImportJobProgress } = await import('./job-context.ts');
  const { contentConnection } = await import('../../../../content/src/connection.ts');
  const agent = 'https://rezics.com/id/0194f314-9280-767f-89a6-000000000099';
  const work = 'https://rezics.com/id/0194f314-9280-767f-89a6-000000000001';
  const digest = 'a'.repeat(64);
  const queries: string[] = [];
  let checkouts = 0, releases = 0;
  const pool = { query: () => { throw new Error('nested pool query'); }, connect: async () => {
    if (++checkouts !== 1) throw new Error('nested pool checkout');
    return { query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('SELECT request_digest, row_count')) return { rows: [{ request_digest: digest, row_count: 1 }] };
      if (sql.includes('SELECT plan, completed')) return { rows: [{ plan: {}, completed: false }] };
      if (sql.includes('FROM owner o LEFT JOIN chosen')) return { rows: [{ owner_epoch: 'epoch', owner_sequence: '1' }] };
      return { rows: [], rowCount: 1 };
    }, release: () => { releases++; } };
  } } as unknown as Pool;
  const imports = new ReaderLibraryImportStore(pool);
  const files = new LibraryFileStore(pool);
  const status = new ReaderLibraryStatusStore(pool);
  const media = new MediaStore(pool, {} as never);
  await imports.withBatch(agent, 'file-agent-apply', async () => {
    await files.pending(agent, 'file');
    await imports.beginBatch(agent, 'row', digest, 1);
    await imports.withBatch(agent, 'row', async () => {
      await imports.outcomes(agent, 'row');
      await imports.planStep(agent, 'row', 0, 'status', {});
      await withImportJobProgress(() => files.jobs.progress(agent, 'file', 'token'),
        () => imports.completeStep(agent, 'row', 0, 'status'));
      await status.privateReviews(agent, [work]);
      await status.batch(agent, [work]);
      await status.fence(agent, 'added');
      await media.avatarRows([agent], DEFAULT_MEDIA_CONTEXT);
      // Each completed row still owns a real transaction and commits before
      // the next owner command, while the outer session lock stays held.
      await files.complete(agent, 'file', 0, { applied: [], issues: [] });
      await imports.recordOutcome(agent, 'row', 0, {});
    });
    expect(releases).toBe(0);
    expect(contentConnection(pool)).not.toBe(pool);
  });
  expect(checkouts).toBe(1);
  expect(releases).toBe(1);
  expect(queries.filter(sql => sql.includes('pg_advisory_unlock'))).toHaveLength(2);
  expect(queries).toContain('COMMIT');
});

test('Open Library acquisition lends its lock connection to Source evidence and rights reads', async () => {
  const { SourceIntakeStore } = await import('../source/intake.ts');
  const { OpenLibraryConversionStore } = await import('../source/open-library-conversion.ts');
  const { SourceNativeWorkProposalStore } = await import('../source/native-work-proposal.ts');
  const { SourceNativeWorkAdoptionStore } = await import('../source/native-work-adoption.ts');
  const { RightsStore } = await import('../rights/store.ts');
  const { withReferenceFence } = await import('../erasure/reference-fence.ts');
  const owner = '0194f314-9280-767f-89a6-000000000099';
  const queries: string[] = [];
  let checkouts = 0, released = false;
  const pool = { query: () => { throw new Error('nested pool query'); }, connect: async () => {
    if (++checkouts !== 1) throw new Error('nested pool checkout');
    return { query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; },
      release: () => { released = true; } };
  } } as unknown as Pool;
  const intake = new SourceIntakeStore(pool);
  const conversions = new OpenLibraryConversionStore(pool, intake);
  const proposals = new SourceNativeWorkProposalStore(pool, {} as never, conversions);
  const adoptions = new SourceNativeWorkAdoptionStore(pool, proposals, {} as never, {} as never, {} as never);
  await new ReaderLibraryImportStore(pool).withOpenLibraryWork('OL123W', async () => {
    expect(await intake.replay(owner, 'source-key')).toBeNull();
    expect(await conversions.read(owner, owner)).toBeNull();
    expect(await proposals.read(owner, owner)).toBeNull();
    expect(await adoptions.authorReferences([`https://rezics.com/id/${owner}`])).toEqual(new Map());
    expect(await new RightsStore(pool, {} as never).rawRetentionPermitted('open-library', 'work')).toBe(true);
    await withReferenceFence(pool, 'a'.repeat(64), async () => {});
    expect(released).toBe(false);
  });
  expect(checkouts).toBe(1);
  expect(released).toBe(true);
  expect(queries).toContain('BEGIN');
  expect(queries).toContain('COMMIT');
  expect(queries).toContain('RESET statement_timeout');
});
