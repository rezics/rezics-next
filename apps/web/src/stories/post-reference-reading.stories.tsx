import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { fromMarkdown } from '@rezics/document';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { ThreadReadingPost } from '../routes/threads/$id_.$slug';
import { ThreadReading } from '../threads/thread-reading';
import { threadLocation } from '../threads/thread-href';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { sessionQuery } from '../session/query';
import { preparedPostReading } from './post-reading-fixtures';

type State = 'mixed' | 'long' | 'overflow';

function PreparedReferences({ state = 'mixed' }: { state?: State }) {
  const [supplied] = useState(() => {
    const supplied = preparedPostReading(state === 'long' ? 48 : 3);
    const content =
      state === 'overflow'
        ? [
            '# Many source links',
            ...Array.from(
              { length: 70 },
              (_, index) => `Reference ${index + 1}: [same label](https://sources.example/item/${index}?part=one#note)`,
            ),
          ].join('\n\n')
        : [
            '# Field notes / 觀測記錄',
            'Each authored label remains distinct from its full destination.',
            '[same label](https://sources.example/first?edition=one#section)',
            '[same label](https://sources.example/second?edition=two#section)',
            '[Contact the editor](mailto:reader@example.org?subject=Field%20notes)',
            `[A long address](${`https://sources.example/${'unbroken-source-path-'.repeat(24)}?view=full#appendix`})`,
            'Before a concealed reference. >![hidden source label](https://private.example/never-list)!< After it.',
            'The source body remains complete and selectable. 星を読む。文書の言語を保つ。 '.repeat(
              state === 'long' ? 45 : 8,
            ),
          ].join('\n\n');
    const post = { ...supplied.post, body: fromMarkdown(content, 'blocks') };
    return {
      ...supplied,
      post,
      page: { ...supplied.page, posts: { ...supplied.page.posts, posts: [post] } },
    };
  });
  const [current, setCurrent] = useState(true);
  const locale = getLocale();
  const returnHref = threadLocation(locale, supplied.page.thread, undefined, supplied.post.id);
  return (
    <main className="mx-auto min-w-0 max-w-6xl p-4 sm:p-8">
      <p role="note" className="mb-4 text-sm text-muted-foreground">
        Published post fixture with mixed destinations, concealed links and exact source return.
      </p>
      <button className="mb-4 min-h-11 rounded border px-3" onClick={() => setCurrent((value) => !value)}>
        {current ? 'Replace viewer disclosure' : 'Read as the next viewer'}
      </button>
      <ThreadReading
        page={supplied.page}
        pageCurrent={current}
        Post={ThreadReadingPost}
        session="signed-out"
        personal={undefined}
        returnTo={returnHref}
        signedOut={m.threads_sign_in_to_reply()}
        renderHeader={() => <h1 className="mb-6 text-2xl font-semibold">Inspect references and return to the post</h1>}
        onMutation={async () => {}}
        onPageRefresh={async () => supplied.page}
      />
    </main>
  );
}

function ReferencesJourney({ state = 'mixed' }: { state?: State }) {
  const [runtime] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    const route = createRootRoute({ component: () => <PreparedReferences state={state} /> });
    return {
      client,
      router: createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) }),
    };
  });
  useEffect(() => () => runtime.client.clear(), [runtime]);
  return (
    <QueryClientProvider client={runtime.client}>
      <RouterProvider router={runtime.router} />
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Interfaces/Community/Post references',
  component: ReferencesJourney,
  parameters: { layout: 'fullscreen' },
  args: { state: 'mixed' },
} satisfies Meta<typeof ReferencesJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

async function openFirstReference(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const page = within(canvasElement.ownerDocument.body);
  await canvas.findByRole('heading', { name: 'Inspect references and return to the post' });
  await userEvent.click(canvas.getByRole('button', { name: m.post_references_title() }));
  const navigation = await page.findByRole('navigation', { name: m.post_references_title() });
  await expect(navigation).not.toHaveTextContent('hidden source label');
  await userEvent.click(within(navigation).getByRole('button', { name: m.post_references_entry({ number: 1, label: 'same label' }) }));
  return { canvas, page };
}

