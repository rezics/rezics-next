import { expect, spyOn, test } from 'bun:test';
import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { loadRecoveryPage } from '../src/recovery-page';
import { RecoveryReturnController } from '../src/recovery-return';

test('generic mounted history adds no I/O or payload to one installed advice read', async () => {
  const history = new RecoveryReturnController();
  const failed = history.dispatch('start');
  failed({ ok: false, status: 503, code: 'unavailable', retryAfter: null });
  history.dispatch('complete');
  const request = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json(recoveryPage('complete', { minPasswordLength: 8, maxPasswordLength: 128 })),
  );
  try {
    expect((await loadRecoveryPage('complete')).kind).toBe('ready');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('/recovery/page');
    expect(request.mock.calls[0]?.[1]?.body).toBe('{"stage":"complete"}');
    expect(history.summary).toEqual({ start: 'dispatched', complete: 'dispatched' });
  } finally {
    request.mockRestore();
  }
});
