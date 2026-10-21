import { expect, test } from 'bun:test';
import { BrowseReadError, type ListPage } from './api.ts';
import { browseReadFailure, readBrowse, readBrowseScan } from './browse-read.ts';

test('compact responses acquire honest typed scan failures without losing their original HTTP evidence', async () => {
  for (const [status, code, failure] of [
    [202, 'preparing', 'pending'], [400, 'unsupported_query_shape', 'unsupported'],
    [400, 'invalid_query', 'invalid'], [404, 'not_found', 'missing'],
    [409, 'read_basis_changed', 'moved'], [422, 'work_read_budget_exceeded', 'budget'],
    [503, 'search_unavailable', 'unavailable'], [503, 'discovery_unavailable', 'unbuilt'],
  ] as const) {
    const problem = { status, code, detail: 'Retained producer answer', extension: { opaque: ['value', null] } };
    const call = () => readBrowse<ListPage<never>>(() => {
      throw new BrowseReadError(status, code, problem);
    });
    const compact = await call();
    expect(compact).toEqual({ ok: false, moved: status === 409, status, problem,
      ...(status === 202 ? { pending: true } : {}) });
    if (compact.ok) throw new Error('Expected the actual refusal');
    expect(browseReadFailure(compact)).toBe(failure);
    const scan = await readBrowseScan(call, null);
    expect(scan).toEqual({ checkedPages: 1, result: { ...compact, failure } });
    if (scan.result.ok) throw new Error('Expected the scan refusal');
    expect(scan.result.problem).toBe(problem);
  }
});

test('later scan refusals retain checked progress, while transport failures invent no HTTP answer', async () => {
  const problem = { code: 'unsupported_query_source', opaque: { continuation: 'owner-only' } };
  const first: ListPage<never> = { items: [], nextCursor: 'opaque', complete: false,
    count: { value: 0, kind: 'at-least' } };
  const scan = await readBrowseScan(cursor => readBrowse(async () => {
    if (cursor === null) return first;
    throw new BrowseReadError(400, problem.code, problem);
  }), null);
  expect(scan).toEqual({ checkedPages: 2, result: { ok: false, moved: false,
    status: 400, problem, failure: 'unsupported' } });
  const transport = () => readBrowse<ListPage<never>>(() => { throw new TypeError('Failed to fetch'); });
  expect(await transport()).toEqual({ ok: false, moved: false });
  expect(await readBrowseScan(transport, 'opaque')).toEqual({ checkedPages: 1,
    result: { ok: false, moved: false, failure: 'unavailable' } });
  expect(browseReadFailure({ ok: false, moved: true })).toBe('moved');
  expect(browseReadFailure({ ok: false, moved: false, pending: true })).toBe('pending');
  expect(browseReadFailure({ ok: false, moved: false, failure: 'unsupported', status: 503 })).toBe('unsupported');
});
