import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { readNativeOperation, cancelNativeOperation, type BulkOperation, type CancelCommand } from '../src/library/bulk-operation-recovery-native';
import { BulkOperationRecovery } from '../src/library/bulk-operation-recovery';

const id = '12345678-1234-4234-8234-123456789abc';
const other = '22345678-1234-4234-8234-123456789abc';
const operation: BulkOperation = {
  id, route: 1, action: 'set_status', state: 'planned', collectionId: null, selectionKind: 'explicit', phase: 'applying',
  selectionComplete: true, occurrencesComplete: true, cancelRequested: false,
  counts: { scannedCandidates: 2, selectedSubjects: 2, scannedOccurrences: 0, capturedOccurrences: 0, targets: 2,
    applied: 1, pending: 1, no_effect: 0, reconciling: 0, conflict: 0, denied: 0, failed: 0, cancelled: 0 },
  summary: null, admittedAt: '2026-11-03T00:00:00Z', targetBoundAt: null,
  expiresAt: '2099-11-04T00:00:00Z', resultsExpireAt: '2099-11-05T00:00:00Z', finishedAt: null, reason: null,
};
const outcome = { ordinal: '0', subjectId: 'committed', memberId: null, state: 'applied', reason: null, resultingMemberId: null };
function native(handler: (request: Request) => Response | Promise<Response>) {
  return createKernelClient('https://kernel.test', { fetch: (async (url, init) => handler(new Request(url, init))) as typeof fetch });
}
const json = (body: unknown, status = 200) => Response.json(body, { status });

 test('authorized GET reads captured action, progress and native bounded cursor pages without commands', async () => {
  const requests: Request[] = [];
  const client = native((request) => {
    requests.push(request);
    const url = new URL(request.url);
    return json(url.pathname.endsWith('/outcomes')
      ? { outcomes: url.searchParams.has('cursor') ? [] : [outcome], next: url.searchParams.has('cursor') ? null : 'native+/cursor==' }
      : { operation });
  });
  const first = await readNativeOperation(client, 'Bearer original', { id, viewer: 'alice' });
  expect(first).toMatchObject({ state: 'ready', operation: { action: 'set_status', counts: { applied: 1 } }, page: { outcomes: [outcome] } });
  const second = await readNativeOperation(client, 'Bearer original', { id, viewer: 'alice', cursor: 'native+/cursor==' });
  expect(second).toMatchObject({ state: 'ready', operation: { id }, page: { outcomes: [], next: null } });
  expect(requests.every((request) => request.method === 'GET' && request.headers.get('authorization') === 'Bearer original')).toBe(true);
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    `/v1/libraryOperations/${id}`, `/v1/libraryOperations/${id}/outcomes`,
    `/v1/libraryOperations/${id}`, `/v1/libraryOperations/${id}/outcomes`,
  ]);
  const query = new URL(requests[3]!.url).searchParams;
  expect(query.get('limit')).toBe('20');
  expect(query.get('cursor')).toBe('native+/cursor==');
});

test('expired, forbidden, unavailable and invalid pages cannot become an empty completed operation', async () => {
  for (const [status, state] of [[403, 'forbidden'], [404, 'unavailable'], [503, 'unavailable'], [410, 'expired'], [400, 'invalid']] as const) {
    expect(await readNativeOperation(native(() => json({ code: 'refused' }, status)), 'Bearer a', { id, viewer: 'alice' })).toEqual({ state });
    expect(await readNativeOperation(native((r) => json(r.url.endsWith('/outcomes') ? { code: 'refused' } : { operation }, r.url.endsWith('/outcomes') ? status : 200)), 'Bearer a', { id, viewer: 'alice' })).toEqual({ state });
  }
  expect(await readNativeOperation(native(() => json({ operation: { ...operation, resultsExpireAt: '2000-01-01T00:00:00Z' } })), 'Bearer a', { id, viewer: 'alice' })).toEqual({ state: 'expired' });
  const completed = await readNativeOperation(native((r) => json(r.url.endsWith('/outcomes') ? { outcomes: [], next: null } : { operation: { ...operation, phase: 'completed' } })), 'Bearer a', { id, viewer: 'alice' });
  expect(completed).toMatchObject({ state: 'ready', operation: { phase: 'completed' }, page: { outcomes: [] } });
});

