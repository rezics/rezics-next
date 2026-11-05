import { mock, expect } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../../.storybook/react-start';
import { current, selected, later } from '../../src/stories/exact-revision/fixture';
import { currentHistoryEnvelope } from '../../src/stories/post-history-current-fixture';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/threads/current' });
for (const key of [
  'window',
  'document',
  'navigator',
  'location',
  'HTMLElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'Document',
  'DocumentFragment',
  'MutationObserver',
  'ResizeObserver',
] as const)
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === 'window' ? window : window[key],
  });
for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia'] as const)
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key].bind(window) });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

export const runtime = {
  subject: null as string | null,
  envelope: currentHistoryEnvelope(),
  defer: false,
  pending: [] as ((response: Response) => void)[],
  calls: [] as Request[],
};
const credential = async () =>
  runtime.subject
    ? {
        status: 'active' as const,
        subject: runtime.subject,
        accessToken: 'current-history-token',
        csrfToken: null,
      }
    : { status: 'inactive' as const };
const env = {
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'history-test',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: { idFromName: (id: string) => id, get: () => ({ credential, credentialIfFresh: credential }) },
};
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () =>
    new Request('https://site.test/en/threads/current', {
      headers: runtime.subject ? { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } : {},
    }),
}));
mock.module('cloudflare:workers', () => ({ env }));
const { createKernelClient } = await import('@rezics/client');
const kernel = createKernelClient('https://kernel.test', {
  fetch: async (input, init) => {
    const request = new Request(input, init);
    runtime.calls.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/revisions'))
      return runtime.defer
        ? new Promise<Response>((resolve) => runtime.pending.push(resolve))
        : Response.json(runtime.envelope);
    if (path.endsWith(`/revisions/${later.revisionId}`)) return Response.json({ post: later });
    if (path === `/v1/threads/${selected.threadId}`) return Response.json(current);
    if (path === '/v1/accounts') return Response.json({ accounts: [] });
    if (path.startsWith('/v1/subjects/')) return new Response(null, { status: 404 });
    throw new Error(`Unexpected history read: ${path}`);
  },
});
mock.module('../../src/kernel/client', () => ({ kernelClient: () => kernel }));
const { createRoot } = await import('react-dom/client');
export const { PostHistory } = await import('../../src/threads/post-history');
export const { m } = await import('../../src/paraglide/messages.js');
export const { getLocale, setLocale } = await import('../../src/paraglide/runtime.js');
export { currentHistoryEnvelope, selected, later };
export async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
export async function click(button: HTMLElement) {
  await act(async () => {
    button.click();
    await flush();
  });
}
export function control(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label);
  expect(button).toBeDefined();
  return button!;
}
export async function mount(envelope = currentHistoryEnvelope()) {
  runtime.envelope = envelope;
  runtime.subject = null;
  runtime.defer = false;
  runtime.calls.length = 0;
  runtime.pending.length = 0;
  window.history.replaceState(null, '', '/en/threads/current');
  setLocale('en', { reload: false });
  const client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  async function render(props: Partial<ComponentProps<typeof PostHistory>> = {}, source = client) {
    await act(async () => {
      root.render(
        <StrictMode>
          <QueryClientProvider client={source}>
            <PostHistory postId={selected.id} {...props} />
          </QueryClientProvider>
        </StrictMode>,
      );
      await flush();
    });
  }
  await render();
  return {
    host,
    client,
    render,
    async open() {
      await click(control(host, m.thread_history_show()));
    },
    async inspect(index = 1) {
      await click(control(host, m.revision_history_inspect({ number: String(index) })));
    },
    async finish(envelope = runtime.envelope) {
      await act(async () => {
        runtime.pending.shift()!(Response.json(envelope));
        await flush();
      });
    },
    async dispose() {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}
