import { afterEach, expect, test } from 'bun:test';
import { CONSENT_DECISION_MAX_RESPONSE_BYTES } from '@rezics/auth-contract';
import { AUTH_POST_TIMEOUT_MS } from '../src/api';
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
    await settle(400, { error: 'authentication_denied' });
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

test('reviewed Allow bounds actual response bytes and accepts UTF-8 split across chunks', async () => {
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
  const clientId = 'reader-é';
  const accountId = 'person-🙂';
  const page = {
    client_id: clientId,
    display_name: null,
    requested: ['read'],
    scopes: ['read'],
    granted: [],
    pending_reduction: false,
    acting_account: { account_id: accountId, email: null },
    decisions: { allow: true, decline: true, switch_account: true },
  };
  let writes = 0;
  const calls: { method?: string; signal?: AbortSignal }[] = [];
  globalThis.fetch = (async (_url, init) => {
    calls.push({ method: init?.method, signal: init?.signal as AbortSignal | undefined });
    if (init?.method !== 'POST') return Response.json(page);
    writes++;
    if (writes === 1) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ account_id: accountId, client_id: clientId, requested: ['read'], scope: ['read'] }),
      );
      const split = bytes.findIndex((byte) => byte >= 0xc2) + 1;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, split));
            controller.enqueue(bytes.slice(split));
            controller.close();
          },
        }),
        { status: 200 },
      );
    }
    if (writes === 2) return Response.json({ code: 'stale_review' }, { status: 409 });
    const bytes = new Uint8Array(CONSENT_DECISION_MAX_RESPONSE_BYTES + 1).fill(0x20);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { 'content-length': '1' },
      },
    );
  }) as typeof fetch;
  let state!: ConsentDecision;
  const visit = createConsentDecision(clientId, 'read', (value) => (state = value));
  const drain = async () => {
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  };
  try {
    visit.restore();
    await drain();
    await visit.approve();
    expect(state.state).toBe('approved');
    expect(markers.size).toBe(0);
    visit.refresh();
    await drain();
    await visit.approve();
    expect(state.uncertain).toBe(true);
    await visit.approve();
    expect(state.state).toBe('ready');
    expect(visit.shouldWarn()).toBe(true);
    expect(markers.size).toBe(1);
    expect(calls.filter((call) => call.method !== 'POST')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(3);
  } finally {
    visit.dispose();
  }
});

test(
  'a stalled Allow body times out within the existing POST lifetime and keeps its marker',
  async () => {
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
    const page = {
      client_id: 'reader',
      display_name: null,
      requested: [],
      scopes: [],
      granted: [],
      pending_reduction: false,
      acting_account: { account_id: 'person', email: null },
      decisions: { allow: true, decline: true, switch_account: true },
    };
    const calls: { method?: string; signal?: AbortSignal }[] = [];
    globalThis.fetch = (async (_url, init) => {
      calls.push({ method: init?.method, signal: init?.signal as AbortSignal | undefined });
      return init?.method === 'POST'
        ? new Response(new ReadableStream({ start() {} }), { status: 200 })
        : Response.json(page);
    }) as typeof fetch;
    let state!: ConsentDecision;
    const visit = createConsentDecision('reader', '', (value) => (state = value));
    const drain = async () => {
      for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    };
    try {
      visit.restore();
      await drain();
      await visit.approve();
      expect(state.pending).toBe(false);
      expect(state.uncertain).toBe(true);
      expect(markers.get(`auth.consent.pending:${JSON.stringify(['person', 'reader', ''])}`)).toBe('pending');
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
      expect(calls.at(-1)?.signal?.aborted).toBe(true);
    } finally {
      visit.dispose();
    }
  },
  AUTH_POST_TIMEOUT_MS + 3000,
);

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
