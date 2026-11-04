import { expect, spyOn, test } from 'bun:test';
import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { loadRecoveryPage, parseRecoveryPage } from '../src/recovery-page';
const limits = { minPasswordLength: 8, maxPasswordLength: 128 };

test('page reads send only a stage, bound responses and keep outages explicitly unavailable', async () => {
  const request = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(recoveryPage('complete', limits)));
  try {
    expect((await loadRecoveryPage('complete')).kind).toBe('ready');
    expect(request.mock.calls[0]?.[0]).toBe('/recovery/page');
    expect(request.mock.calls[0]?.[1]).toMatchObject({ body: '{"stage":"complete"}', cache: 'no-store', redirect: 'error' });
    request.mockResolvedValueOnce(new Response('', { status: 503 }));
    expect(await loadRecoveryPage('step-up')).toEqual({ kind: 'unavailable' });
    request.mockResolvedValueOnce(new Response(' '.repeat(4097)));
    expect(await loadRecoveryPage('start')).toEqual({ kind: 'unavailable' });
    const caller = new AbortController();
    request.mockImplementationOnce(() => new Promise(() => {}));
    const pending = loadRecoveryPage('step-up', caller.signal);
    caller.abort();
    expect(await pending).toEqual({ kind: 'unavailable' });
  } finally { request.mockRestore(); }
});

test('stage actions cannot validate a credential or restore another stage’s account advice', () => {
  const viewer = { kind: 'signed-in' as const, account_id: 'current', email: 'current@example.test' };
  expect(parseRecoveryPage(recoveryPage('step-up', limits, viewer), 'step-up')?.viewer).toEqual(viewer);
  expect(parseRecoveryPage(recoveryPage('step-up', limits, viewer), 'complete')).toBeNull();
  const anonymous = recoveryPage('complete', limits, viewer);
  expect(anonymous.viewer).toEqual({ kind: 'signed-out' });
  expect(parseRecoveryPage({ ...anonymous, viewer }, 'complete')).toBeNull();
  expect(parseRecoveryPage({ ...anonymous, token_valid: true }, 'complete')).toBeNull();
  expect(parseRecoveryPage({ ...anonymous, actions: { start: true, complete: true, authenticate: false } }, 'complete')).toBeNull();
});
