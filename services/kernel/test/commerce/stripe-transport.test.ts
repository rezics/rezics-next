import { afterEach, expect, test } from 'bun:test';
import { createServer, type ServerResponse } from 'node:http';
import { StripeUnavailableError, type CheckoutRequest } from '../../src/commerce/model.ts';
import { createStripePort, type StripePortConfig } from '../../src/commerce/stripe.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

const BODY = 256 * 1024;
const clock = () => new Date('2026-10-25T12:00:00Z');
const request: CheckoutRequest = {
  orderId: 'transport-order', buyerAccountId: 'transport-buyer', title: 'A book', currency: 'usd',
  unitAmountMinor: 1200, taxCode: 'txcd_10302000', successUrl: 'https://example.test/success',
  cancelUrl: 'https://example.test/cancel', expiresAt: Math.floor(Date.now() / 1000) + 3600,
};
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const locator = { id: 'cs_transport', client_reference_id: 'transport-order', metadata: { order_id: 'transport-order' },
  livemode: false, mode: 'payment', payment_intent: null };

async function fixture(handler: (path: string, res: ServerResponse, send: number) => void | Promise<void>,
  options: Partial<StripePortConfig> = {}) {
  let sends = 0;
  let closed = 0;
  const server = createServer((req, res) => {
    sends++;
    res.on('close', () => { closed++; });
    void handler(req.url!, res, sends);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  const config = { apiKey: 'sk_test_private_transport', managedPayments: true, host: '127.0.0.1',
    protocol: 'http' as const, port: address.port, timeoutMs: 150, maxNetworkRetries: 0, clock, ...options };
  return { port: createStripePort(config), config, sends: () => sends, closed: () => closed };
}
function json(res: ServerResponse, value: unknown) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}
async function unavailable(operation: Promise<unknown>) {
  const start = performance.now();
  const error = await operation.then(() => null, (error: unknown) => error);
  expect(error).toBeInstanceOf(StripeUnavailableError);
  expect(String(error)).not.toContain('sk_test_private_transport');
  expect(performance.now() - start).toBeLessThan(2000);
}
// Wait on fixture events, never on a provider operation which is expected to be bounded by the adapter.
async function eventually(predicate: () => boolean) {
  const until = performance.now() + 1500;
  while (!predicate() && performance.now() < until) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test('official SDK accepts exactly the response byte limit and rejects one extra streamed byte', async () => {
  let length = BODY;
  let written = 0;
  const f = await fixture((_path, res) => {
    const prefix = JSON.stringify(locator);
    const bytes = prefix + ' '.repeat(length - prefix.length);
    res.writeHead(200, { 'content-type': 'application/json' });
    // No Content-Length: the body reader must account bytes, including whitespace.
    written += Buffer.byteLength(bytes);
    res.end(bytes);
  });
  expect(await f.port.readCheckoutLocator('cs_transport')).toMatchObject({ sessionId: 'cs_transport' });
  expect(written).toBe(BODY);
  length++;
  await unavailable(f.port.readCheckoutLocator('cs_transport'));
  expect(f.sends()).toBe(2);
  length = BODY;
  expect((await f.port.readCheckoutLocator('cs_transport')).sessionId).toBe('cs_transport');
});

test('oversized declared body and headers terminate before reading an endless response', async () => {
  for (const header of ['content-length', 'x-provider-padding']) {
    let produced = 0;
    const f = await fixture((_path, res) => {
      res.writeHead(200, { [header]: header === 'content-length' ? String(BODY + 1) : 'x'.repeat(BODY + 1) });
      res.flushHeaders();
      const timer = setInterval(() => { produced += 1024; res.write(Buffer.alloc(1024, 32)); }, 10);
      res.on('close', () => clearInterval(timer));
    });
    await unavailable(f.port.readCheckoutLocator('cs_transport'));
    await eventually(() => f.closed() === 1);
    expect(produced).toBeLessThan(BODY);
    expect(f.sends()).toBe(1);
  }
});

test('chunked overflow cancels the physical stream, stops production and permits a later request', async () => {
  let produced = 0;
  const f = await fixture((_path, res, send) => {
    if (send > 1) return json(res, locator);
    res.writeHead(200, { 'content-type': 'application/json' });
    const timer = setInterval(() => { produced += 16384; res.write(Buffer.alloc(16384, 32)); }, 1);
    res.on('close', () => clearInterval(timer));
  }, { timeoutMs: 1000 });
  await unavailable(f.port.readCheckoutLocator('cs_transport'));
  await eventually(() => f.closed() === 1);
  const stopped = produced;
  await Bun.sleep(25);
  expect(produced).toBe(stopped);
  expect(produced).toBeGreaterThan(BODY);
  expect(produced).toBeLessThan(BODY * 2);
  expect((await f.port.readCheckoutLocator('cs_transport')).sessionId).toBe('cs_transport');
});

test('one physical deadline covers stalled bodies and retry sleep without later sends', async () => {
  for (const retry of [false, true]) {
    const f = await fixture((_path, res) => {
      if (retry) { res.writeHead(503); res.end('{"error":{"type":"api_error"}}'); }
      else { res.writeHead(200); res.write('{'); }
    }, { maxNetworkRetries: 2, timeoutMs: 80 });
    await unavailable(f.port.readCheckoutLocator('cs_transport'));
    await eventually(() => f.closed() === 1);
    await Bun.sleep(600); // SDK's first retry wakes after the public deadline; it must not send.
    expect(f.sends()).toBe(1);
  }
});

test('SDK transient retries consume actual sends and the original create idempotency key', async () => {
  const f = await fixture((_path, res, send) => {
    if (send === 1) { res.writeHead(503); res.end('{"error":{"type":"api_error"}}'); }
    else json(res, { id: 'cs_transport', url: 'https://checkout.example.test/session', expires_at: request.expiresAt });
  }, { timeoutMs: 1800, maxNetworkRetries: 2 });
  expect((await f.port.createCheckoutSession(request, 'order:transport-order')).id).toBe('cs_transport');
  expect(f.sends()).toBe(2);
});

test('closed connections cannot escape the operation deadline even with SDK retries disabled', async () => {
  const f = await fixture((_path, res) => { res.destroy(); }, { timeoutMs: 80 });
  await unavailable(f.port.readCheckoutLocator('cs_transport'));
  await Bun.sleep(600);
  expect(f.sends()).toBe(1);
});

test('cancellation aborts a real stalled body and refuses a cancelled attempt before sending', async () => {
  const controller = new AbortController();
  const f = await fixture((_path, res) => { res.writeHead(200); res.write('{'); },
    { timeoutMs: 2000, signal: controller.signal });
  const pending = f.port.readCheckoutLocator('cs_transport');
  await eventually(() => f.sends() === 1);
  controller.abort(new Error('sk_test_private_transport'));
  await unavailable(pending);
  await eventually(() => f.closed() === 1);
  await unavailable(f.port.readCheckoutLocator('cs_transport'));
  expect(f.sends()).toBe(1);
  const later = await fixture((_path, res) => json(res, locator));
  expect((await later.port.readCheckoutLocator('cs_transport')).sessionId).toBe('cs_transport');
});

test('process capacity is shared across factories and excess unsettled operations are refused', async () => {
  let release = false;
  const f = await fixture((_path, res) => {
    if (release) return json(res, locator);
    res.writeHead(200); res.write('{');
  }, { timeoutMs: 2000 });
  const ports = Array.from({ length: 8 }, () => createStripePort(f.config));
  const pending = ports.map((port) => port.readCheckoutLocator('cs_transport').catch((error: unknown) => error));
  await eventually(() => f.sends() === 8);
  await unavailable(createStripePort(f.config).readCheckoutLocator('cs_transport'));
  expect(f.sends()).toBe(8);
  const outcomes = await Promise.all(pending);
  expect(outcomes.every((outcome) => outcome instanceof StripeUnavailableError)).toBe(true);
  await eventually(() => f.closed() === 8);
  release = true;
  expect((await f.port.readCheckoutLocator('cs_transport')).sessionId).toBe('cs_transport');
});

async function paidProxy(transform: (path: string, body: any) => void, options: Partial<StripePortConfig> = {}) {
  const fake = startFakeStripe();
  cleanups.push(() => fake.stop());
  const direct = createStripePort({ apiKey: 'sk_test_fixture_secret', managedPayments: true, host: '127.0.0.1',
    protocol: 'http', port: fake.port, maxNetworkRetries: 0, clock });
  const session = await direct.createCheckoutSession(request, 'order:transport-order');
  fake.pay(session.id);
  const f = await fixture(async (path, res) => {
    const response = await fetch(`http://127.0.0.1:${fake.port}${path}`);
    const body = await response.json();
    transform(path, body);
    json(res, body);
  }, { timeoutMs: 1500, ...options });
  return { ...f, fake, session, direct };
}

test('nested fee details and expanded transactions have exact shared boundaries', async () => {
  let fees = 256;
  const f = await paidProxy((path, body) => {
    if (!path.includes('/checkout/sessions/')) return;
    const balance = body.payment_intent.latest_charge.balance_transaction;
    balance.fee_details = Array.from({ length: fees }, () => ({ amount: 0, type: 'stripe_fee', description: null }));
  });
  expect((await f.port.readCheckout(f.session.id)).transactions[0]!.feeDetails).toHaveLength(256);
  fees++;
  await unavailable(f.port.readCheckout(f.session.id));
  fees = 1;
  expect((await f.port.readCheckout(f.session.id)).transactions).toHaveLength(1);
});

test('100 refunds, 10 disputes and 256 transactions pass; excess and nonadvancing pages fail visibly', async () => {
  let fault: 'none' | 'refund' | 'dispute' | 'transaction' | 'empty' | 'repeat' = 'none';
  const f = await paidProxy((path, body) => {
    if (path.startsWith('/v1/refunds') && fault === 'empty') { body.data = []; body.has_more = true; }
    if (path.startsWith('/v1/refunds') && fault === 'repeat') { body.has_more = true; }
    if (path.startsWith('/v1/refunds') && fault === 'refund') body.data.push({ ...body.data[0], id: 're_excess' });
    if (path.startsWith('/v1/disputes')) {
      if (fault === 'dispute') body.data.push({ ...body.data[0], id: 'du_excess' });
      // 1 charge + 100 refund balances + 155 dispute balances = 256.
      const balance = body.data[0].balance_transactions[0];
      body.data[0].balance_transactions = Array.from({ length: fault === 'transaction' ? 147 : 146 },
        (_, i) => ({ ...balance, id: `txn_boundary_${i}` }));
    }
  });
  for (let i = 0; i < 100; i++) f.fake.refund(f.session.id, { amount: 1 });
  for (let i = 0; i < 10; i++) f.fake.dispute(f.session.id, { amount: 1 });
  const snapshot = await f.port.readCheckout(f.session.id);
  expect(snapshot.refunds).toHaveLength(100);
  expect(snapshot.disputes).toHaveLength(10);
  expect(snapshot.transactions).toHaveLength(256);
  for (const next of ['refund', 'dispute', 'transaction', 'empty', 'repeat'] as const) {
    fault = next;
    await unavailable(f.port.readCheckout(f.session.id));
  }
});

test('unrelated provider history grows while selected reads, physical sends and response sizes stay fixed', async () => {
  const f = await paidProxy(() => {});
  let previous = 0;
  for (const scale of [1, 4, 16]) {
    for (let i = previous; i < scale; i++) {
      const other = await f.direct.createCheckoutSession(request, `unrelated:${i}`);
      f.fake.pay(other.id);
      f.fake.refund(other.id, { amount: 1 });
      f.fake.dispute(other.id, { amount: 1 });
    }
    previous = scale;
    const start = f.sends();
    expect((await f.port.readCheckout(f.session.id)).transactions).toHaveLength(1);
    expect(f.sends() - start).toBe(3);
    expect((await f.port.readCheckoutLocator(f.session.id)).paymentIntentId).toMatch(/^pi_/);
    expect(f.sends() - start).toBe(4);
  }
});
