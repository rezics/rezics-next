import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  commandExposure,
  loadExposure,
  parseExposureQuery,
  parseIntent,
  readExposureBound,
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
const document = {
  paths: {
    '/v1/collections': {
      get: { 'x-exposure': 'gate:collections', 'x-action': 'collection:list', operationId: 'collection.list' },
    },
  },
};
const managementPage = (
  exposureGroups: unknown[] = [row],
  next: unknown = 'signed_next',
  actions = { open: true, close: false },
) => ({
  viewer: { accountId: 'actual-reader-subject', clientId: 'exposure-management' },
  actions,
  exposureGroups,
  next,
});

// One small transport fixture for the delivered closed wire, independent of native authority proof.
function fixture() {
  const calls: URL[] = [];
  let current: unknown = managementPage();
  let managementStatus: 200 | 400 | 401 | 403 | 503 = 200;
  let discoveryMalformed = false;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push(url);
      expect(request.headers.get('authorization')).toBe('Bearer viewer');
      if (url.pathname === '/v1/openapi.json')
        return discoveryMalformed ? Response.json({ paths: { '/broken': { get: {} } } }) : Response.json(document);
      if (url.pathname === '/v1/platform/exposure/management')
        return managementStatus === 200
          ? Response.json(current)
          : Response.json(
              { code: managementStatus === 400 ? 'invalid_cursor' : 'forbidden' },
              { status: managementStatus },
            );
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
    setManagementStatus(status: 400 | 401 | 403 | 503) {
      managementStatus = status;
    },
    denyRead() {
      managementStatus = 403;
    },
    malformedDiscovery() {
      discoveryMalformed = true;
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
    discovery: { status: 'available', groups: ['collections'] },
    current: {
      status: 'available',
      viewer: { accountId: 'actual-reader-subject', clientId: 'exposure-management' },
      actions: { open: true, close: false },
      exposureGroups: [row],
      next: 'signed_next',
    },
  });
  expect(markup(first)).toContain('Public status: open');
  expect(markup(first)).toContain('aria-label="Open collections"');
  expect(markup(first)).not.toContain('aria-label="Close collections"');
  expect(markup(first)).toContain(at);
  expect(markup(first)).toContain('Next page');
  expect(markup(first)).not.toContain('Current public exposure data is unavailable');
  expect(native.calls.filter((url) => url.pathname.endsWith('/management'))).toHaveLength(1);
  native.setCurrent(managementPage([{ group: 'search', open: false, at }], null, { open: false, close: true }));
  const next = await loadExposure(native.client, 'Bearer viewer', { cursor: 'signed_next', limit: 1 });
  expect(native.calls.findLast((url) => url.pathname.endsWith('/management'))?.searchParams.get('cursor')).toBe(
    'signed_next',
  );
  expect(markup(next)).toContain('Public status: closed');
  expect(markup(next)).toContain('aria-label="Close search"');
  expect(markup(next)).not.toContain('aria-label="Open search"');
  expect(markup(next)).not.toContain('Next page');
  native.setCurrent(managementPage([{ group: 'search', open: false, at }], null, { open: false, close: false }));
  const readOnly = await loadExposure(native.client, 'Bearer viewer', { limit: 1 });
  expect(markup(readOnly)).toContain('Public status: closed');
  expect(markup(readOnly)).not.toContain('aria-label="Open search"');
  expect(markup(readOnly)).not.toContain('aria-label="Close search"');

  native.malformedDiscovery();
  const discoveryUnavailable = await loadExposure(native.client, 'Bearer viewer');
  expect(discoveryUnavailable.status).toBe('ready');
  expect(discoveryUnavailable.discovery.status).toBe('unavailable');
  expect(markup(discoveryUnavailable)).toContain('optional viewer-filtered operation catalogue is unavailable');
  expect(markup(discoveryUnavailable)).toContain('Public status: closed');

  native.setManagementStatus(403);
  const denied = await loadExposure(native.client, 'Bearer viewer');
  expect(denied.status).toBe('denied');
  expect(markup(denied)).not.toContain(at);
  expect(markup(denied)).not.toContain('search');
  expect(markup(denied)).toContain('Public status remains unknown');
});

