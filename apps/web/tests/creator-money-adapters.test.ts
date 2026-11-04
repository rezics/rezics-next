import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  createNativeMoneySchemaApi,
  isMoneyUnit,
  recordedMoneyUnit,
} from '../src/checkout/money-schema';
import { configuredPriceExample, creatorOfferFixture, recordedStripeUnit } from '../src/kernel/fake/creator-offers';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test'),
  setResponseHeader: () => {},
}));
const { createNativeCreatorOffersCaller } = await import('../src/checkout/creator-offers');

test('the served money and owned-list adapters use the actual generated routes with the current credential and no-store', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      return new URL(call.url).pathname === '/v1/commerceMoney'
        ? Response.json(configuredPriceExample)
        : Response.json({ offers: [creatorOfferFixture], next: null });
    }) as typeof fetch,
  });
  const authorization = 'Bearer current-seller';
  expect(await createNativeMoneySchemaApi(client).read(authorization)).toEqual({
    kind: 'ready',
    schema: configuredPriceExample,
  });
  const page = await createNativeCreatorOffersCaller(client).get({
    headers: { authorization },
    query: { limit: 20, cursor: 'native-signed-cursor' },
  });
  expect(page).toEqual({ status: 200, data: { offers: [creatorOfferFixture], next: null } });
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/commerceMoney', '/v1/offers']);
  expect(new URL(calls[1]!.url).searchParams.get('cursor')).toBe('native-signed-cursor');
  expect(new URL(calls[1]!.url).searchParams.get('limit')).toBe('20');
  expect(calls.every((call) => call.headers.get('authorization') === authorization && call.cache === 'no-store')).toBe(
    true,
  );
  expect(calls.every((call) => call.method === 'GET')).toBe(true);
});

test('absent, rejected and malformed money facts stay unavailable rather than falling back to Intl or enabling currencies', async () => {
  expect(await createNativeMoneySchemaApi().read('Bearer seller')).toEqual({ kind: 'unavailable' });
  for (const response of [
    () => Response.json({ code: 'dependency_unavailable' }, { status: 503 }),
    () => Response.json({ ...configuredPriceExample, qualified: true }),
    () => Response.json({ ...configuredPriceExample, configuredSaleCurrencies: [{ currency: 'jpy' }] }),
  ]) {
    const client = createKernelClient('https://kernel.test', { fetch: (async () => response()) as typeof fetch });
    expect(await createNativeMoneySchemaApi(client).read('Bearer seller')).toEqual({ kind: 'unavailable' });
  }
});

test('Web reads the response envelope while native-style values stay bare, exact and unknown when unsupported', () => {
  expect(isMoneyUnit(recordedStripeUnit)).toBe(true);
  expect(isMoneyUnit({ ...recordedStripeUnit, extra: true })).toBe(false);
  expect(recordedMoneyUnit({ moneyUnit: recordedStripeUnit })).toEqual(recordedStripeUnit);
  expect(recordedMoneyUnit(recordedStripeUnit)).toBeNull();
  expect(recordedMoneyUnit({ moneyUnit: { ...recordedStripeUnit, factsVersion: 'future-version' } })).toBeNull();
});
