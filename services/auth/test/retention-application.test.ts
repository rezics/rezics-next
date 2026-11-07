import { expect, test } from 'bun:test';
import { createAuthRetentionInvocation } from '../src/core/index.ts';
import { createRetentionMaintenance, createWorkflowRetention, retireNativeRequest } from '../src/application/index.ts';
import {
  SigningRotationPending,
  type NativeRequestRetentionPorts,
  type WorkflowRetentionPorts,
  type WorkflowRetentionStore,
} from '../src/contract/index.ts';

type Cursor = Readonly<{ cutoff: number; offset: number }>;

/** A transactional cursor, independent of the SDK's opaque cursor representation. */
function fixture() {
  const state = { cursor: null as Cursor | null, now: 90 * 86400000, opens: 0 };
  const events: string[] = [];
  const store: WorkflowRetentionStore<Cursor> = {
    async withSession(run) {
      events.push('connect');
      try {
        return await run({
          async transaction(body) {
            events.push('begin');
            const saved = state.cursor;
            try {
              const result = await body({
                async lock() {
                  events.push('lock');
                  return state.cursor;
                },
                async save(cursor) {
                  events.push('save');
                  state.cursor = cursor;
                },
              });
              events.push('commit');
              return result;
            } catch (error) {
              state.cursor = saved;
              events.push('rollback');
              throw error;
            }
          },
        });
      } finally {
        events.push('release');
      }
    },
  };
  const ports: WorkflowRetentionPorts<Cursor> = {
    store,
    now: () => state.now,
    scan: {
      admit() {
        events.push('admit');
      },
      async open(cutoff) {
        state.opens++;
        events.push('open');
        return { cutoff, offset: 0 };
      },
      async read(cursor, rawLimit) {
        expect(rawLimit).toBe(1000);
        events.push('read');
        return { cutoff: cursor.cutoff, examined: 1, copies: [], continuation: null, exhausted: true };
      },
    },
    retireCopy: async () => false,
    deleteTechnical: async () => {},
  };
  return { state, events, ports };
}

test('the application commits its horizon before retirement and replays the exact identity after a lost reply', async () => {
  const f = fixture();
  let loseReply = true;
  const invocation = createAuthRetentionInvocation({ maxPages: 2 });
  const ids: string[] = [];
  f.ports.scan.read = async (cursor) => ({
    cutoff: cursor.cutoff,
    examined: 1000,
    copies: [
      { workflowID: 'personal:1', workflowName: 'accounts.registration' },
      { workflowID: 'personal:2', workflowName: 'accounts.operation' },
      { workflowID: 'technical:1', workflowName: 'auth.maintenance.tick' },
      { workflowID: 'technical:2', workflowName: 'auth.workflowRetention' },
    ],
    continuation: null,
    exhausted: true,
  });
  f.ports.retireCopy = async (id, received) => {
    expect(received).toBe(invocation);
    await received.reserve('connect');
    await received.reserve('reconcile');
    // Preparation has committed under the original horizon before any effect.
    expect(f.events.slice(0, 7)).toEqual(['admit', 'connect', 'begin', 'lock', 'open', 'save', 'commit']);
    expect(f.state.cursor).toEqual({ cutoff: 60 * 86400000, offset: 0 });
    ids.push(id);
    return true;
  };
  f.ports.deleteTechnical = async (technical, received) => {
    expect(received).toBe(invocation);
    await received.reserveDelete('commit');
    expect(technical).toEqual(['technical:1', 'technical:2']);
    if (loseReply) throw new Error('lost committed SDK reply');
  };
  const retention = createWorkflowRetention(f.ports);
  await expect(retention.page(30, invocation)).rejects.toThrow('lost committed SDK reply');
  expect(f.events.slice(-2)).toEqual(['rollback', 'release']);
  expect(f.state.cursor).toEqual({ cutoff: 60 * 86400000, offset: 0 });
  f.state.now += 10 * 86400000;
  loseReply = false;
  expect(await retention.page(30, invocation)).toEqual({
    cutoff: 60 * 86400000,
    examined: 1000,
    eligible: 4,
    retired: 4,
    pending: 0,
    done: true,
  });
  expect(ids).toEqual(['personal:1', 'personal:2', 'personal:1', 'personal:2']);
  expect(invocation.snapshot()).toMatchObject({
    pages: 2,
    examined: 2000,
    copies: 8,
    technical: 4,
    dispatches: { 'close:connect': 4, 'close:reconcile': 4, 'delete:commit': 2 },
  });
  expect(f.state.opens).toBe(1);
  expect(f.state.cursor).toBeNull();
});

