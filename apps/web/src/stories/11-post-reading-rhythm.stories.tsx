import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { ThreadReadingPost } from '../routes/threads/$id_.$slug';
import { ThreadReading, focusThreadPostLocation } from '../threads/thread-reading';
import { ExactRevisionView } from '../threads/exact-revision-view';
import { exactRevisionHref } from '../threads/exact-revision-href';
import { threadLocation } from '../threads/thread-href';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { sessionQuery } from '../session/query';
import { preparedPostReading, readingAlt, readingEnding, readingSecret } from './post-reading-fixtures';

function PreparedJourney({ unavailable = false }: { unavailable?: boolean }) {
  const [supplied] = useState(() => preparedPostReading());
  const [exact, setExact] = useState(false);
  const host = useRef<HTMLElement>(null);
  const locale = getLocale();
  const identity = { postId: supplied.post.id, revisionId: supplied.post.revisionId };
  const exactHref = exactRevisionHref(identity, locale);
  const returnHref = threadLocation(locale, supplied.page.thread, undefined, supplied.post.id);
  const page = unavailable ? { ...supplied.page, documentMedia: { kind: 'unavailable' as const } } : supplied.page;
  const revision =
    unavailable && supplied.revision.state === 'ready'
      ? { ...supplied.revision, documentMedia: { kind: 'unavailable' as const } }
      : supplied.revision;
  useEffect(() => {
    if (exact) return;
    const list = host.current?.querySelector('ol') ?? null;
    focusThreadPostLocation(`#post-${supplied.post.id}`, supplied.post.threadId, page.posts.posts, list, true);
  }, [exact, supplied]);
  return (
    <main
      ref={host}
      className="mx-auto min-w-0 max-w-6xl p-4 sm:p-8"
      onClick={(event) => {
        const link = (event.target as Element).closest('a');
        if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        // Prepared navigation between the delivered regions; ordinary modified-click destinations stay real.
        if (link.getAttribute('href') === exactHref) {
          event.preventDefault();
          setExact(true);
        }
        if (link.getAttribute('href') === returnHref) {
          event.preventDefault();
          setExact(false);
        }
      }}
    >
      <p role="note" className="mb-6 text-sm text-muted-foreground">
        Prepared multilingual document and media on recorded DTOs. Revision navigation is prepared; this story does not
        prove native disclosure.
      </p>
      {exact ? (
        <ExactRevisionView identity={identity} page={revision} />
      ) : (
        <ThreadReading
          page={page}
          Post={ThreadReadingPost}
          session="signed-out"
          personal={undefined}
          returnTo={returnHref}
          signedOut={m.threads_sign_in_to_reply()}
          renderHeader={() => <h1 className="mb-6 text-2xl font-semibold">Field notes / 多言語の観測記録</h1>}
          onMutation={async () => {}}
          onPageRefresh={async () => page}
        />
      )}
    </main>
  );
}

function ReadingJourney({ unavailable = false }: { unavailable?: boolean }) {
  const [runtime] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    const route = createRootRoute({ component: () => <PreparedJourney unavailable={unavailable} /> });
    const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
    return { client, router };
  });
  useEffect(() => () => runtime.client.clear(), [runtime]);
  return (
    <QueryClientProvider client={runtime.client}>
      <RouterProvider router={runtime.router} />
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Interfaces/Community/Post reading rhythm',
  component: ReadingJourney,
  parameters: { layout: 'fullscreen' },
  args: { unavailable: false },
} satisfies Meta<typeof ReadingJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

async function journey({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { name: 'Field notes / 多言語の観測記録' });
  const post = canvasElement.querySelector<HTMLElement>('[data-slot="post-reading-frame"]')!;
  await expect(canvasElement.ownerDocument.activeElement).toBe(post);
  const document = post.querySelector<HTMLElement>('[data-slot="post-reading-body"]')!;
  await expect(document).toHaveTextContent(readingEnding);
  await expect(document.querySelector('p[lang="ja"]')).not.toBeNull();
  await expect(document.querySelector('pre code')).toHaveTextContent('console.log(destination);');
  await expect(document.querySelector('table')).toBeVisible();
  // Check real layout in the story viewport, including long names, URLs, code and table cells.
  await expect(document.scrollWidth).toBeLessThanOrEqual(document.clientWidth + 1);
  const reveal = canvas.getByRole('button', { name: m.thread_reveal_spoiler() });
  reveal.focus();
  await userEvent.keyboard('{Enter}');
  const revealed = await canvas.findByText(readingSecret);
  await expect(revealed).toBeVisible();
  await expect(canvasElement.ownerDocument.activeElement).toBe(revealed);
  const details = canvas.getByRole('button', { name: m.thread_provenance_heading() });
  details.focus();
  await userEvent.keyboard(' ');
  const selected = await canvas.findByRole('link', { name: m.exact_revision_heading() });
  await expect(selected).toHaveAttribute('href', expect.stringContaining('/revisions/'));
  await userEvent.click(selected);
  await canvas.findByRole('heading', { name: m.exact_revision_heading() });
  await expect(canvas.getByText(readingEnding)).toBeVisible();
  await expect(canvas.getByRole('button', { name: m.thread_reveal_spoiler() })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  const back = canvas.getByRole('link', { name: m.exact_revision_back() });
  await expect(back).toHaveAttribute('href', expect.stringContaining('#post-'));
  back.focus();
  await userEvent.keyboard('{Enter}');
  await canvas.findByRole('heading', { name: 'Field notes / 多言語の観測記録' });
  const returned = canvasElement.querySelector('[data-slot="post-reading-frame"]');
  await expect(canvasElement.ownerDocument.activeElement).toBe(returned);
  await expect(returned).toHaveTextContent(readingEnding);
}

export const PhoneLight: Story = { globals: { viewport: { value: 'phone390' }, theme: 'light' }, play: journey };
export const PhoneDark: Story = { globals: { viewport: { value: 'phone390' }, theme: 'dark' }, play: journey };
export const DesktopLight: Story = { globals: { viewport: { value: 'desktop1280' }, theme: 'light' }, play: journey };
export const DesktopDark: Story = { globals: { viewport: { value: 'desktop1280' }, theme: 'dark' }, play: journey };
export const UnavailableMedia: Story = {
  args: { unavailable: true },
  globals: { viewport: { value: 'phone390' }, theme: 'dark' },
  play: async (context) => {
    await journey(context);
    const canvas = within(context.canvasElement);
    await expect(
      canvas.getByRole('img', { name: `${m.content_edition_image_unavailable()}: ${readingAlt}` }),
    ).toBeVisible();
    await expect(context.canvasElement.querySelector('img')).toBeNull();
  },
};
