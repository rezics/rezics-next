import type { Meta, StoryObj } from '@storybook/react-vite';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PageStory, pageReady } from './page';
import { mentionThreadId } from '../kernel/fake';
import accounts from '../kernel/recorded/accounts.json';
import { InlinePostEditor, PostComposer } from '../threads/composer';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PageHeading } from '../shell/page-heading';

const meta = {
  title: 'Pages/Thread Mentions',
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Thread: Story = {
  render: () => <PageStory visitor="Signed Out" path={`/threads/${mentionThreadId}`} />,
  async play(context) {
    await pageReady(context);
    const view = within(context.canvasElement);
    const links = await view.findAllByRole('link', { name: '@mira' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toHaveAttribute('href', `/${getLocale()}/@mira`);
    const bodies = context.canvasElement.querySelectorAll('[data-slot="document-body"]');
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body.textContent).toContain('Thanks, @mira. @');
    // Reveal the existing spoiler for the page's accessibility audit.
    for (const button of view.queryAllByRole('button', { name: m.thread_reveal_spoiler() }))
      await userEvent.click(button);
  },
};
const submitted: { current: DocumentSnapshot | null } = { current: null };
const edited: { current: DocumentSnapshot | null } = { current: null };
function Composer({ editing = false }: { editing?: boolean }) {
  return (
    <section className="mx-auto max-w-2xl p-4 sm:p-8 [&_*]:transition-none">
      <PostComposer
        initialKey="mention-story"
        onSubmit={async ({ body }) => {
          submitted.current = body;
          return { ok: true, value: body };
        }}
        onSuccess={() => undefined}
      />
      {editing ? (
        <InlinePostEditor
          initialBody={fromPlainText('', 'blocks')}
          revisionId="revision"
          idempotencyKey="mention-edit"
          containerId={mentionThreadId}
          onCancel={() => {
            throw new Error('Escape must dismiss the mention menu first');
          }}
          onSubmit={async ({ body }) => {
            edited.current = body;
            return { ok: false, reason: 'unavailable' };
          }}
          onSuccess={() => undefined}
        />
      ) : null}
    </section>
  );
}
function ComposerPage({ editing = false }: { editing?: boolean }) {
  const locale = getLocale();
  const { router, queryClient } = useMemo(() => {
    const queryClient = new QueryClient();
    const root = createRootRoute({
      component: () => (
        <AppShell>
          <PageHeading>{m.thread_reply_label()}</PageHeading>
          <Composer editing={editing} />
        </AppShell>
      ),
    });
    const index = createRoute({ getParentRoute: () => root, path: '/' });
    const router = createRouter({
      context: { queryClient },
      routeTree: root.addChildren([index]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    return { router, queryClient };
  }, [editing, locale]);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
async function open(context: { canvasElement: HTMLElement }) {
  const view = within(context.canvasElement);
  await waitFor(() => expect(view.getByRole('textbox', { name: m.thread_reply_label() })).toHaveClass('ProseMirror'));
  const textbox = view.getByRole('textbox', { name: m.thread_reply_label() });
  await userEvent.click(textbox);
  await userEvent.keyboard('@mira');
  const option = await view.findByRole('option', { name: '@mira Mira Okabe' });
  return { view, textbox, option };
}
export const EditorMention: Story = {
  render: () => <ComposerPage />,
  async play(context) {
    await open(context);
  },
};
export const ComposerSubmission: Story = {
  render: () => <ComposerPage editing />,
  async play(context) {
    const { view } = await open(context);
    await userEvent.keyboard('{Enter}hello');
    await userEvent.click(view.getByRole('button', { name: m.thread_write_send() }));
    await waitFor(() =>
      expect(submitted.current?.doc.content?.[0]?.content?.[0]).toEqual({
        type: 'mention',
        attrs: { accountId: accounts.accounts[0]!.id },
      }),
    );
    expect(JSON.stringify(submitted.current)).toContain('hello');
    const edit = view.getByRole('textbox', { name: m.thread_reply_body_label() });
    await userEvent.click(edit);
    await userEvent.keyboard('@m');
    expect(view.getByText(m.editor_mention_loading())).toHaveAttribute('role', 'status');
    await userEvent.keyboard('{Escape}');
    expect(edit).toHaveTextContent('@m');
    expect(view.queryByRole('listbox')).toBeNull();
    await userEvent.keyboard('{Control>}a{/Control}{Backspace}');
    await userEvent.keyboard('@mira');
    await view.findByRole('option', { name: '@mira Mira Okabe' });
    await userEvent.keyboard('{Escape}');
    expect(edit).toHaveTextContent('@mira');
    expect(view.queryByRole('listbox')).toBeNull();
    await userEvent.keyboard('{Control>}a{/Control}{Backspace}@mira');
    await userEvent.click(await view.findByRole('option', { name: '@mira Mira Okabe' }));
    await userEvent.keyboard('edited');
    await userEvent.click(view.getByRole('button', { name: m.thread_edit_save() }));
    await waitFor(() =>
      expect(edited.current?.doc.content?.[0]?.content?.[0]).toEqual({
        type: 'mention',
        attrs: { accountId: accounts.accounts[0]!.id },
      }),
    );
    expect(JSON.stringify(edited.current)).toContain('edited');
  },
};
