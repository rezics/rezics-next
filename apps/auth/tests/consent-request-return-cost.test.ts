import { afterEach, expect, test } from 'bun:test';
import { createConsentDecision, type ConsentDecision } from '../src/consent';
import { createConsentRequestReturn, type ConsentNotices } from '../src/consent-request-return';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('retirement bounds a stalled private response body; generic presentation adds no transport', async () => {
  const body = Promise.withResolvers<unknown>();
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: () => body.promise } as Response;
  }) as typeof fetch;
  let state!: ConsentDecision;
  let notices: ConsentNotices = {};
  const history = createConsentRequestReturn((value) => {
    notices = value;
  });
  const visit = createConsentDecision(
    'client',
    'openid',
    (value) => {
      state = value;
    },
    history.remember,
  );
  const drain = async () => {
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  };
  try {
    visit.restore();
    visit.restore();
    visit.load();
    await drain();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/consent/client?scope=openid');
    visit.dispose();
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
    body.resolve({ client_id: 'client', private: 'retired body' });
    await drain();
    expect(state.consent).toBeUndefined();
    expect(notices).toEqual({});
    history.remember('unknown');
    const first = notices.first!;
    history.remember('acknowledged');
    const retiredLatest = notices.latest!;
    history.remember('refused');
    history.dismiss(retiredLatest);
    expect(notices.latest?.outcome).toBe('refused');
    expect(notices.first).toBe(first);
    history.remember('unknown');
    const secondUnknown = notices.latest!;
    history.dismiss(first);
    history.remember('acknowledged');
    expect(notices.first).toBe(secondUnknown);
    history.dismiss(secondUnknown);
    history.dismiss(notices.latest!);
    expect(Object.values(notices).filter(Boolean)).toHaveLength(0);
    expect(calls).toHaveLength(1);
  } finally {
    visit.dispose();
  }
});