function fixture() {
  let admitted = true;
  let episode = 0;
  const commands: CancelCommand[] = [];
  const reads: { id: string; viewer: string; cursor?: string }[] = [];
  let readResult = async () => ({ state: 'ready' as const, operation, page: { outcomes: [outcome], next: 'native-cursor' } });
  let cancelResult = async () => ({ state: 'uncertain' as const });
  const reader = new BulkOperationRecovery({ id, viewer: 'alice' }, {
    current: () => admitted,
    capture: () => { const version = episode; return () => admitted && version === episode; },
    csrf: () => 'original-csrf',
  }, {
    read: async (address) => { reads.push(address); return readResult(); },
    cancel: async (command) => { commands.push(command); return cancelResult(); },
  }, () => {});
  return { reader, commands, reads,
    retire: () => { episode++; admitted = false; }, restore: () => { episode++; admitted = true; },
    setRead: (work: typeof readResult) => { readResult = work; },
    setCancel: (work: typeof cancelResult) => { cancelResult = work; },
  };
}

test('explicit cancellation captures a distinct identity and retries the exact command; recovery retains native cursor', async () => {
  const f = fixture();
  await f.reader.read();
  await f.reader.more();
  await f.reader.cancel();
  await f.reader.cancel();
  await f.reader.cancel(true);
  expect(f.commands).toHaveLength(2);
  expect(f.commands[1]).toBe(f.commands[0]);
  expect(f.commands[0]).toEqual({ id, viewer: 'alice', key: expect.any(String), csrf: 'original-csrf' });
  expect(f.commands[0]!.key).not.toBe(id);
  await f.reader.read();
  expect(f.reads[2]).toEqual({ id, viewer: 'alice', cursor: 'native-cursor' });
  expect(f.reader.state.operation?.counts.applied).toBe(1);
  const requests: Request[] = [];
  const client = native((r) => { requests.push(r); return json({ operation: { ...operation, cancelRequested: true } }); });
  expect(await cancelNativeOperation(client, 'Bearer original', f.commands[0]!)).toMatchObject({ state: 'ready', operation: { counts: { applied: 1 } } });
  expect(requests[0]!.method).toBe('POST');
  expect(new URL(requests[0]!.url).pathname).toBe(`/v1/libraryOperations/${id}:cancel`);
  expect(requests[0]!.headers.get('idempotency-key')).toBe(f.commands[0]!.key);
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer original');
  expect(await requests[0]!.json()).toEqual({});
});

test('authority or address retirement rejects late reads and commands, including loss followed by restoration', async () => {
  for (const retire of ['authority', 'address', 'viewer', 'locale'] as const) {
    const f = fixture();
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    f.setRead(async () => { await wait; return { state: 'ready', operation, page: { outcomes: [outcome], next: null } }; });
    const pending = f.reader.read();
    f.retire();
    if (retire === 'address' || retire === 'viewer' || retire === 'locale') f.reader.retire();
    await f.reader.cancel();
    expect(f.commands).toHaveLength(0);
    f.restore(); finish(); await pending;
    expect(f.reader.state.page).toBeUndefined();
  }
  const f = fixture();
  await f.reader.read();
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  f.setCancel(async () => { await wait; return { state: 'uncertain' }; });
  const pending = f.reader.cancel();
  f.retire(); f.restore(); finish(); await pending;
  expect(f.reader.state.cancel).toBe('uncertain');
  await f.reader.cancel(true);
  expect(f.commands[1]).toBe(f.commands[0]);
});

test('a wrong operation response cannot replace the addressed operation', async () => {
  expect(await readNativeOperation(native(() => json({ operation: { ...operation, id: other } })), 'Bearer a', { id, viewer: 'alice' })).toEqual({ state: 'unavailable' });
});
