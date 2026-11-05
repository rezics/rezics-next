import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { createKernelClient } from '@rezics/client';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { InlinePostEditor, PostComposer } from '../threads/composer';
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { mentionThreadId } from '../kernel/fake';
import accounts from '../kernel/recorded/accounts.json';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { ThreadReading, type ThreadReadingPage } from '../threads/thread-reading';
import { ThreadReadingHeader, ThreadReadingPost } from '../routes/threads/$id_.$slug';
import { loadThreadPageWithAuthors } from '../identity/page-loaders';
import type { ThreadPost } from '../threads/thread-page';
import type { DocumentImagePresentation } from '../threads/document-media';
import { AppShell } from '../shell/shell';
import { PendingPage } from '../shell/pending';
import { PageStory, PatternStory, pageReady } from './page';
import { m } from '../paraglide/messages.js';
import { threadHref } from '../threads/thread-href';
import recordedThread from '../kernel/recorded/thread.json';
import recordedPosts from '../kernel/recorded/thread-posts.json';
import recordedAccounts from '../kernel/recorded/accounts.json';
import recordedSubject from '../kernel/recorded/subject.json';

type State = 'available' | 'unavailable' | 'overflow';
const cover = recordedSubject.summary.cover;
// Constructed document DTO examples reuse the existing recorded derivative fixture. They prove no native admission.
const image: DocumentImagePresentation = {
  id: cover.media,
  containerId: recordedThread.thread.id,
  digest: '0'.repeat(64),
  width: cover.width,
  height: cover.height,
  variants: [{ format: 'webp', width: cover.variants[0]!.width, height: cover.height }],
  placeholder: cover.placeholder,
  focalPoint: null,
  credit: { ...cover.credit, obligations: [] },
};
const alt = 'The Little Prince cover illustration';

async function examplePage(state: State): Promise<ThreadReadingPage> {
  const opening = recordedPosts.posts[0] as Extract<ThreadPost, { availability: 'available' }>;
  const body = fromPlainText(
    'The illustration accompanies these reading notes. The text remains readable when an image is unavailable.',
    'blocks',
  );
  const mediaIds =
    state === 'overflow'
      ? Array.from({ length: 32 }, (_, index) => `0192f3a0-6c1e-7b2a-9d4e-${String(index).padStart(12, '0')}`)
      : [image.id];
  const post = {
    ...opening,
    mediaIds,
    body: {
      ...body,
      doc: {
        ...body.doc,
        content: [
          ...body.doc.content!,
          ...mediaIds.map((src, index) => ({ type: 'image', attrs: { id: `illustration-${index}`, src, alt } })),
        ],
      },
    },
  };
  const overflowReply = {
    ...post,
    id: '0192f3a0-6c1e-7b2a-9d4e-999999999999',
    mediaIds: [image.id],
    body: {
      ...body,
      doc: { type: 'doc', content: [{ type: 'image', attrs: { id: 'reply-illustration', src: image.id, alt } }] },
    },
  };
  const client = createKernelClient('https://kernel.example', {
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === '/v1/media/presentations')
          return state === 'unavailable' ? new Response(null, { status: 503 }) : Response.json({ images: [image] });
        if (path.endsWith('/posts'))
          return Response.json({ posts: state === 'overflow' ? [post, overflowReply] : [post], next: null });
        if (path.includes('/boards/')) return new Response(null, { status: 404 });
        if (path === '/v1/accounts') return Response.json(recordedAccounts);
        if (path === `/v1/threads/${recordedThread.thread.id}`)
          return Response.json({ thread: { ...recordedThread.thread, firstPost: post } });
        throw new Error(`Unexpected thread media example read: ${path}`);
      },
      { preconnect() {} },
    ),
  });
  const page = await loadThreadPageWithAuthors(
    client,
    new Request('https://rezics.example/'),
    {},
    { id: recordedThread.thread.id },
    { sitekey: '', scriptUrl: '' },
    'anonymous',
  );
  if ('redirect' in page) throw new Error('The thread media example must not redirect');
  return { ...page, provenanceSubjects: page.subjects };
}

