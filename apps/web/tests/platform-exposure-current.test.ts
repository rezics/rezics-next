import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  commandExposure,
  globalContext,
  loadExposure,
  parseExposureQuery,
  parseIntent,
  readCurrentExposure,
  type CurrentExposure,
  type Page,
} from '../src/platform/exposure/data';
import { PlatformExposurePage } from '../src/platform/exposure/page';
import { ExposureOperation } from '../src/platform/exposure/operation';

const at = '2026-10-31T00:00:00.123456Z';
const row = { group: 'collections', open: true, at };
const operation = parseIntent({
  group: row.group,
  action: 'open',
  key: 'd42544e2-c78d-4a2a-8e5b-781a913e3920',
  body: {},
});
const metadata = {
  'x-exposure': 'public',
  'x-authority-resource-types': ['semantic.context'],
  'x-authority-resource-id': globalContext.id,
};
const document = {
  paths: {
    '/v1/platform/exposure/management': {
      get: { 'x-exposure': 'public', 'x-action': 'exposure:manage_read', operationId: 'exposure.read_management' },
    },
    '/v1/platform/exposure/{group}:open': {
      post: { ...metadata, 'x-action': 'exposure:open', operationId: 'exposure.open' },
    },
  },
};

// One small transport fixture for the delivered closed wire, independent of native authority proof.
function fixture() {
  const calls: URL[] = [];
  let current: unknown = { exposureGroups: [row], next: 'signed_next' };
  let offered = true;
  let denied = false;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push(url);
      expect(request.headers.get('authorization')).toBe('Bearer viewer');
      if (url.pathname === '/v1/openapi.json') return Response.json(document);
      if (url.pathname === '/v1/viewerActions')
        return Response.json({
          resources: [
            {
              type: 'semantic.context',
              id: globalContext.id,
              viewerActions: offered ? [{ action: 'exposure:open', operations: ['exposure.open'] }] : [],
            },
          ],
        });
      if (url.pathname === '/v1/platform/exposure/management')
        return denied ? Response.json({ code: 'forbidden' }, { status: 403 }) : Response.json(current);
      if (url.pathname.endsWith(':open')) throw new Error('lost response');
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as typeof fetch,
  });
  return {
    client,
    calls,
    setCurrent(value: unknown) {
      current = value;
    },
    revoke() {
      offered = false;
    },
    denyRead() {
      denied = true;
    },
  };
}

const markup = (initial: Page) =>
  renderToStaticMarkup(
    createElement(PlatformExposurePage, {
      initial,
      io: { read: async () => initial, change: async () => ({ status: 'not-sent', current: initial }) },
    }),
  );

test('delivered configuration shows actual open closed and native at with explicit bounded continuation independent of actions', async () => {
  const native = fixture();
  const first = await loadExposure(native.client, 'Bearer viewer', { limit: 1 });
  expect(first).toMatchObject({
    status: 'ready',
    groups: [],
    inventory: 'visible-only',
    current: { status: 'available', exposureGroups: [row], next: 'signed_next' },
  });
  expect(markup(first)).toContain('Public status: open');
  expect(markup(first)).toContain(at);
  expect(markup(first)).toContain('Next page');
  expect(markup(first)).not.toContain('Current public exposure data is unavailable');
  expect(native.calls.filter((url) => url.pathname.endsWith('/management'))).toHaveLength(1);
  native.setCurrent({ exposureGroups: [{ group: 'search', open: false, at }], next: null });
  const next = await loadExposure(native.client, 'Bearer viewer', { cursor: 'signed_next', limit: 1 });
  expect(native.calls.findLast((url) => url.pathname.endsWith('/management'))?.searchParams.get('cursor')).toBe(
    'signed_next',
  );
  expect(markup(next)).toContain('Public status: closed');
  expect(markup(next)).not.toContain('Next page');
  native.revoke();
  const readOnly = await loadExposure(native.client, 'Bearer viewer', { limit: 1 });
  expect(markup(readOnly)).toContain('Public status: closed');
  expect(markup(readOnly)).not.toContain('aria-label="Open search"');
  native.denyRead();
  const denied = await loadExposure(native.client, 'Bearer viewer');
  expect(markup(denied)).not.toContain(at);
  expect(markup(denied)).not.toContain('search');
});

test('closed current wire rejects excess rows malformed pages and selections without private observations', async () => {
  const native = fixture();
  const unavailable: CurrentExposure = { status: 'unavailable', missing: 'native-current-exposure-management-read' };
  for (const value of [
    { exposureGroups: [row, row], next: null },
    { exposureGroups: [{ ...row, at: 'yesterday' }], next: null },
    { exposureGroups: [{ ...row, private: true }], next: null },
    { exposureGroups: [row], next: '../cursor' },
    { exposureGroups: [], next: 'signed_next' },
    { exposureGroups: [row], next: null, admitted: ['collections'] },
  ]) {
    native.setCurrent(value);
    expect(await readCurrentExposure(native.client, 'Bearer viewer', { limit: 1 })).toEqual(unavailable);
  }
  for (const query of [{ cursor: '../cursor' }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { group: 'search' }])
    expect(() => parseExposureQuery(query)).toThrow();
  native.setCurrent({ exposureGroups: [], next: null });
  await readCurrentExposure(native.client, 'Bearer viewer');
  expect(native.calls.at(-1)?.searchParams.get('limit')).toBe('20');
});

test('paging reload and denied current reads preserve the original uncertain operation without automatic mutation', async () => {
  const native = fixture();
  const controller = new ExposureOperation();
  controller.review(operation);
  const original = controller.intent;
  const outcome = await controller.send((intent) =>
    commandExposure(native.client, 'Bearer viewer', intent, { limit: 1 }),
  );
  expect(outcome?.status).toBe('uncertain');
  native.setCurrent({ exposureGroups: [{ group: 'search', open: false, at }], next: null });
  await loadExposure(native.client, 'Bearer viewer', { cursor: 'signed_next', limit: 1 });
  await loadExposure(native.client, 'Bearer viewer');
  native.denyRead();
  await loadExposure(native.client, 'Bearer viewer');
  expect(controller.intent).toBe(original);
  expect(controller.outcome?.status).toBe('uncertain');
  expect(native.calls.filter((url) => url.pathname.endsWith(':open'))).toHaveLength(1);
});
