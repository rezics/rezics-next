import { afterEach, expect, test } from 'bun:test';
import { createServer, type ServerResponse } from 'node:http';
import { StripeUnavailableError } from '../../src/commerce/model.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { deadlineFor, withRequestDeadline } from '../../src/request/deadline.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const identity = {
  id: 'cs_deadline',
  client_reference_id: 'order',
  metadata: { order_id: 'order' },
  livemode: false,
  mode: 'payment',
  payment_intent: null,
};
async function fixture(reply: (response: ServerResponse, send: number) => void, timeoutMs?: number) {
  let sends = 0;
  const server = createServer((_request, response) => reply(response, ++sends));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  const port = createStripePort({
    apiKey: 'sk_test_caller_deadline',
    managedPayments: false,
    host: '127.0.0.1',
    port: address.port,
    protocol: 'http',
    maxNetworkRetries: 1,
    clock: () => new Date(),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { port, sends: () => sends };
}
function json(response: ServerResponse) {
  response.end(JSON.stringify(identity));
}

test('an enclosing expired deadline refuses before any official SDK send', async () => {
  const f = await fixture(json); // Actual default maximum is 20 seconds.
  await withRequestDeadline(Date.now() - 1, async () => {
    await expect(f.port.readCheckoutLocator('cs_deadline')).rejects.toBeInstanceOf(StripeUnavailableError);
    await expect(f.port.findCheckoutSession('pi_deadline')).rejects.toBeInstanceOf(StripeUnavailableError);
  });
  expect(f.sends()).toBe(0);
  expect((await f.port.readCheckoutLocator('cs_deadline')).sessionId).toBe('cs_deadline');
});

test('the shorter enclosing caller wins over the default maximum and keeps SDK backoff charged until settlement', async () => {
  const f = await fixture((response, send) => {
    if (send > 8) return json(response);
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end('{"error":{"type":"api_error"}}');
  });
  const started = performance.now();
  const outcomes = await withRequestDeadline(Date.now() + 160, () =>
    Promise.all(Array.from({ length: 8 }, () => f.port.readCheckoutLocator('cs_deadline').catch((e: unknown) => e))),
  );
  expect(outcomes.every((e) => e instanceof StripeUnavailableError)).toBe(true);
  expect(performance.now() - started).toBeLessThan(450);
  expect(f.sends()).toBe(8);
  // Public completion must not free the eight underlying SDK retry promises.
  await expect(f.port.readCheckoutLocator('cs_deadline')).rejects.toBeInstanceOf(StripeUnavailableError);
  expect(f.sends()).toBe(8);
  await Bun.sleep(600);
  expect(f.sends()).toBe(8); // Their deferred retry callbacks refuse before a new network send.
  expect((await f.port.readCheckoutLocator('cs_deadline')).sessionId).toBe('cs_deadline');
  expect(f.sends()).toBe(9);
});

test('waits and successive operations share the enclosing budget; a shorter configured maximum also wins', async () => {
  const f = await fixture((response) => {
    setTimeout(() => json(response), 110);
  });
  const deadline = Date.now() + 180;
  await withRequestDeadline(deadline, async () => {
    await f.port.readCheckoutLocator('cs_deadline');
    await Bun.sleep(90);
    expect(deadlineFor(20_000)).toBe(deadline);
    await expect(f.port.readCheckoutLocator('cs_deadline')).rejects.toBeInstanceOf(StripeUnavailableError);
  });
  expect(f.sends()).toBe(1);
  const shorter = await fixture((response) => {
    setTimeout(() => json(response), 500);
  }, 70);
  const start = performance.now();
  await withRequestDeadline(Date.now() + 1000, async () => {
    await expect(shorter.port.readCheckoutLocator('cs_deadline')).rejects.toBeInstanceOf(StripeUnavailableError);
  });
  expect(performance.now() - start).toBeLessThan(300);
  // Let the owned SDK backoff settle before the next fixture uses the shared physical capacity.
  await Bun.sleep(600);
});