test('pending and near-match technical names consume raw pages and a capped drain resumes the saved cutoff', async () => {
  const f = fixture();
  const visited: string[] = [];
  const rawLimits: number[] = [];
  f.ports.scan.read = async (cursor, rawLimit) => {
    rawLimits.push(rawLimit);
    return {
      cutoff: cursor.cutoff,
      examined: rawLimit,
      copies: [{ workflowID: `personal:${cursor.offset}`, workflowName: 'auth.workflowRetention.extra' }],
      continuation: { ...cursor, offset: cursor.offset + rawLimit },
      exhausted: false,
    };
  };
  f.ports.retireCopy = async (id) => {
    visited.push(id);
    return false;
  };
  f.ports.deleteTechnical = async () => {
    throw new Error('personal custody bypassed');
  };
  const retention = createWorkflowRetention(f.ports);
  expect(await retention.sweep(30)).toBe(0);
  expect(rawLimits).toEqual(Array(60).fill(1000));
  expect(visited).toHaveLength(60);
  expect(f.state.cursor).toEqual({ cutoff: 60 * 86400000, offset: 60000 });
  f.state.now += 86400000;
  expect(await retention.page(30)).toEqual({
    cutoff: 60 * 86400000,
    examined: 1000,
    eligible: 1,
    retired: 0,
    pending: 1,
    done: false,
  });
  expect(visited.at(-1)).toBe('personal:60000');
  expect(f.state.opens).toBe(1);
});

test('unavailable scan admission uses no connection and empty/concurrently drained horizons run no effects', async () => {
  const f = fixture();
  f.ports.scan.admit = () => {
    throw new Error('scan producer unavailable');
  };
  await expect(createWorkflowRetention(f.ports).page(30)).rejects.toThrow('scan producer unavailable');
  expect(f.events).toEqual([]);
  f.ports.scan.admit = () => {};
  f.ports.scan.open = async () => null;
  f.ports.scan.read = async () => {
    throw new Error('empty scan read');
  };
  expect(await createWorkflowRetention(f.ports).page(30)).toEqual({
    cutoff: 60 * 86400000,
    examined: 0,
    eligible: 0,
    retired: 0,
    pending: 0,
    done: true,
  });
  expect(f.events).toEqual(['connect', 'begin', 'lock', 'commit', 'begin', 'lock', 'commit', 'release']);
  // A different caller drains the prepared cursor after the preparation commit.
  f.events.length = 0;
  f.ports.scan.open = async (cutoff) => ({ cutoff, offset: 0 });
  const withSession = f.ports.store.withSession;
  f.ports.store.withSession = (run) =>
    withSession((session) =>
      run({
        async transaction(body) {
          const result = await session.transaction(body);
          f.state.cursor = null;
          return result;
        },
      }),
    );
  expect(await createWorkflowRetention(f.ports).page(30)).toMatchObject({ done: true, retired: 0 });
  expect(f.events.filter((event) => event === 'lock')).toHaveLength(2);
});

