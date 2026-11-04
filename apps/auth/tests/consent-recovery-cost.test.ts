import { afterEach, expect, test } from 'bun:test';
import { createConsentDecision, type ConsentDecision } from '../src/consent';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('installed consent seam bounds reads, preserves marker ownership and distinguishes first refusal', async () => {
  const markers = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => markers.get(key) ?? null,
        setItem: (key: string, value: string) => markers.set(key, value),
        removeItem: (key: string) => markers.delete(key),
      },
    },
  });
  const calls: { init?: RequestInit; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = ((_url, init) =>
    new Promise<Response>((resolve) => calls.push({ init, resolve }))) as typeof fetch;
  const body = {
    client_id: 'reader',
    display_name: null,
    requested: ['openid'],
    scopes: ['openid'],
    granted: [],
    pending_reduction: false,
    acting_account: { account_id: 'person', email: null },
    decisions: { allow: true, decline: true, switch_account: true },
  };
  let state!: ConsentDecision;
  let published = 0;
  const visit = createConsentDecision('reader', 'openid', (value) => {
    state = value;
    published++;
  });
  const settle = async (status = 200, value: unknown = body) => {
    calls.at(-1)!.resolve(Response.json(value, { status }));
    // Drain the finite read/body/decision promise chain, without timers or I/O.
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  };
  try {
    visit.restore();
    visit.restore();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    await settle();
    const refused = visit.approve();
    void visit.approve();
    expect(calls).toHaveLength(2);
    await settle(400, { code: 'invalid_request' });
    await refused;
    expect(state.uncertain).toBe(false);
    expect(state.history).toBe('none');
    expect(markers.size).toBe(0);
    visit.decline();
    expect(state.state).toBe('declined');
    expect(visit.shouldWarn()).toBe(false);
    visit.load();
    visit.load();
    await Promise.resolve();
    expect(calls).toHaveLength(3);
    await settle();
    const unknown = visit.approve();
    await settle(503, {});
    await unknown;
    expect(state.history).toBe('unknown');
    expect(markers.size).toBe(1);
    const laterRefusal = visit.approve();
    await settle(400, {});
    await laterRefusal;
    expect(state.uncertain).toBe(true);
    expect(markers.size).toBe(1);
    visit.refresh();
    await Promise.resolve();
    expect(calls).toHaveLength(6);
    await settle();
    const retired = visit.approve();
    const oldWrite = calls.at(-1)!;
    visit.suspend();
    visit.restore();
    await Promise.resolve();
    await settle();
    const currentWrite = visit.approve();
    oldWrite.resolve(
      Response.json({ client_id: 'reader', account_id: 'person', requested: ['openid'], scope: ['openid'] }),
    );
    await retired;
    expect(state.pending).toBe(true);
    expect(markers.size).toBe(1);
    await settle(200, { client_id: 'reader', account_id: 'person', requested: ['openid'], scope: ['openid'] });
    await currentWrite;
    expect(state.state).toBe('approved');
    expect(state.history).toBe('unknown');
    expect(markers.size).toBe(1);
    visit.refresh();
    await Promise.resolve();
    const read = calls.at(-1)!;
    visit.dispose();
    const count = published;
    expect(read.init?.signal?.aborted).toBe(true);
    await settle();
    expect(published).toBe(count);
    expect([...markers.values()]).toEqual(['pending']);
    expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(5);
  } finally {
    visit.dispose();
  }
});

test('acknowledgement survives authority loss only in mounted generic history', async () => {
  const body = {
    client_id: 'reader',
    display_name: null,
    requested: [],
    scopes: [],
    granted: [],
    pending_reduction: false,
    acting_account: { account_id: 'person', email: null },
    decisions: { allow: true, decline: true, switch_account: true },
  };
  let reads = 0;
  globalThis.fetch = (async (_url, init) =>
    init?.method === 'POST'
      ? Response.json({ client_id: 'reader', account_id: 'person', requested: [], scope: [] })
      : ++reads === 1
        ? Response.json(body)
        : Response.json({}, { status: 401 })) as typeof fetch;
  let state!: ConsentDecision;
  const visit = createConsentDecision('reader', '', (value) => {
    state = value;
  });
  const drain = async () => {
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  };
  try {
    visit.restore();
    await drain();
    await visit.approve();
    expect(state.state).toBe('approved');
    expect(state.history).toBe('acknowledged');
    visit.suspend();
    expect(state.consent).toBeUndefined();
    expect(state.history).toBe('acknowledged');
    visit.restore();
    await drain();
    expect(state.state).toBe('signed-out');
    expect(state.history).toBe('acknowledged');
    const fresh = createConsentDecision('reader', '', () => {});
    expect(fresh.shouldWarn()).toBe(false);
    fresh.dispose();
  } finally {
    visit.dispose();
  }
});
