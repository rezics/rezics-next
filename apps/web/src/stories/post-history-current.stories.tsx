import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLayoutEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { expect, userEvent, within } from 'storybook/test';
import { PostHistory } from '../threads/post-history';
import { m } from '../paraglide/messages.js';
import { currentHistoryEnvelope } from './post-history-current-fixture';
import { current, selected, later, exactRevisionViewports } from './exact-revision/fixture';

function source() {
  const client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
  return client;
}

/** Actual history controller and generated native transport, with constructed response examples. */
function CurrentHistory({
  kind = 'review',
  retirement = false,
}: {
  kind?: 'discussion' | 'reply' | 'review';
  retirement?: boolean;
}) {
  const [client, setClient] = useState(source);
  const clients = useRef([client]);
  useLayoutEffect(
    () => () => {
      for (const client of clients.current) client.clear();
    },
    [],
  );
  useLayoutEffect(() => {
    const previous = globalThis.fetch;
    const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === `/v1/posts/${selected.id}/revisions`) return Response.json(currentHistoryEnvelope(2, kind));
      if (path === `/v1/posts/${selected.id}/revisions/${later.revisionId}`) return Response.json({ post: later });
      if (path === `/v1/threads/${selected.threadId}`) return Response.json(current);
      if (path === '/v1/accounts') return Response.json({ accounts: [] });
      if (path.startsWith('/v1/subjects/')) return new Response(null, { status: 404 });
      return previous(input, init);
    }) as typeof fetch;
    globalThis.fetch = transport;
    return () => {
      if (globalThis.fetch === transport) globalThis.fetch = previous;
    };
  }, [kind]);
  return (
    <QueryClientProvider client={client}>
      <main className="mx-auto min-w-0 max-w-3xl space-y-4 p-4 sm:p-8">
        {retirement ? (
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() =>
                client.setQueryData(['session'], { state: 'signed-in', subject: 'story-viewer', csrfToken: null })
              }
            >
              {m.post_history_replace_account()}
            </Button>
            <Button
              onClick={() => {
                const next = source();
                clients.current.push(next);
                setClient(next);
              }}
            >
              {m.post_history_replace_source()}
            </Button>
          </div>
        ) : null}
        <PostHistory postId={selected.id} threadId={selected.threadId} review={kind === 'review'} />
      </main>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Community/Current-context history',
  id: 'interfaces-community-current-context-history',
  component: CurrentHistory,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: exactRevisionViewports },
    docs: {
      description: {
        component:
          'Connected History with constructed generated native envelopes. Native authorization, growth and browser inspection remain controller work.',
      },
    },
  },
} satisfies Meta<typeof CurrentHistory>;
export default meta;
type Story = StoryObj<typeof meta>;
async function visit({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.thread_history_show() }));
  await expect(await canvas.findByText('Admitted Board')).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: m.revision_history_inspect({ number: '1' }) }));
  await expect(canvasElement.querySelector('[data-history-inspector]')).not.toBeNull();
}
export const Discussion: Story = { args: { kind: 'discussion' }, play: visit };
export const Reply: Story = { args: { kind: 'reply' }, play: visit };
export const ReviewZeroScaleRetiredMergedTarget: Story = {
  args: { kind: 'review' },
  play: async (context) => {
    await visit(context);
    const canvas = within(context.canvasElement);
    await expect(canvas.getByText(m.post_history_question_retired())).toBeVisible();
    await expect(
      canvas.getByText('Merged terminal book', { selector: '[aria-label="Recorded revision context"] a' }),
    ).toBeVisible();
  },
};
export const ChangedHeadComparison: Story = {
  args: { kind: 'review' },
  play: async (context) => {
    await visit(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.post_history_compare() }));
    await expect(await canvas.findByText('The later edition makes the ending more explicit.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.post_history_comparison_close() }));
    await expect(canvas.getByRole('button', { name: m.post_history_compare() })).toHaveFocus();
  },
};
export const AccountRetirement: Story = {
  args: { retirement: true },
  play: async (context) => {
    await visit(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.post_history_replace_account() }));
    await expect(canvasElementHistory(context.canvasElement)).toBeNull();
  },
};
export const SourceRetirement: Story = {
  args: { retirement: true },
  play: async (context) => {
    await visit(context);
    await userEvent.click(within(context.canvasElement).getByRole('button', { name: m.post_history_replace_source() }));
    await expect(canvasElementHistory(context.canvasElement)).toBeNull();
  },
};
function canvasElementHistory(element: HTMLElement) {
  return element.querySelector('[data-history-inspector]');
}
