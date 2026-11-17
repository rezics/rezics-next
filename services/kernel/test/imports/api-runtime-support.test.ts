import { expect, test } from 'bun:test';
import { importApiRequest, settleApiRuntime } from './api-runtime-support.ts';

test('native command requests seal the body key and bytes for retries', async () => {
  const body = { key: 'original-key', tier: 'trusted' };
  const bytes = JSON.stringify(body);
  const request = importApiRequest('https://kernel.test', '/v1/accounts/account:setRateTier', body, 'fixture-bearer');
  body.key = 'changed-key';
  body.tier = 'ordinary';
  expect(request.headers.get('idempotency-key')).toBe(JSON.stringify('original-key'));
  expect(await request.clone().text()).toBe(bytes);
  expect(await request.clone().text()).toBe(bytes);
});

test('native negative controls retain an explicit mismatched header key', async () => {
  const request = importApiRequest('https://kernel.test', '/command', { key: 'body-key' }, undefined, 'header-key');
  expect(request.headers.get('idempotency-key')).toBe(JSON.stringify('header-key'));
  expect(await request.json()).toEqual({ key: 'body-key' });
});

test('native fixture cleanup preserves the primary failure and cleanup failure', async () => {
  const primary = new Error('native assertion');
  const cleanup = new DOMException('shutdown timed out', 'TimeoutError');
  const error = await settleApiRuntime(Promise.reject(cleanup), { error: primary }).catch((failure) => failure);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.cause).toBe(primary);
  expect(error.errors).toEqual([primary, cleanup]);
});
