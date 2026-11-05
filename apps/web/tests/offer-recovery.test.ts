import { expect, mock, spyOn, test } from 'bun:test';
import { createOfferRequest, decodeAcquisitionProblem } from '../src/checkout/offer-recovery';
import { acquisitionProblems } from '../src/kernel/fake/checkout';

const intent = {
  offerId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
  expectedOfferRevision: 7,
  idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
};

test('A buyer with an existing exact benefit or unresolved acquisition reaches its real access/order record without a second purchase or automatic new key', async () => {
  for (const problem of Object.values(acquisitionProblems)) {
    const calls: unknown[] = [];
    const submit = createOfferRequest(intent, async (input) => {
      calls.push(input);
      return Response.json(problem, { status: 409 });
    });
    expect(calls).toHaveLength(0);
    const result = await submit();
    expect(result).toEqual({ kind: 'existing', problem });
    expect(await submit()).toEqual(result);
    expect(calls).toEqual([intent]);
    expect(calls[0]).not.toBe(intent);
  }
});

test('an uncertain creation retries the original intent and revision; concurrent clicks never send twice', async () => {
  let finish!: (response: Response) => void;
  const calls: unknown[] = [];
  const submit = createOfferRequest(intent, async (input) => {
    calls.push(input);
    if (calls.length === 1) throw new Error('Response lost');
    return new Promise<Response>((resolve) => (finish = resolve));
  });
  expect(await submit()).toEqual({ kind: 'retry' });
  const pending = submit();
  expect(await submit()).toBeUndefined();
  finish(Response.json(acquisitionProblems.pending, { status: 409 }));
  expect((await pending)?.kind).toBe('existing');
  expect((await submit())?.kind).toBe('existing');
  expect(calls).toEqual([intent, intent]);
  expect(calls[0]).toBe(calls[1]);
});

test('price changes and unavailable targets remain distinct from acquisition recovery', async () => {
  for (const [code, kind] of [
    ['offer_revision_conflict', 'terms-changed'],
    ['offer_unavailable', 'unavailable'],
    ['unknown_conflict', 'retry'],
  ]) {
    let starts = 0;
    const submit = createOfferRequest(intent, async () => {
      starts++;
      return Response.json({ code }, { status: 409 });
    });
    expect(await submit()).toEqual({ kind });
    if (kind !== 'retry') {
      expect(await submit()).toEqual({ kind });
      expect(starts).toBe(1);
    }
  }
});

test('only actual not-applied acquisition Problems with native IDs can offer recovery navigation', async () => {
  const pending = acquisitionProblems.pending;
  for (const body of [
    { code: pending.code, orderId: pending.orderId },
    { ...pending, orderId: undefined },
    { ...pending, orderId: 'https://attacker.test/order' },
    { ...pending, orderId: '../other-buyer' },
    { ...pending, status: 200 },
    { ...pending, type: 'https://attacker.test/problems/acquisition_pending' },
    { ...pending, effect_status: 'applied' },
    { ...pending, effect_status: 'unknown' },
    { ...pending, code: 'benefit_already_owned', orderId: undefined },
    { ...acquisitionProblems.owned, entitlementId: 'invalid' },
  ]) {
    expect(decodeAcquisitionProblem(409, body)).toBeUndefined();
    const submit = createOfferRequest(intent, async () => Response.json(body, { status: 409 }));
    expect(await submit()).toEqual({ kind: 'retry' });
  }
  expect(decodeAcquisitionProblem(200, pending)).toBeUndefined();
  expect(decodeAcquisitionProblem(409, { ...pending, href: 'https://attacker.test' })).toEqual(pending);
  const { entitlementId: ignored, ...orderOnly } = acquisitionProblems.owned;
  expect(decodeAcquisitionProblem(409, orderOnly)).toEqual(orderOnly);
});

let pageRequest: Request;
mock.module('cloudflare:workers', () => ({ env: { KERNEL_ORIGIN: 'https://kernel.test' } }));
mock.module('@tanstack/react-start/server', () => ({ getRequest: () => pageRequest }));
const { startCheckout } = await import('../src/checkout/start');

test('the current-session BFF forwards sanitized own IDs from its single native order attempt and never accepts caller ownership hints', async () => {
  const calls: Request[] = [];
  const fetcher = spyOn(globalThis, 'fetch');
  fetcher.mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    return Response.json({ ...acquisitionProblems.owned, href: 'https://attacker.test' }, { status: 409 });
  });
  const request = (body: unknown, authorization: string | null = 'Bearer current-buyer') =>
    new Request('https://site.test/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body),
    });
  try {
    pageRequest = request(intent);
    const response = await startCheckout(pageRequest, {});
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(await response.json()).toEqual(acquisitionProblems.owned);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/orders');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer current-buyer');
    expect(calls[0]!.headers.get('idempotency-key')).toBe(intent.idempotencyKey);
    expect(await calls[0]!.json()).toEqual({ offerId: intent.offerId, expectedOfferRevision: 7 });
    pageRequest = request({ ...intent, entitlementId: acquisitionProblems.owned.entitlementId });
    await expect(startCheckout(pageRequest, {})).rejects.toMatchObject({ problem: { status: 400 } });
    pageRequest = request(intent, null);
    expect((await startCheckout(pageRequest, {})).status).toBe(401);
    expect(calls).toHaveLength(1);
  } finally {
    fetcher.mockRestore();
  }
});

test('retired fetch and decoded results cannot settle or replace an uncertain original offer intent', async () => {
  let current = false;
  let finish!: (body: unknown) => void;
  const source = { ...intent };
  const calls: unknown[] = [];
  const submit = createOfferRequest(source, async (input) => {
    calls.push(input);
    if (calls.length === 1)
      return Object.assign(new Response(), {
        json: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      });
    return Response.json(acquisitionProblems.pending, { status: 409 });
  });
  source.expectedOfferRevision = 99;
  source.idempotencyKey = 'replacement-key';
  expect(await submit(() => current)).toEqual({ kind: 'retry' });
  expect(calls).toHaveLength(0);
  current = true;
  const pending = submit(() => current);
  await Promise.resolve();
  expect(await submit(() => current)).toBeUndefined();
  current = false;
  finish({ checkoutUrl: 'https://checkout.stripe.com/retired' });
  expect(await pending).toEqual({ kind: 'retry' });
  current = true;
  expect((await submit(() => current))?.kind).toBe('existing');
  expect((await submit(() => current))?.kind).toBe('existing');
  expect(calls).toEqual([intent, intent]);
  expect(calls[0]).toBe(calls[1]);
  expect(Object.isFrozen(calls[0])).toBe(true);
});
