import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { Elysia } from 'elysia';
import { websocket } from 'elysia/websocket';
import { AdmissionDenied, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { PrivateSearchReceiptSession } from '../src/modules/contribution/private-delivery-fence.ts';
import { PRIVATE_SEARCH_OFFER_MS, PRIVATE_SEARCH_QUERY_SWEEP, PRIVATE_SEARCH_RECEIPT_MS,
  PRIVATE_SEARCH_SEND_WINDOW_MS } from '../src/modules/contribution/private-search-settlement.ts';
import { searchRoutes, type SearchRouteDependencies } from '../src/routes/search.ts';
import { author, contribution, fixture, root } from './search-private-fixture.ts';

const leaseId = '00000000-0000-4000-8000-0000000000c1';
const principal: VerifiedPrincipal = { issuer: 'https://account.test', subject: 'reader' };
const query = { type: 'private-contribution-query-v1', profile: 'private-contribution-phrase-v1',
  contribution, actingSubject: author, phrase: 'nebula phrase' };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('private socket test timed out')), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Access and settlement fakes that log each owner transition in order. */
function owners(run: ReturnType<typeof fixture>, deny = false) {
  const operations: string[] = [];
  const recorded: Array<() => void> = [];
  const record = (operation: string) => {
    operations.push(operation);
    for (const waiter of recorded.splice(0)) waiter();
  };
  const access = {
    admitContributionSearchRead: async () => {
      // No graph or Lucene read may precede the exact Access admission.
      record(`admit@${run.fuseki.queries.length}`);
      if (deny) throw new AdmissionDenied('no private grant');
      return { id: leaseId };
    },
    beginContributionSearchDelivery: async () => { record('begin'); return { id: leaseId }; },
    // Two position reads precede the arm; the final native check follows it.
    armContributionSearchSend: async () => { record(`arm@${run.fuseki.reads}`); },
    finishContributionSearchRead: async (_id: string, outcome: string) => { record(outcome); },
  };
  const settlement = {
    settle: async (_id: string, _token: string, outcome: 'withheld' | 'unconfirmed') => {
      record(outcome);
      return outcome;
    },
    sweep: async (limit: number) => {
      record(`sweep:${limit}`);
      return { unconfirmed: [], aborted: [] };
    },
  };
  async function reached(operation: string) {
    while (!operations.includes(operation)) {
      const next = deferred();
      recorded.push(next.resolve);
      await within(next.promise);
    }
  }
  return { operations, access, settlement, reached };
}

function server(run: ReturnType<typeof fixture>, owner: ReturnType<typeof owners>,
  receiptMs?: number, verify = async (request: Request) => {
    if (request.headers.get('authorization') !== 'Bearer reader') {
      throw new AccountAssertionDenied('missing token');
    }
    return principal;
  }) {
  const app = new Elysia().use(searchRoutes(run.fuseki, {
    environment: run.env, account: { verify }, access: {},
    privateSearch: { access: owner.access, settlement: owner.settlement, receiptMs },
  } as unknown as SearchRouteDependencies));
  app.listen({ hostname: '127.0.0.1', port: 0 });
  return { app, port: app.server!.port! };
}

type Frame = { opcode: number; payload: Buffer };

