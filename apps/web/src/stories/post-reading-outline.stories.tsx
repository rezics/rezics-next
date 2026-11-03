import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { fromMarkdown } from '@rezics/document';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { ThreadReadingPost } from '../routes/threads/$id_.$slug';
import { ThreadReading } from '../threads/thread-reading';
import { ExactRevisionView } from '../threads/exact-revision-view';
import { exactRevisionHref } from '../threads/exact-revision-href';
import { threadLocation } from '../threads/thread-href';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { sessionQuery } from '../session/query';
import { preparedPostReading } from './post-reading-fixtures';

type State = 'ordinary' | 'overflow' | 'concealed' | 'no-headings';
const duplicate = 'Shared observation / 共通の観測';

function PreparedSections({ state }: { state: State }) {
  const [supplied] = useState(() => {
    const supplied = preparedPostReading(2);
    const content =
      state === 'concealed'
        ? '# >!Concealed title!<\n\nThe title stays outside Sections until deliberately revealed.'
        : state === 'no-headings'
          ? 'A short post stays ordinary reading without a decorative Sections panel.'
          : [
              '# Field notes / 観測記録',
              'Read the introduction, choose a section and return to this live position.',
              ...Array.from({ length: state === 'overflow' ? 103 : 32 }, (_, index) =>
                [
                  `${index % 4 === 3 ? '###' : '##'} ${index === 1 || index === 5 ? duplicate : `Observation ${index + 1} / 記録`}`,
                  '星を読む。文書の言語を保つ。 The complete paragraph remains selectable. '.repeat(4),
                ].join('\n\n'),
              ),
              '## Visible words >!Concealed heading text!<',
              'Before a spoiler. >!The travellers return to the observatory.!< After the spoiler.',
              '## العربية / 星を読む',
              'Mixed directions keep the native heading and a plain text outline label.',
              '```ts\nconst keep = "A long code block has no outline headings";\n  console.log(keep);\n```',
              'The full ending remains available.',
            ].join('\n\n');
    const post = { ...supplied.post, body: fromMarkdown(content, 'blocks') };
    return {
      ...supplied,
      post,
      page: { ...supplied.page, posts: { ...supplied.page.posts, posts: [post] } },
      revision: supplied.revision.state === 'ready' ? { ...supplied.revision, revision: post } : supplied.revision,
    };
  });
  const [exact, setExact] = useState(false);
  const [current, setCurrent] = useState(true);
  const locale = getLocale();
  const identity = { postId: supplied.post.id, revisionId: supplied.post.revisionId };
  const exactHref = exactRevisionHref(identity, locale);
  const returnHref = threadLocation(locale, supplied.page.thread, undefined, supplied.post.id);
  return (
    <main
      className="mx-auto min-w-0 max-w-6xl p-4 sm:p-8"
      onClick={(event) => {
        const link = (event.target as Element).closest('a');
        if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
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
      <p role="note" className="mb-4 text-sm text-muted-foreground">
        Prepared published document on recorded DTOs. This connected story demonstrates the reading visit; native
        disclosure is verified separately.
      </p>
      <button className="mb-4 min-h-11 rounded border px-3" onClick={() => setCurrent((value) => !value)}>
        {current ? 'Replace viewer disclosure' : 'Read as the next viewer'}
      </button>
      {exact ? (
        <ExactRevisionView identity={identity} page={supplied.revision} />
      ) : (
        <ThreadReading
          page={supplied.page}
          pageCurrent={current}
          Post={ThreadReadingPost}
          session="signed-out"
          personal={undefined}
          returnTo={returnHref}
          signedOut={m.threads_sign_in_to_reply()}
          renderHeader={() => <h1 className="mb-6 text-2xl font-semibold">Choose a section and return</h1>}
          onMutation={async () => {}}
          onPageRefresh={async () => supplied.page}
        />
      )}
    </main>
  );
}

function SectionsJourney({ state = 'ordinary' }: { state?: State }) {
  const [runtime] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    const route = createRootRoute({ component: () => <PreparedSections state={state} /> });
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
  title: 'Interfaces/Community/Post sections',
  component: SectionsJourney,
  parameters: { layout: 'fullscreen' },
  args: { state: 'ordinary' },
} satisfies Meta<typeof SectionsJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

async function visit({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const page = within(canvasElement.ownerDocument.body);
  await canvas.findByRole('heading', { name: 'Choose a section and return' });
  const body = canvasElement.querySelector<HTMLElement>('[data-slot="post-reading-body"]')!;
  const originalHash = canvasElement.ownerDocument.defaultView!.location.hash;
  const targets = Array.from(body.querySelectorAll<HTMLHeadingElement>('h2')).filter(
    (node) => node.textContent === duplicate,
  );
  const ids = targets.map((node) => node.id);
  for (const index of [0, 1]) {
    const launcher = canvas.getByRole('button', { name: m.post_sections_title() });
    launcher.focus();
    await userEvent.keyboard('{Enter}');
    const navigation = await page.findByRole('navigation', { name: m.post_sections_title() });
    await expect(navigation).not.toHaveTextContent('Concealed heading text');
    const entries = within(navigation).getAllByRole('button', {
      name: m.post_sections_entry({ level: 2, label: duplicate }),
    });
    entries[index]!.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(targets[index]).toHaveFocus());
    await expect(canvasElement.ownerDocument.defaultView!.location.hash).toBe(originalHash);
    const back = await canvas.findByRole('button', { name: m.post_sections_return() });
    back.focus();
    await userEvent.keyboard(' ');
    await expect(body).toHaveFocus();
  }
  await userEvent.click(canvas.getByRole('button', { name: m.post_sections_title() }));
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(canvas.getByRole('button', { name: m.post_sections_title() })).toHaveFocus());
  await userEvent.click(canvas.getByRole('button', { name: m.thread_provenance_heading() }));
  await userEvent.click(await canvas.findByRole('link', { name: m.exact_revision_heading() }));
  await canvas.findByRole('heading', { name: m.exact_revision_heading() });
  const immutable = canvasElement.querySelector<HTMLElement>('[data-slot="post-reading-body"]')!;
  await expect(ids.every((id) => !Array.from(immutable.querySelectorAll('[id]')).some((node) => node.id === id))).toBe(
    true,
  );
  await expect(canvas.queryByRole('button', { name: m.post_sections_return() })).toBeNull();
  await userEvent.click(canvas.getByRole('button', { name: m.post_sections_title() }));
  const outline = await page.findByRole('navigation', { name: m.post_sections_title() });
  await userEvent.click(
    within(outline).getAllByRole('button', { name: m.post_sections_entry({ level: 2, label: duplicate }) })[1]!,
  );
  await canvas.findByRole('button', { name: m.post_sections_return() });
  await userEvent.click(canvas.getByRole('button', { name: m.post_sections_return() }));
  const returnLink = canvas.getByRole('link', { name: m.exact_revision_back() });
  await expect(returnLink).toHaveAttribute('href', expect.stringContaining('#post-'));
  await userEvent.click(returnLink);
  await canvas.findByRole('heading', { name: 'Choose a section and return' });
}

export const PhoneLight: Story = { globals: { viewport: { value: 'phone390' }, theme: 'light' }, play: visit };
export const PhoneDark: Story = { globals: { viewport: { value: 'phone390' }, theme: 'dark' }, play: visit };
export const DesktopLight: Story = { globals: { viewport: { value: 'desktop1280' }, theme: 'light' }, play: visit };
export const DesktopDark: Story = { globals: { viewport: { value: 'desktop1280' }, theme: 'dark' }, play: visit };

async function unavailableVisit({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(await canvas.findByRole('button', { name: m.post_sections_title() }));
  const outline = await page.findByRole('navigation', { name: m.post_sections_title() });
  const missing = canvasElement.querySelector('h2')!;
  missing.remove(); // A live target disappears after the menu opens.
  await userEvent.click(within(outline).getAllByRole('button')[1]!);
  await canvas.findByText(m.post_sections_unavailable());
  await expect(canvasElement.querySelector('[data-slot="post-reading-body"]')).toHaveFocus();
  await userEvent.click(canvas.getByRole('button', { name: m.post_sections_title() }));
  canvas.getByRole('button', { name: 'Replace viewer disclosure', hidden: true }).click();
  await waitFor(() => expect(page.queryByRole('navigation', { name: m.post_sections_title() })).toBeNull());
  await userEvent.click(canvas.getByRole('button', { name: 'Read as the next viewer' }));
  await expect(canvas.queryByRole('button', { name: m.post_sections_return() })).toBeNull();
}
export const PhoneUnavailable: Story = {
  globals: { viewport: { value: 'phone390' }, theme: 'dark' },
  play: unavailableVisit,
};
export const DesktopUnavailable: Story = {
  globals: { viewport: { value: 'desktop1280' }, theme: 'light' },
  play: unavailableVisit,
};
export const VisibleOverflow: Story = {
  args: { state: 'overflow' },
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.post_sections_title() }));
    const outline = await within(canvasElement.ownerDocument.body).findByRole('navigation', {
      name: m.post_sections_title(),
    });
    await expect(within(outline).getAllByRole('listitem')).toHaveLength(100);
    await expect(outline).toHaveTextContent(m.post_sections_overflow({ count: 5 }));
  },
};
export const ConcealedHeading: Story = {
  args: { state: 'concealed' },
  globals: { viewport: { value: 'desktop1280' }, theme: 'dark' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: m.thread_reveal_spoiler() });
    await expect(canvas.queryByRole('button', { name: m.post_sections_title() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.thread_reveal_spoiler() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.post_sections_title() }));
    await expect(
      await within(canvasElement.ownerDocument.body).findByRole('navigation', { name: m.post_sections_title() }),
    ).toHaveTextContent('Concealed title');
  },
};
export const ShortPost: Story = {
  args: { state: 'no-headings' },
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('A short post stays ordinary reading without a decorative Sections panel.');
    await expect(canvas.queryByRole('button', { name: m.post_sections_title() })).toBeNull();
  },
};
