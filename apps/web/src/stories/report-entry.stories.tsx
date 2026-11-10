import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { setStoryRequestContext } from '../../.storybook/react-start';
import { PostActions } from '../report/content-actions';
import { sessionQuery } from '../session/query';
import { m } from '../paraglide/messages.js';

const targetId = '0192f3a0-6c1e-7b2a-9d4e-000000000013';
const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000113';
const reportId = '0192f3a0-6c1e-7b2a-9d4e-000000000813';
const verificationSource = `
  let next = 0;
  const widgets = new Map();
  window.turnstile = {
    render(container, options) {
      const id = String(++next);
      container.dataset.sitekey = options.sitekey;
      container.dataset.language = options.language;
      const verify = document.createElement('button');
      verify.type = 'button';
      verify.textContent = 'Verify report challenge';
      verify.onclick = () => options.callback('story-turnstile-' + id);
      const expire = document.createElement('button');
      expire.type = 'button';
      expire.textContent = 'Expire report challenge';
      expire.onclick = () => options['expired-callback']();
      container.append(verify, expire);
      widgets.set(id, { container, options });
      return id;
    },
    reset(id) { widgets.get(id)?.options['expired-callback'](); },
    remove(id) { widgets.get(id)?.container.replaceChildren(); widgets.delete(id); }
  };
`;

type HeldReport = {
  request: {
    headers: Pick<Headers, 'get'>;
    clone: () => { json: () => Promise<unknown> };
  };
  resolve: (response: Response) => void;
};
type StoryTransport = { scriptUrl: string; requests: HeldReport[] };
let transport: StoryTransport | undefined;

function ConnectedReportEntry() {
  const [client] = useState(() => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in' as const,
      subject: 'story-reader',
      csrfToken: 'story-csrf-token',
    });
    return queryClient;
  });
  useEffect(() => () => client.clear(), [client]);
  if (!transport) throw new Error('The report entry story transport was not initialized.');

  return (
    <QueryClientProvider client={client}>
      <article className="mx-auto flex max-w-2xl flex-col gap-4 rounded-2xl border p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-heading text-xl">A shared reading</h1>
            <p className="text-muted-foreground text-sm">Post revision 3 · {revisionId}</p>
          </div>
          <PostActions
            target={{ kind: 'post', id: targetId }}
            revisionId={revisionId}
            verification={{ sitekey: 'story-report-key', scriptUrl: transport.scriptUrl }}
          />
        </div>
        <p>Readers can report this exact post revision from its overflow menu.</p>
      </article>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Community/Report entry',
  id: 'pages-community-report-entry',
  component: ConnectedReportEntry,
  parameters: { layout: 'padded', viewport: { defaultViewport: 'desktop1280' } },
  beforeEach: () => {
    const previousFetch = globalThis.fetch;
    const blob = new Blob([verificationSource], { type: 'text/javascript' });
    const scriptUrl = URL.createObjectURL(blob);
    const state: StoryTransport = { scriptUrl, requests: [] };
    transport = state;
    setStoryRequestContext({
      visitor: 'Signed In',
      url: new URL('/en/threads/one/reading', window.location.href).href,
    });

    const intercepted = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === 'http://kernel.local' && url.pathname === '/v1/reports' && request.method === 'POST') {
        return new Promise<Response>((resolve) => state.requests.push({ request: request.clone(), resolve }));
      }
      return previousFetch(input, init);
    }) as typeof fetch;
    globalThis.fetch = intercepted;

    return () => {
      if (globalThis.fetch === intercepted) globalThis.fetch = previousFetch;
      URL.revokeObjectURL(scriptUrl);
      if (transport === state) transport = undefined;
    };
  },
} satisfies Meta<typeof ConnectedReportEntry>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DeferredSubmission: Story = {
  name: 'Report from a post menu',
  play: async ({ canvasElement }) => {
    const state = transport;
    if (!state) throw new Error('The report entry story transport was not initialized.');
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'A shared reading' });
    await expect(document.querySelectorAll(`script[src="${state.scriptUrl}"]`)).toHaveLength(0);

    await userEvent.click(canvas.getByRole('button', { name: m.report_more() }));
    await userEvent.click(await screen.findByRole('menuitem', { name: m.report_action() }));
    const dialog = await screen.findByRole('dialog', { name: m.report_title() });
    await expect(document.querySelectorAll(`script[src="${state.scriptUrl}"]`)).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('radio', { name: m.report_off_topic() }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Verify report challenge' }));
    await userEvent.click(within(dialog).getByRole('button', { name: m.report_submit() }));

    await waitFor(() => expect(state.requests).toHaveLength(1));
    const held = state.requests[0]!;
    await expect(held.request.headers.get('authorization')).toBe('Bearer recorded-story-token');
    await expect(held.request.headers.get('idempotency-key')).toMatch(/^"[0-9a-f-]{36}"$/i);
    await expect(await held.request.clone().json()).toEqual({
      target: { kind: 'post', id: targetId },
      revisionId,
      reason: 'off_topic',
      botToken: 'story-turnstile-1',
    });
    await expect(within(dialog).getByRole('button', { name: m.report_submit() })).toBeDisabled();
    await expect(within(dialog).queryByRole('status', { name: m.report_success() })).toBeNull();

    held.resolve(Response.json({ reportId }, { status: 201 }));
    await within(dialog).findByRole('status', { name: m.report_success() });
    await expect(canvas.getByRole('link', { name: m.reporter_status_view() })).toHaveAttribute(
      'href',
      expect.stringContaining(`/moderation/reports/${reportId}`),
    );
  },
};