test('closed current wire rejects excess rows malformed pages and selections without private observations', async () => {
  const native = fixture();
  const unavailable: CurrentExposure = { status: 'unavailable', missing: 'native-current-exposure-management-read' };
  for (const value of [
    managementPage([row, row], null),
    managementPage([{ ...row, at: 'yesterday' }], null),
    managementPage([{ ...row, private: true }], null),
    managementPage([row], '../cursor'),
    managementPage([], 'signed_next'),
    { ...managementPage([row], null), admitted: ['collections'] },
    { ...managementPage([row], null), viewer: { accountId: 'reader', clientId: 'client', email: 'private' } },
    { ...managementPage([row], null), actions: { open: true } },
  ]) {
    native.setCurrent(value);
    expect(await readCurrentExposure(native.client, 'Bearer viewer', { limit: 1 })).toEqual(unavailable);
  }
  for (const query of [{ cursor: '../cursor' }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { group: 'search' }])
    expect(() => parseExposureQuery(query)).toThrow();
  native.setCurrent(managementPage([], null));
  await readCurrentExposure(native.client, 'Bearer viewer');
  expect(native.calls.at(-1)?.searchParams.get('limit')).toBe('20');

  native.setManagementStatus(400);
  expect(await readCurrentExposure(native.client, 'Bearer viewer', { cursor: 'signed_next' })).toEqual({
    status: 'invalid-cursor',
  });
  expect((await loadExposure(native.client, 'Bearer viewer', { cursor: 'signed_next' })).status).toBe('invalid-cursor');
  native.setManagementStatus(401);
  expect(await readCurrentExposure(native.client, 'Bearer viewer')).toEqual({ status: 'signed-out' });
  native.setManagementStatus(403);
  expect(await readCurrentExposure(native.client, 'Bearer viewer')).toEqual({ status: 'denied' });
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
  native.setCurrent(managementPage([{ group: 'search', open: false, at }], null));
  await loadExposure(native.client, 'Bearer viewer', { cursor: 'signed_next', limit: 1 });
  await loadExposure(native.client, 'Bearer viewer');
  native.denyRead();
  await loadExposure(native.client, 'Bearer viewer');
  expect(controller.intent).toBe(original);
  expect(controller.outcome?.status).toBe('uncertain');
  expect(native.calls.filter((url) => url.pathname.endsWith(':open'))).toHaveLength(1);
});

test('production reader envelope binds the actual same prepared request and keeps a healthy null-CSRF reader', async () => {
  const request = new Request('https://site.test/en/platform/exposure');
  const observed: { prepared?: Request; credential?: Request; subject?: Request; authorization?: string } = {};
  const page: Page = {
    status: 'ready',
    discovery: { status: 'available', groups: ['collections'] },
    current: {
      status: 'available',
      viewer: { accountId: 'actual-reader-subject', clientId: 'exposure-management' },
      actions: { open: false, close: false },
      exposureGroups: [],
      next: null,
    },
  };
  const result = await readExposureBound(
    { limit: 1 },
    {
      prepare: async () => {
        observed.prepared = request;
        return request;
      },
      credential: (prepared) => {
        observed.credential = prepared;
        return (observed.authorization = 'Bearer actual-reader');
      },
      subject: (prepared) => {
        observed.subject = prepared;
        return 'actual-reader-subject';
      },
      configured: true,
      read: async (authorization, query) => {
        expect(authorization).toBe('Bearer actual-reader');
        expect(query).toEqual({ limit: 1 });
        return page;
      },
    },
  );
  expect(result).toEqual({ page, sessionSubject: 'actual-reader-subject' });
  expect(observed.prepared).toBe(request);
  expect(observed.credential).toBe(request);
  expect(observed.subject).toBe(request);
  expect(observed.authorization).toBe('Bearer actual-reader');
});
