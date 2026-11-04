import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  commandExposure,
  loadExposure,
  parseDiscovery,
  parseIntent,
  validGroup,
  type Page,
} from '../src/platform/exposure/data';
import { ExposureOperation } from '../src/platform/exposure/operation';
import { PlatformExposurePage } from '../src/platform/exposure/page';

const key = 'd42544e2-c78d-4a2a-8e5b-781a913e3920';
const intent = (action: 'open' | 'close' = 'open') => parseIntent({ group: 'collections', action, key, body: {} });
// A local transport fixture, not a recorded native permission or installed Global registry claim.
function document() {
  return {
    paths: {
      '/v1/collections': {
        get: { operationId: 'collection.list', 'x-action': 'collection:list', 'x-exposure': 'gate:collections' },
      },
      ...Object.fromEntries(
        ['open', 'close'].map((action) => [
          `/v1/platform/exposure/{group}:${action}`,
          {
            post: {
              operationId: `exposure.${action}`,
              'x-action': `exposure:${action}`,
              'x-exposure': 'public',
            },
          },
        ]),
      ),
    },
  };
}
function fixture(
  options: { offered?: string[]; changed?: boolean; lose?: boolean; managementUnavailable?: boolean } = {},
) {
  const calls: { path: string; method: string; headers: Headers; body: unknown }[] = [];
  let offered = options.offered ?? ['open', 'close'];
  const current = {
    viewer: { accountId: 'viewer', clientId: 'exposure-management' },
    actions: { open: offered.includes('open'), close: offered.includes('close') },
    exposureGroups: [{ group: 'collections', open: false, at: '2026-10-31T00:00:00.123456Z' }],
    next: null,
  };
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? await request.json() : undefined;
      calls.push({ path, method: request.method, headers: request.headers, body });
      if (path === '/v1/openapi.json') return Response.json(document());
      if (path === '/v1/platform/exposure/management')
        return options.managementUnavailable
          ? Response.json({ code: 'dependency_unavailable' }, { status: 503 })
          : Response.json({
              ...current,
              actions: { open: offered.includes('open'), close: offered.includes('close') },
            });
      if (/^\/v1\/platform\/exposure\/collections:(open|close)$/.test(path)) {
        if (options.lose) throw new Error('lost response');
        return Response.json({
          exposure: { group: 'collections', open: path.endsWith(':open'), changed: options.changed ?? true },
        });
      }
      throw new Error(`Unexpected fixture request: ${path}`);
    }) as typeof fetch,
  });
  return {
    client,
    calls,
    revoke: () => {
      offered = [];
    },
  };
}

test('Manage existing platform exposure data through native open and close actions preserves exact current native authority target privacy and immutable operation readback', async () => {
  for (const action of ['open', 'close'] as const) {
    const native = fixture({ changed: false });
    const operation = intent(action);
    const outcome = await commandExposure(native.client, 'Bearer viewer', operation);
    expect(outcome.status).toBe('recorded');
    if (outcome.status !== 'recorded' || outcome.current.status !== 'ready') throw new Error('Missing command result');
    expect(outcome.receipt).toEqual({ group: 'collections', open: action === 'open', changed: false });
    expect(outcome.current.current.actions).toEqual({ open: true, close: true });
    const write = native.calls.find((call) => call.path.endsWith(`:${action}`))!;
    expect(write.method).toBe('POST');
    expect(write.body).toEqual({});
    expect(write.headers.get('idempotency-key')).toBe(key);
    expect(native.calls.every((call) => call.headers.get('authorization') === 'Bearer viewer')).toBe(true);
    expect(native.calls.filter((call) => call.path === '/v1/platform/exposure/management')).toHaveLength(2);
    expect(native.calls.some((call) => call.path === '/v1/openapi.json')).toBe(true);
    native.revoke();
    const deniedReplay = await commandExposure(native.client, 'Bearer viewer', operation);
    expect(deniedReplay.status).toBe('not-sent');
    expect(native.calls.filter((call) => call.path.endsWith(`:${action}`))).toHaveLength(1);
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.body)).toBe(true);
  }
});