async function readingVisit({ canvasElement }: { canvasElement: HTMLElement }) {
  const { canvas, page } = await openFirstReference(canvasElement);
  const detail = await page.findByRole('dialog');
  const address = within(detail).getByRole('textbox', { name: m.post_references_destination() });
  await expect(address).toHaveValue('https://sources.example/first?edition=one#section');
  await expect(within(detail).getByRole('link', { name: m.post_references_follow() })).toHaveAttribute(
    'href',
    'https://sources.example/first?edition=one#section',
  );
  const sourceId = canvasElement.querySelector('[data-slot="post-reading-body"] a[href="https://sources.example/first?edition=one#section"]')?.id;
  await userEvent.click(within(detail).getByRole('button', { name: m.post_references_return() }));
  await waitFor(() => expect(canvasElement.ownerDocument.activeElement).toHaveAttribute('id', sourceId));
  await expect(canvas).toHaveTextContent('The source body remains complete and selectable.');
}

export const PhoneLight: Story = { globals: { viewport: { value: 'phone390' }, theme: 'light' }, play: readingVisit };
export const PhoneDark: Story = { globals: { viewport: { value: 'phone390' }, theme: 'dark' }, play: readingVisit };
export const DesktopLight: Story = {
  globals: { viewport: { value: 'desktop1280' }, theme: 'light' },
  play: readingVisit,
};
export const DesktopDark: Story = {
  globals: { viewport: { value: 'desktop1280' }, theme: 'dark' },
  play: readingVisit,
};

export const LongSourceHeavyPost: Story = {
  args: { state: 'long' },
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
  play: readingVisit,
};

export const VisibleOverflow: Story = {
  args: { state: 'overflow' },
  globals: { viewport: { value: 'desktop1280' }, theme: 'dark' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: m.post_references_title() }));
    const navigation = await page.findByRole('navigation', { name: m.post_references_title() });
    await expect(within(navigation).getAllByRole('listitem')).toHaveLength(64);
    await expect(navigation).toHaveTextContent(m.post_references_overflow({ count: 6 }));
  },
};

export const CopyRecovery: Story = {
  globals: { viewport: { value: 'phone390' }, theme: 'dark' },
  play: async ({ canvasElement }) => {
    const win = canvasElement.ownerDocument.defaultView!;
    const prior = Object.getOwnPropertyDescriptor(win.navigator, 'clipboard');
    Object.defineProperty(win.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) },
    });
    try {
      const { page } = await openFirstReference(canvasElement);
      const detail = await page.findByRole('dialog');
      await userEvent.click(within(detail).getByRole('button', { name: m.post_references_copy() }));
      await page.findByText(m.post_references_copy_denied());
      await userEvent.click(within(detail).getByRole('button', { name: m.post_references_select() }));
      await expect(within(detail).getByRole('textbox', { name: m.post_references_destination() })).toHaveFocus();
    } finally {
      if (prior) Object.defineProperty(win.navigator, 'clipboard', prior);
      else Reflect.deleteProperty(win.navigator, 'clipboard');
    }
  },
};

export const ReaderReplacement: Story = {
  globals: { viewport: { value: 'desktop1280' }, theme: 'light' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await canvas.findByRole('button', { name: m.post_references_title() });
    await userEvent.click(canvas.getByRole('button', { name: m.post_references_title() }));
    await page.findByRole('navigation', { name: m.post_references_title() });
    await userEvent.keyboard('{Escape}');
    await userEvent.click(canvas.getByRole('button', { name: 'Replace viewer disclosure' }));
    await waitFor(() => expect(page.queryByRole('navigation', { name: m.post_references_title() })).toBeNull());
    await userEvent.click(canvas.getByRole('button', { name: 'Read as the next viewer' }));
    await expect(canvas.queryByRole('button', { name: m.post_references_return_previous() })).toBeNull();
  },
};