test('request retirement requires both versioned binding and original consumer evidence on the exact key', async () => {
  let row: Awaited<ReturnType<NativeRequestRetentionPorts['lock']>>;
  let terminal = false;
  const events: string[] = [];
  const ports: NativeRequestRetentionPorts = {
    async lock(id) {
      events.push(`lock:${id}`);
      return row;
    },
    async terminal(id) {
      events.push(`terminal:${id}`);
      return terminal;
    },
    async remove(id) {
      events.push(`remove:${id}`);
    },
  };
  for (row of [
    undefined,
    { request_party_version: 0, request_context_version: 1 },
    { request_party_version: 1, request_context_version: 0 },
  ]) {
    events.length = 0;
    expect(await retireNativeRequest(ports, 'original')).toBe(false);
    expect(events).toEqual(['lock:original']);
  }
  row = { request_party_version: 1, request_context_version: 1 };
  events.length = 0;
  expect(await retireNativeRequest(ports, 'original')).toBe(false);
  expect(events).toEqual(['lock:original', 'terminal:original']);
  terminal = true;
  events.length = 0;
  expect(await retireNativeRequest(ports, 'original')).toBe(true);
  expect(events).toEqual(['lock:original', 'terminal:original', 'remove:original']);
  ports.terminal = async () => {
    throw new Error('native evidence unavailable');
  };
  await expect(retireNativeRequest(ports, 'original')).rejects.toThrow('native evidence unavailable');
});

test('maintenance keeps signing CAS admission independent and routes workflow retention through the composed capability', async () => {
  let retiring: string | null = null;
  let pruneError: Error | undefined;
  const generations: number[] = [];
  const days: number[] = [];
  const maintenance = createRetentionMaintenance({
    signing: {
      async status() {
        return { generation: 7, retiring };
      },
      async prune({ expectedGeneration }) {
        generations.push(expectedGeneration);
        if (pruneError) throw pruneError;
      },
    },
    async retainWorkflowHistory(value) {
      days.push(value);
      return 2;
    },
  });
  expect(await maintenance.retireSigningKeys()).toBe(0);
  expect(generations).toEqual([]);
  retiring = 'original-kid';
  expect(await maintenance.retireSigningKeys()).toBe(1);
  expect(generations).toEqual([7]);
  pruneError = new SigningRotationPending();
  expect(await maintenance.retireSigningKeys()).toBe(0);
  pruneError = new Error('signing store unavailable');
  await expect(maintenance.retireSigningKeys()).rejects.toThrow('signing store unavailable');
  expect(await maintenance.retainWorkflowHistory(30)).toBe(2);
  expect(days).toEqual([30]);
});

test('expiry and cancellation preserve the saved frontier and prevent another copy or deletion', async () => {
  const f = fixture();
  let now = 100;
  const abort = new AbortController();
  const invocation = createAuthRetentionInvocation({ deadline: 200, signal: abort.signal, now: () => now });
  f.ports.scan.read = async (cursor) => ({
    cutoff: cursor.cutoff,
    examined: 1000,
    copies: [
      { workflowID: 'one', workflowName: 'accounts.registration' },
      { workflowID: 'two', workflowName: 'accounts.registration' },
    ],
    continuation: null,
    exhausted: true,
  });
  const reached: string[] = [];
  f.ports.retireCopy = async (id, received) => {
    expect(received).toBe(invocation);
    reached.push(id);
    await received.reserve('connect');
    now = 200;
    return true;
  };
  f.ports.deleteTechnical = async () => {
    throw new Error('unreached');
  };
  await expect(createWorkflowRetention(f.ports).page(30, invocation)).rejects.toThrow('deadline has expired');
  expect(reached).toEqual(['one']);
  expect(f.state.cursor).toEqual({ cutoff: 60 * 86400000, offset: 0 });
  expect(invocation.snapshot()).toMatchObject({ examined: 1000, copies: 1, dispatches: { 'close:connect': 1 } });
  now = 100;
  abort.abort(new Error('original caller cancelled'));
  await expect(invocation.reserve('commit')).rejects.toThrow('original caller cancelled');
  expect(invocation.snapshot().dispatches['close:commit']).toBeUndefined();
});