/** A raw RFC 6455 client whose TCP receive side can pause and half-close. */
async function rawClient(port: number) {
  const socket: Socket = createConnection({ host: '127.0.0.1', port });
  const frames: Frame[] = [];
  const waiting: Array<(frame: Frame) => void> = [];
  const ended = deferred<string>();
  const upgraded = deferred();
  let buffer = Buffer.alloc(0);
  let open = false;
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!open) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      expect(buffer.subarray(0, end).toString()).toContain('101 Switching Protocols');
      buffer = buffer.subarray(end + 4);
      open = true;
      upgraded.resolve();
    }
    while (buffer.length >= 2) {
      const width = buffer[1]! & 0x7f;
      const header = width === 126 ? 4 : width === 127 ? 10 : 2;
      if (buffer.length < header) return;
      const length = width === 126 ? buffer.readUInt16BE(2)
        : width === 127 ? Number(buffer.readBigUInt64BE(2)) : width;
      if (buffer.length < header + length) return;
      const frame = { opcode: buffer[0]! & 0x0f, payload: buffer.subarray(header, header + length) };
      buffer = buffer.subarray(header + length);
      const waiter = waiting.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    }
  });
  socket.on('end', () => ended.resolve('end'));
  socket.on('error', error => ended.resolve((error as NodeJS.ErrnoException).code ?? 'error'));
  await within(new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  }));
  socket.write(`GET /v1/private-queries HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer reader\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await within(upgraded.promise);
  return {
    socket,
    ended: ended.promise,
    nextFrame: () => within(frames.length ? Promise.resolve(frames.shift()!)
      : new Promise<Frame>(resolve => waiting.push(resolve))),
    text(value: string) {
      const payload = Buffer.from(value);
      const mask = randomBytes(4);
      const head = payload.length <= 125 ? 2 : 4;
      const frame = Buffer.alloc(head + 4 + payload.length);
      frame[0] = 0x81;
      frame[1] = 0x80 | (payload.length <= 125 ? payload.length : 126);
      if (head === 4) frame.writeUInt16BE(payload.length, 2);
      mask.copy(frame, head);
      for (let i = 0; i < payload.length; i++) frame[head + 4 + i] = payload[i]! ^ mask[i % 4]!;
      socket.write(frame);
    },
  };
}

function resultFrame(frame: Frame) {
  expect(frame.opcode).toBe(1);
  return JSON.parse(frame.payload.toString()) as { type: string; leaseId: string;
    receiptChallenge: string; result: { total: number; results: unknown[] } };
}

test('SEARCH12 settlement window exceeds every live session deadline with a pause margin', async () => {
  expect(PRIVATE_SEARCH_OFFER_MS + PRIVATE_SEARCH_RECEIPT_MS).toBeLessThanOrEqual(
    PRIVATE_SEARCH_SEND_WINDOW_MS / 2);
  const migration = await Bun.file(
    `${root}/services/main/migrations/access/160_search_send_settlement.sql`).text();
  expect(migration).toContain(`interval '${PRIVATE_SEARCH_SEND_WINDOW_MS / 1000} seconds'`);
  const settlement = await Bun.file(
    `${root}/services/main/src/modules/contribution/private-search-settlement.ts`).text();
  expect(settlement).toContain(`interval '${PRIVATE_SEARCH_SEND_WINDOW_MS / 1000} seconds'`);
});

test('SEARCH12 POST names the receipt-fenced socket once delivery owners exist', async () => {
  const run = fixture();
  const owner = owners(run);
  const { app } = server(run, owner);
  try {
    const response = await app.handle(new Request('http://localhost/v1/private-queries', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer reader' },
      body: JSON.stringify({ profile: query.profile, contribution, actingSubject: author,
        phrase: query.phrase }),
    }));
    expect(response.status).toBe(426);
    expect(response.headers.get('upgrade')).toBe('websocket');
    expect((await response.json()).code).toBe('private_search_socket_required');
    expect(owner.operations).toEqual([]);
    expect(run.fuseki.queries).toEqual([]);
  } finally {
    await app.stop();
    run.cleanup();
  }
});

test('SEARCH11/SEARCH12 socket: Account before upgrade, Access before match, arm before final check, exact receipt', async () => {
  const run = fixture();
  const owner = owners(run);
  const { app, port } = server(run, owner);
  const client = new WebSocket(`ws://127.0.0.1:${port}/v1/private-queries`,
    { headers: { authorization: 'Bearer reader' } } as unknown as string[]);
  const messages: string[] = [];
  const arrived = deferred();
  const closed = deferred<{ code: number; reason: string }>();
  client.onmessage = event => { messages.push(String(event.data)); arrived.resolve(); };
  client.onclose = event => closed.resolve({ code: event.code, reason: event.reason });
  try {
    await within(new Promise(resolve => { client.onopen = resolve; }));
    client.send(JSON.stringify(query));
    await within(arrived.promise);
    const frame = JSON.parse(messages[0]!) as ReturnType<typeof resultFrame>;
    expect(frame.type).toBe('private-contribution-result-v1');
    expect(frame.result).toMatchObject({ complete: true, total: 1 });
    expect(JSON.stringify(frame.result)).not.toMatch(/score|snippet|facet|population|Hidden nebula/);
    expect(owner.operations).toEqual([`sweep:${PRIVATE_SEARCH_QUERY_SWEEP}`, 'admit@0',
      'begin', 'arm@2']);
    expect(run.fuseki.reads).toBe(3);
    client.send(JSON.stringify({ type: 'private-contribution-receipt-v1', leaseId,
      receiptChallenge: '00'.repeat(32) }));
    client.send(JSON.stringify({ type: 'private-contribution-receipt-v1', leaseId,
      receiptChallenge: frame.receiptChallenge }));
    expect(await within(closed.promise)).toEqual({ code: 1000, reason: 'delivered' });
    expect(owner.operations.slice(4)).toEqual(['delivered']);
    expect(messages).toHaveLength(1);
  } finally {
    client.close();
    await app.stop();
    run.cleanup();
  }
});