function ThreadMediaExample({ page }: { page?: ThreadReadingPage }) {
  if (!page) return <PendingPage />;
  return (
    <PatternStory visitor="Signed Out" path={threadHref(page.thread)}>
      <AppShell>
        <ThreadReading
          page={page}
          Post={ThreadReadingPost}
          personal={undefined}
          session="signed-out"
          returnTo={threadHref(page.thread)}
          signedOut={m.threads_sign_in_to_reply()}
          renderHeader={(title) => <ThreadReadingHeader page={page} title={title} />}
          onMutation={async () => {}}
          onPageRefresh={async () => page}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Community/Thread',
  component: ThreadMediaExample,
  parameters: { layout: 'fullscreen' },
  render: (_, { loaded }) => <ThreadMediaExample page={loaded.page as ThreadReadingPage} />,
} satisfies Meta<typeof ThreadMediaExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = {
  loaders: [async () => ({ page: await examplePage('available') })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const picture = await canvas.findByRole('img', { name: alt });
    await expect(picture).toHaveAttribute('src', `/media/${image.id}/webp-${image.variants[0]!.width}`);
    await expect(canvas.getByText(image.credit!.rightsHolder, { exact: false })).toBeVisible();
  },
};
export const Unavailable: Story = {
  loaders: [async () => ({ page: await examplePage('unavailable') })],
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('img', { name: alt })).toHaveTextContent(
      m.content_edition_image_unavailable(),
    );
    await expect(canvasElement.querySelector('picture')).toBeNull();
  },
};
export const Overflow: Story = {
  loaders: [async () => ({ page: await examplePage('overflow') })],
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole('img', { name: alt })).toHaveLength(33);
    await expect(canvasElement.querySelector('picture')).toBeNull();
  },
};
export const ImageFailure: Story = {
  loaders: [async () => ({ page: await examplePage('available') })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const picture = await canvas.findByRole('img', { name: alt });
    picture.dispatchEvent(new Event('error'));
    await waitFor(() =>
      expect(canvas.getByRole('img', { name: alt })).toHaveTextContent(m.content_edition_image_unavailable()),
    );
    await expect(canvas.getByText(image.credit!.rightsHolder, { exact: false })).toBeVisible();
    await expect(canvasElement.querySelector('picture')).toBeNull();
  },
};

const processingId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const unusableId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const initialBody: DocumentSnapshot = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'reply-text' }, content: [{ type: 'text', text: 'Keep this reply draft.' }] },
      { type: 'image', attrs: { id: 'processing-image', src: processingId, alt: 'Processing image' } },
      { type: 'image', attrs: { id: 'unusable-image', src: unusableId, alt: 'Unusable image' } },
    ],
  },
};

export const ReplyMediaUnavailable: Story = {
  name: 'Reply draft with unavailable images',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_edit_save() }));
    await waitFor(async () => expect(await canvas.findByText(m.thread_media_processing())).toBeVisible());
    await canvas.findByText(m.thread_media_unusable());
  },
  render: () => (
    <main className="mx-auto max-w-3xl p-4 sm:p-8">
      <InlinePostEditor
        initialBody={initialBody}
        revisionId="revision-1"
        idempotencyKey="0192f3a0-6c1e-7b2a-9d4e-000000000003"
        containerId="thread-1"
        onSubmit={async () => ({
          ok: false,
          reason: 'media-unavailable',
          media: [
            { id: processingId, state: 'uploaded' },
            { id: unusableId, state: 'rejected' },
          ],
        })}
        onCancel={() => undefined}
        onSuccess={() => undefined}
      />
    </main>
  ),
};

export const ReplyMediaUnknown: Story = {
  name: 'Reply draft with unknown image status',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_edit_save() }));
    await expect(await canvas.findByText(m.thread_media_state_unavailable())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.thread_edit_save() })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: m.thread_media_check_again() })).toBeEnabled();
    await expect(canvas.getByRole('textbox', { name: m.thread_reply_body_label() })).toHaveTextContent(
      'Keep this reply draft.',
    );
    await expect(canvas.getByRole('img', { name: 'Processing image' })).toBeVisible();
  },
  render: () => (
    <PatternStory visitor="Signed In">
      <AppShell>
        <InlinePostEditor
          initialBody={{ ...initialBody, doc: { ...initialBody.doc, content: initialBody.doc.content!.slice(0, 2) } }}
          initialMediaIds={[processingId]}
          revisionId="revision-1"
          idempotencyKey="0192f3a0-6c1e-7b2a-9d4e-000000000004"
          containerId={recordedThread.thread.id}
          onSubmit={async () => ({
            ok: false,
            reason: 'media-unavailable',
            media: [{ id: processingId, state: 'unavailable' }],
          })}
          onCancel={() => undefined}
          onSuccess={() => undefined}
        />
      </AppShell>
    </PatternStory>
  ),
};

export const Thread: Story = {
  parameters: { a11y: { test: 'error' } },
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
  parameters: { a11y: { test: 'error' } },
  render: () => <ComposerPage />,
  async play(context) {
    await open(context);
  },
};
export const ComposerSubmission: Story = {
  parameters: { a11y: { test: 'error' } },
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