test('viewer-filtered operation declarations and visible groups cannot confer native mutation advice', async () => {
  const native = fixture({ offered: [] });
  const page = await loadExposure(native.client, 'Bearer viewer');
  expect(page).toMatchObject({
    status: 'ready',
    discovery: { status: 'available', groups: ['collections'] },
    current: { status: 'available', actions: { open: false, close: false } },
  });
  expect((await commandExposure(native.client, 'Bearer viewer', intent())).status).toBe('not-sent');
  expect(
    native.calls.every((call) => ['/v1/openapi.json', '/v1/platform/exposure/management'].includes(call.path)),
  ).toBe(true);
  const gateHolder = fixture({ offered: ['gate:any', 'gate:collections'] });
  expect((await commandExposure(gateHolder.client, 'Bearer viewer', intent())).status).toBe('not-sent');
  expect(gateHolder.calls.some((call) => call.path.endsWith(':open'))).toBe(false);
});

test('strict native installed groups and finite inventory reject invented selections and malformed operations', async () => {
  for (const group of [
    'any',
    'open',
    'close',
    'Collections',
    '../collections',
    'a-b',
    'a1',
    'a'.repeat(64),
    'collections\n',
  ]) {
    expect(validGroup(group)).toBe(false);
    expect(() => parseIntent({ group, action: 'open', key, body: {} })).toThrow();
  }
  expect(() => parseIntent({ ...intent(), body: { open: true } })).toThrow();
  expect(() => parseIntent({ ...intent(), key: 'reused' })).toThrow();
  expect(() => parseIntent({ ...intent(), principal: 'other' })).toThrow();
  const native = fixture();
  expect(
    (await commandExposure(native.client, 'Bearer viewer', parseIntent({ ...intent(), group: 'not_installed' })))
      .status,
  ).toBe('not-sent');
  expect(parseDiscovery({ admitted: ['collections'] })).toBeNull();
  expect(
    parseDiscovery({ paths: Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`/${i}`, {}])) }),
  ).toBeNull();
});

test('lost response preserves one frozen operation; replay and denial never create a second effect or current state', async () => {
  const native = fixture({ lose: true });
  const controller = new ExposureOperation();
  expect(controller.review(intent())).toBe(true);
  const original = controller.intent;
  const send = () => controller.send((operation) => commandExposure(native.client, 'Bearer viewer', operation));
  expect((await send())?.status).toBe('uncertain');
  expect(controller.cancel()).toBe(false);
  expect(controller.review(intent('close'))).toBe(false);
  expect((await send())?.status).toBe('uncertain');
  expect(controller.intent).toBe(original);
  const writes = native.calls.filter((call) => call.path.endsWith(':open'));
  expect(writes).toHaveLength(2);
  expect(writes.map((call) => [call.path, call.headers.get('idempotency-key'), call.body])).toEqual([
    ['/v1/platform/exposure/collections:open', key, {}],
    ['/v1/platform/exposure/collections:open', key, {}],
  ]);
  native.revoke();
  expect((await send())?.status).toBe('uncertain');
  expect(controller.intent).toBe(original);
  expect(native.calls.filter((call) => call.path.endsWith(':open'))).toHaveLength(2);
});

test('read failures are unavailable and the real closed page offers no mutation controls or admission-as-state claim', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async () => new Response('offline', { status: 503 })) as typeof fetch,
  });
  expect(await loadExposure(client, 'Bearer viewer')).toEqual({
    status: 'unavailable',
    discovery: { status: 'unavailable' },
  });
  const native = fixture({ managementUnavailable: true });
  const initial: Page = await loadExposure(native.client, 'Bearer viewer');
  const markup = renderToStaticMarkup(
    createElement(PlatformExposurePage, {
      initial,
      io: {
        read: () => loadExposure(native.client, 'Bearer viewer'),
        change: (operation) => commandExposure(native.client, 'Bearer viewer', operation),
      },
    }),
  );
  expect(markup).toContain('Public status: unknown');
  expect(markup).toContain('Current platform exposure data could not be loaded');
  expect(markup).toContain('These are groups from your visible catalogue');
  expect(markup).not.toContain('aria-label="Open collections"');
  expect(markup).not.toContain('aria-label="Close collections"');
});