test('SEARCH12 an unauthenticated upgrade is refused before sweep, Access or graph work', async () => {
  const run = fixture();
  const owner = owners(run);
  const { app, port } = server(run, owner);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/private-queries`, { headers: {
      upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13',
      'sec-websocket-key': randomBytes(16).toString('base64') } });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect((await response.json()).code).toBe('account_assertion_denied');
    expect(owner.operations).toEqual([]);
    expect(run.fuseki.queries).toEqual([]);
  } finally {
    await app.stop();
    run.cleanup();
  }
});

test('SEARCH11 a denied read returns one identical problem whether or not the hidden body matches', async () => {
  const problems: string[] = [];
  for (const hits of [true, false]) {
    const run = fixture();
    run.fuseki.hits = hits;
    const owner = owners(run, true);
    const { app, port } = server(run, owner);
    let client: Awaited<ReturnType<typeof rawClient>> | undefined;
    try {
      client = await rawClient(port);
      client.text(JSON.stringify(query));
      const problem = await client.nextFrame();
      const close = await client.nextFrame();
      expect(close.opcode).toBe(8);
      expect(close.payload.readUInt16BE(0)).toBe(4403);
      problems.push(problem.payload.toString());
      expect(owner.operations).toEqual([`sweep:${PRIVATE_SEARCH_QUERY_SWEEP}`, 'admit@0']);
      expect(run.fuseki.queries).toEqual([]);
    } finally {
      client?.socket.destroy();
      await app.stop();
      run.cleanup();
    }
  }
  expect(problems[0]).toBe(problems[1]!);
  expect(JSON.parse(problems[0]!)).toEqual({ type: 'problem', status: 403,
    code: 'authority_denied', title: 'Authority is not admitted' });
});

test('SEARCH12 a peer half-closing after the offer settles unconfirmed and can still read the frame', async () => {
  const run = fixture();
  const owner = owners(run);
  const { app, port } = server(run, owner);
  let client: Awaited<ReturnType<typeof rawClient>> | undefined;
  try {
    client = await rawClient(port);
    const armed = owner.reached('arm@2');
    client.text(JSON.stringify(query));
    await armed;
    client.socket.pause();
    // Let the final native check finish and the frame reach the kernel.
    while (run.fuseki.reads < 3) await Bun.sleep(5);
    await Bun.sleep(20);
    client.socket.end();
    await owner.reached('unconfirmed');
    expect(owner.operations.slice(-2)).toEqual(['arm@2', 'unconfirmed']);
    client.socket.resume();
    // Settlement records the process send boundary, not a recall.
    expect(resultFrame(await client.nextFrame()).result.total).toBe(1);
  } finally {
    client?.socket.destroy();
    await app.stop();
    run.cleanup();
  }
});

test('SEARCH12 a paused peer withholding its receipt is terminated at the deadline, then settled', async () => {
  const run = fixture();
  const owner = owners(run);
  const { app, port } = server(run, owner, 150);
  let client: Awaited<ReturnType<typeof rawClient>> | undefined;
  try {
    client = await rawClient(port);
    client.text(JSON.stringify(query));
    client.socket.pause();
    await owner.reached('unconfirmed');
    expect(owner.operations).toEqual([`sweep:${PRIVATE_SEARCH_QUERY_SWEEP}`, 'admit@0',
      'begin', 'arm@2', 'unconfirmed']);
    client.socket.resume();
    expect(resultFrame(await client.nextFrame()).result.total).toBe(1);
    // terminate() closed the server side; no close frame or receipt follows.
    expect(await within(client.ended)).toBe('end');
  } finally {
    client?.socket.destroy();
    await app.stop();
    run.cleanup();
  }
});

test('SEARCH12 a close during the post-arm native check offers nothing and withholds the row', async () => {
  const run = fixture();
  const owner = owners(run);
  const gate = deferred();
  const entered = deferred();
  run.fuseki.positionGate = async read => {
    if (read !== 3) return;
    entered.resolve();
    await gate.promise;
  };
  const { app, port } = server(run, owner);
  let client: Awaited<ReturnType<typeof rawClient>> | undefined;
  try {
    client = await rawClient(port);
    client.text(JSON.stringify(query));
    await within(entered.promise);
    client.socket.destroy();
    await Bun.sleep(50);
    expect(owner.operations.at(-1)).toBe('arm@2');
    gate.resolve();
    await owner.reached('withheld');
    expect(owner.operations.slice(-2)).toEqual(['arm@2', 'withheld']);
  } finally {
    client?.socket.destroy();
    await app.stop();
    run.cleanup();
  }
});

test('SEARCH12 a lost arm response is resolved by challenge digest, never left pending', async () => {
  for (const committed of [true, false]) {
    const outcomes: string[] = [];
    let armedToken = '';
    const session = new PrivateSearchReceiptSession({
      async armContributionSearchSend(_id: string, token: string) {
        if (committed) armedToken = token;
        throw new Error('owner response lost');
      },
      async finishContributionSearchRead(_id: string, outcome: string) { outcomes.push(outcome); },
    }, leaseId, { total: 1 }, undefined, { settlement: {
      async settle(_id: string, token: string, outcome: 'withheld' | 'unconfirmed') {
        if (token !== armedToken) return null;
        outcomes.push(outcome);
        return outcome;
      },
    } });
    let offered = false;
    await expect(session.send(() => { offered = true; return 1; }))
      .rejects.toThrow('owner response lost');
    expect(offered).toBe(false);
    expect(outcomes).toEqual([committed ? 'withheld' : 'aborted']);
    expect(await session.disconnect()).toBe('settled');
  }
});

test('SEARCH12 an arm that outlives the offer deadline withholds instead of sending late', async () => {
  const outcomes: string[] = [];
  const session = new PrivateSearchReceiptSession({
    async armContributionSearchSend() { await Bun.sleep(30); },
    async finishContributionSearchRead(_id: string, outcome: string) { outcomes.push(outcome); },
  }, leaseId, { total: 1 }, undefined, { offerWithinMs: 10, settlement: {
    async settle(_id: string, _token: string, outcome: 'withheld' | 'unconfirmed') {
      outcomes.push(outcome);
      return outcome;
    },
  } });
  let offered = false;
  await expect(session.send(() => { offered = true; return 1; }))
    .rejects.toThrow('offer deadline');
  expect(offered).toBe(false);
  expect(outcomes).toEqual(['withheld']);
});

test('SEARCH12 Bun terminate() drops only process-buffered bytes; kernel-buffered bytes stay readable', async () => {
  // Runtime evidence for the settlement boundary: cancellation after an offer
  // cannot recall bytes already handed to the kernel, so it is never an abort.
  for (const size of [65_536, 16 * 1_048_576]) {
    const opened = deferred<{ send(data: string): number; terminate(): void }>();
    const app = new Elysia().use(websocket({ sendPings: false })).ws('/probe', {
      open(ws) { opened.resolve(ws); }, message() {},
    });
    app.listen({ hostname: '127.0.0.1', port: 0 });
    const socket = createConnection({ host: '127.0.0.1', port: app.server!.port! });
    let received = -1;
    socket.on('data', chunk => {
      if (received < 0) {
        const end = chunk.indexOf('\r\n\r\n');
        if (end >= 0) received = chunk.length - end - 4;
      } else received += chunk.length;
    });
    const ended = new Promise<string>(resolve => {
      socket.on('end', () => resolve('end'));
      socket.on('error', error => resolve((error as NodeJS.ErrnoException).code ?? 'error'));
    });
    try {
      await within(new Promise(resolve => socket.once('connect', resolve)));
      socket.write(`GET /probe HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      const ws = await within(opened.promise);
      while (received < 0) await Bun.sleep(5);
      socket.pause();
      const status = ws.send('x'.repeat(size));
      await Bun.sleep(100);
      ws.terminate();
      await Bun.sleep(100);
      socket.resume();
      expect(await within(ended)).toBe('end');
      const frameLength = size + (size > 65_535 ? 10 : 4);
      if (status > 0) expect(received).toBe(frameLength);
      else {
        expect(status).toBe(-1);
        expect(received).toBeGreaterThan(0);
        expect(received).toBeLessThan(frameLength);
      }
    } finally {
      socket.destroy();
      await app.stop();
    }
  }
});
