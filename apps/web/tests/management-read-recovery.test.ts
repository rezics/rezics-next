import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadDetail, loadInventory, loadOrganizationsAvailable } from '../src/accounts/management/data';
import { ManagedAccountsPage } from '../src/accounts/management/pages';
import { detailExample, inventoryExample, organization } from '../src/accounts/management/story-api';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

afterEach(() => mock.restore());
const schedule = globalThis.setTimeout;
function fastDeadlines() {
  return spyOn(globalThis, 'setTimeout').mockImplementation(((run, _delay, ...args) =>
    schedule(run, 0, ...args)) as typeof setTimeout);
}

test('initial inventory, pagination and selected detail recover from stalled headers or bodies with the same request', async () => {
  const timer = fastDeadlines();
  for (const selected of ['initial', 'page', 'detail'] as const)
    for (const body of [false, true]) {
      const requests: Request[] = [];
      let retry = false;
      const value = selected === 'detail' ? detailExample(organization.id) : inventoryExample();
      const client = createKernelClient('https://kernel.test', {
        fetch: (async (input, init) => {
          requests.push(new Request(input, init));
          if (retry) return Response.json(value);
          return body ? new Response(new ReadableStream()) : new Promise<Response>(() => {});
        }) as typeof fetch,
      });
      const read = () =>
        selected === 'detail'
          ? loadDetail(client, 'Bearer viewer', organization.id, { membersCursor: 'member-page' })
          : loadInventory(
              client,
              'Bearer viewer',
              selected === 'page' ? { organizationsCursor: 'org-page', operatorsCursor: 'operator-page' } : {},
            );
      expect(await read()).toEqual({ state: 'unavailable' });
      expect(requests[0]!.signal.aborted).toBe(true);
      retry = true;
      expect(await read()).toEqual({ state: 'ready', value });
      expect(requests[1]!.url).toBe(requests[0]!.url);
      expect(
        requests.every(
          (request) => request.method === 'GET' && request.headers.get('authorization') === 'Bearer viewer',
        ),
      ).toBe(true);
    }
  expect(timer.mock.calls.every((call) => call[1] === 10_000)).toBe(true);
});

test('caller cancellation retires a read, removes its listener and prevents dispatch for an already retired caller', async () => {
  const caller = new AbortController();
  const remove = spyOn(caller.signal, 'removeEventListener');
  const clear = spyOn(globalThis, 'clearTimeout');
  let transport: AbortSignal | undefined;
  let finish!: (response: Response) => void;
  const fetcher = mock((_input: unknown, init?: RequestInit) => {
    transport = init?.signal ?? undefined;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const client = createKernelClient('https://kernel.test', { fetch: fetcher as typeof fetch });
  const pending = loadDetail(client, 'Bearer viewer', organization.id, {}, caller.signal);
  caller.abort();
  expect(await pending).toEqual({ state: 'unavailable' });
  expect(transport?.aborted).toBe(true);
  finish(Response.json(detailExample(organization.id)));
  expect(await loadInventory(client, 'Bearer viewer', {}, caller.signal)).toEqual({ state: 'unavailable' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(clear).toHaveBeenCalledTimes(2);
});

test('stalled optional discovery preserves inventory without offering organization creation in all locales', async () => {
  const timer = fastDeadlines();
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input) =>
      String(input).includes('/exposure')
        ? new Response(new ReadableStream())
        : Response.json(inventoryExample())) as typeof fetch,
  });
  const page = await loadInventory(client, 'Bearer viewer', {});
  const organizationsAvailable = await loadOrganizationsAvailable(client, 'Bearer viewer');
  expect(page.state).toBe('ready');
  expect(organizationsAvailable).toBeNull();
  expect(timer.mock.calls.map((call) => call[1])).toEqual([10_000, 2_000]);
  const previous = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const render = (value: Parameters<typeof ManagedAccountsPage>[0]['page']) =>
        renderToStaticMarkup(createElement(ManagedAccountsPage, { page: value, retry() {} }));
      const html = render({ ...page, issuer: 'https://auth.test', organizationsAvailable });
      expect(html).toContain('Atlas Editors');
      expect(html).not.toContain('https://auth.test/organizations/new');
      expect(render({ state: 'unavailable' })).toContain(m.managed_refresh());
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});
