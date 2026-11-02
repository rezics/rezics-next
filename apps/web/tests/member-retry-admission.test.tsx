import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import { createKernelClient } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT, planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { OverviewValue, Section } from '../src/features/pages/overview';
import { readMemberList, type MemberListRequest } from '../src/features/pages/member-list-query';
import {
  admitMemberRetry,
  admitMemberRetryAfter,
  memberRetryAt,
} from '../src/features/pages/member-retry-admission';
import { m } from '../src/paraglide/messages.js';

const subject = '00000000-0000-8000-8000-000000000001';
const document: CompositionDocument = {
  root: { props: {} },
  content: [
    { type: 'Members', props: { id: 'other', title: {}, source: { kind: 'everything' }, limit: 12, paged: true } },
    {
      type: 'Members',
      props: {
        id: 'members',
        title: {},
        source: { kind: 'collection', id: subject },
        filter: 'type = Book',
        limit: 24,
        paged: true,
      },
    },
  ],
};
const continuation = { node: 'members', cursor: 'opaque:next/==' };
const request: MemberListRequest = {
  target: { subject },
  locale: 'en',
  ...continuation,
  expectedReader: null,
  representation: { context: PAGE_GLOBAL_CONTEXT, population: 'global' },
};
const body = { members: [{ subjectId: subject, labels: { en: 'Snow Country' } }], next: continuation.cursor };
const read = {
  kind: 'members' as const,
  source: { kind: 'collection' as const, id: subject },
  filter: 'type = Book',
  sort: 'id',
  limit: 12,
  cursor: continuation.cursor,
};

async function nativeRead(
  status: number,
  headers?: HeadersInit,
  leaf?: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const page = {
    subject,
    template: { scope: 'type', key: 'schema:Person' },
    document,
    reads: {} as Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>,
  };
  const plan = planReads(platformRegistry, document, { subject, continuation });
  page.reads = Object.fromEntries(
    Object.keys(plan.reads).map((key) => [
      key,
      leaf?.[key] ?? (key === plan.nodes.members ? { status: 200, body } : { status: 200, body: { members: [] } }),
    ]),
  );
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async () => Response.json(page, { status, headers }),
  });
  return readMemberList(client, request);
}

test('outer and selected-leaf Retry-After are admitted; unrelated leaves and malformed hints are not', async () => {
  expect(admitMemberRetryAfter({ 'retry-after': '30' }, 1_000)).toBe('30');
  expect(memberRetryAt('30', 1_000)).toBe(31_000);
  expect(admitMemberRetry(31_000, 30_999)).toBe(false);
  expect(admitMemberRetry(31_000, 31_000)).toBe(true);
  expect(await nativeRead(429, { 'retry-after': '30', 'x-other': 'drop' })).toEqual({
    ok: false,
    status: 429,
    retryAfter: '30',
  });
  expect(await nativeRead(503, { 'retry-after': 'tomorrow' })).toEqual({ ok: false, status: 503 });
  const plan = planReads(platformRegistry, document, { subject, continuation });
  const members = plan.nodes.members!;
  const other = plan.nodes.other!;
  expect(
    await nativeRead(200, undefined, {
      [members]: { status: 429, headers: { 'retry-after': '12' } },
      [other]: { status: 503, headers: { 'retry-after': '99' } },
    }),
  ).toEqual({ ok: false, status: 429, retryAfter: '12' });
  expect(
    await nativeRead(200, undefined, {
      [members]: { status: 429 },
      [other]: { status: 503, headers: { 'retry-after': '99' } },
    }),
  ).toEqual({ ok: false, status: 429 });
});

test('Retry waits for the captured instant, ignores equivalent rerenders, and only an explicit same request proceeds', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/members' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const memberListQuery = await import('../src/features/pages/member-list-query');
  const { MemberList } = await import('../src/features/pages/member-list');
  const calls: MemberListRequest[] = [];
  const replies: Section[] = [];
  const load = spyOn(memberListQuery, 'loadMemberList').mockImplementation(async ({ data }) => {
    calls.push(data);
    const next = replies.shift();
    if (!next) throw new Error('Unexpected members read');
    return next;
  });
  let now = 1_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const ready: Section = { ok: true, read, body };
  const value = {
    locale: 'en',
    subject: null,
    unlabelled: 'Unlabelled',
    reader: { spoilerLevel: 0, suitability: 'blur' },
    labels: {},
    link: () => null,
    sections: new Map(),
    relations: {},
    relationNodes: [],
    pageTarget: { subject },
    cacheReader: null,
  } as unknown as OverviewValue;
  let incarnation = 'read-a';
  const admission = {
    get incarnation() {
      return incarnation;
    },
    current(token: string) {
      return token === incarnation;
    },
    registerQuery() {},
    releaseQuery() {},
  };
  const render = async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <MemberList
              key={incarnation}
              value={value}
              section={ready}
              node="members"
              title="Books"
              target={{ subject }}
              expectedReader={null}
              admission={admission as never}
            />
          </QueryClientProvider>
        </StrictMode>,
      );
    });
  };
  const list = () => host.querySelector('[data-slot="member-list"]')!;
  const action = () => list().querySelector('button')!;
  const press = async () => {
    await act(async () => {
      action().dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await Bun.sleep(0);
    });
  };
  try {
    await render();
    replies.push({ ok: false, status: 429, retryAfter: '30' });
    await press();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      target: { subject },
      node: 'members',
      cursor: continuation.cursor,
      representation: { context: PAGE_GLOBAL_CONTEXT, population: 'global' },
    });
    expect(list().textContent).toContain('Snow Country');
    expect(list().getAttribute('data-retry-after')).toBe('30');
    expect(list().textContent).toContain(m.search_recovery_wait());
    expect(action().getAttribute('aria-disabled')).toBe('true');
    now = 5_000;
    await render();
    await press();
    expect(calls).toHaveLength(1);
    expect(list().getAttribute('data-retry-after')).toBe('30');
    now = 31_000;
    await render();
    expect(action().getAttribute('aria-disabled')).toBe('false');
    expect(list().textContent).not.toContain(m.search_recovery_wait());
    expect(calls).toHaveLength(1);
    replies.push({ ok: false, status: 429, retryAfter: '60' });
    await press();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(list().getAttribute('data-retry-after')).toBe('60');
    expect(action().getAttribute('aria-disabled')).toBe('true');
    incarnation = 'read-b';
    now = 31_000;
    await render();
    expect(list().querySelector('button')?.textContent).toBe(m.subject_section_more({ label: 'Books' }));
    await act(async () => root.unmount());
    now = 91_000;
    await act(async () => {
      await Bun.sleep(0);
    });
    expect(calls).toHaveLength(2);
  } finally {
    load.mockRestore();
    clock.mockRestore();
    client.clear();
    host.remove();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});
