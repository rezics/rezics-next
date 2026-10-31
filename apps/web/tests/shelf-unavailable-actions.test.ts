import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';

test('Unavailable shelf items keep bounded usable management actions', async () => {
  // Keep the real page, menu, session/exposure queries, form parser and command transport.
  // Only the session store and HTTP responses stand in for native services.
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library', width: 1280, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  const labelId = '0192f3a0-6c1e-7b2a-9d4e-000000000801';
  const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000001102';
  const assignmentId = '0192f3a0-6c1e-7b2a-9d4e-000000001202';
  const viewerId = '0192f3a0-6c1e-7b2a-9d4e-000000000111';
  const csrfToken = 'a'.repeat(22);
  const admitted = ['personal_library', 'reading_progress', 'library_label.assignment_list', 'library_label.unassign'];
  const credential = async () => ({
    status: 'active',
    subject: viewerId,
    accessToken: 'owner-token',
    csrfToken,
  });
  const sessionEnv = {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'library_entry:read library_entry:update',
    WEBSITE_CLIENT_ID: 'shelf-test',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: { idFromName: (id: string) => id, get: () => ({ credential, credentialIfFresh: credential }) },
  };
  const pageRequest = () =>
    new Request(`https://site.test/en/library?label=${labelId}`, {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
  const start = await import('../.storybook/react-start');
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => ({ getRequest: pageRequest, setResponseHeader() {} }));
  mock.module('cloudflare:workers', () => ({ env: sessionEnv }));
  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const url = new URL(request.url);
    if (url.pathname === '/v1/platform/exposure') return Response.json({ admitted });
    if (url.pathname === '/v1/libraryLabelAssignments')
      return Response.json({
        label: { id: labelId, name: 'Reading list', revision: 1 },
        assignments: [
          ...[0, 1].map((index) => ({
            id: `0192f3a0-6c1e-7b2a-9d4e-00000000120${index}`,
            subjectId: `0192f3a0-6c1e-7b2a-9d4e-00000000110${index}`,
            labelId,
            revision: 1,
            subject: {
              id: `0192f3a0-6c1e-7b2a-9d4e-00000000110${index}`,
              label: { value: `Visible work ${index + 1}`, language: 'en' },
              type: 'schema:Book',
              types: ['schema:Book'],
              cover: null,
            },
            libraryEntry: null,
          })),
          { id: assignmentId, subjectId, labelId, revision: 5, subject: null, libraryEntry: null },
        ],
        next: 'next-page',
      });
    if (url.pathname === `/v1/libraryLabels/${labelId}:unassign`)
      return Response.json({ deleted: true }, { headers: { 'Library-Label-Assignment-Revision': '6' } });
    // Display definitions are unavailable; a label command must not depend on them or subject details.
    return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
  }) as typeof fetch;
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { loadLabelShelfPage } = await import('../src/library/label-shelf-read');
  const { LabelShelfPage } = await import('../src/library/entries-page');
  const { submitSubjectLabelForm } = await import('../src/library/subject-slot-form-action');
  const { m } = await import('../src/paraglide/messages.js');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    const page = await loadLabelShelfPage(
      createKernelClient('https://kernel.test'),
      pageRequest(),
      sessionEnv as unknown as SessionEnv,
      {
        labelId,
        limit: 3,
      },
    );
    expect(page.state).toBe('loaded');
    if (page.state !== 'loaded') throw new Error('Label page did not load');
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: viewerId, csrfToken });
    client.setQueryData(exposureQuery.queryKey, admitted);
    const route = createRootRoute({
      component: () => createElement(LabelShelfPage, { page, locale: 'en', display: { layout: 'grid', size: 'm' } }),
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: ['/en/library'] }),
    });
    await router.load();
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
    });
    expect(host.querySelectorAll('[data-slot="cover-card"], [data-slot="tombstone"]')).toHaveLength(3);
    expect(host.textContent).toContain('Visible work 1');
    expect(host.textContent).toContain('Visible work 2');
    expect(host.querySelector(`a[href*="cursor=next-page"]`)).not.toBeNull();
    const tile = host.querySelector('[data-slot="tombstone"]')!.parentElement!;
    const trigger = tile.querySelector('button')!;
    expect(trigger.getAttribute('aria-label')).toBe(
      m.library_entry_actions({ title: m.library_subject_unavailable() }),
    );
    expect(trigger.disabled).toBe(false);
    expect(tile.querySelector('a, img, form')).toBeNull();
    expect(tile.textContent).not.toContain(subjectId);
    expect(host.textContent).not.toContain(m.library_label_shelf_remove());
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    const surface = window.document.querySelector('[role="dialog"]')!;
    expect(surface.getAttribute('aria-label')).toBe(trigger.getAttribute('aria-label'));
    expect(surface.querySelector('a, img')).toBeNull();
    const form = surface.querySelector('form')!;
    const submit = form.querySelector('button')!;
    expect(submit.textContent).toBe(m.library_label_shelf_remove());
    expect(submit.disabled).toBe(false);
    expect(window.document.getElementById(submit.getAttribute('aria-describedby')!)?.textContent).toBe('Reading list');
    const fields = Object.fromEntries(
      Array.from(form.querySelectorAll('input')).map((input) => [input.name, input.value]),
    );
    expect(fields).toEqual({
      intent: 'unassign',
      subjectId,
      labelId,
      assignmentId,
      revision: '5',
      csrf_token: csrfToken,
      idempotencyKey: page.entries[2]!.removeKey,
    });
    let result: ReturnType<typeof submitSubjectLabelForm> | undefined;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      result = submitSubjectLabelForm(
        new Request(form.action, {
          method: form.method,
          headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}`, origin: 'https://site.test' },
          body: new URLSearchParams(fields),
        }),
      );
    });
    await act(async () => {
      submit.click();
    });
    expect(result).toBeDefined();
    expect(await result).toEqual({ ok: true, assignment: { id: assignmentId, revision: 5 }, restoreRevision: 6 });
    const mutations = requests.filter((request) => request.method === 'POST');
    expect(mutations).toHaveLength(1);
    expect(new URL(mutations[0]!.url).pathname).toBe(`/v1/libraryLabels/${labelId}:unassign`);
    expect(mutations[0]!.headers.get('authorization')).toBe('Bearer owner-token');
    expect(mutations[0]!.headers.get('idempotency-key')).toBe(page.entries[2]!.removeKey!);
    expect(await mutations[0]!.json()).toEqual({ subjectId, assignmentId, revision: 5 });
    expect(requests.filter((request) => new URL(request.url).pathname === '/v1/libraryLabelAssignments')).toHaveLength(
      1,
    );
    expect(requests.some((request) => new URL(request.url).pathname.startsWith('/v1/subjects'))).toBe(false);
    await act(async () => {
      submit.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(window.document.querySelector('[role="dialog"]')).toBeNull();
    expect(window.document.activeElement).toBe(trigger);
    // Current exposure still decides management even when an owner page has already loaded.
    await act(async () => {
      client.setQueryData(
        exposureQuery.queryKey,
        admitted.filter((operation) => operation !== 'library_label.unassign'),
      );
      await Bun.sleep(5);
    });
    expect(tile.querySelector('button, form') === null).toBe(true);
    expect(host.querySelector('[data-slot="tombstone"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = originalFetch;
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
