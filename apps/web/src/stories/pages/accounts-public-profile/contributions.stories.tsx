import { defaultReader } from '../../../subject/reader';
import type { ProfileReading } from '../../../accounts/public-profile/reader-presentation/adapter';
import preferences from '../../../kernel/recorded/settings-preferences.json';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { PublicProfilePage } from '../../../accounts/public-profile/page';
import { isRecord } from '../../../features/pages/shared';
import { subjectPageMessages, viewTabLabels } from '../../../features/pages/route-support';
import { subjectTabs } from '../../../features/pages/views';
import recording from '../../../kernel/recorded/agent-page-reader.json';
import threadPosts from '../../../kernel/recorded/thread-posts.json';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';
import { AppShell } from '../../../shell/shell';
import { threadHref } from '../../../threads/thread-href';
import { PatternStory } from '../../page';
import { clippedContributionPage, contributionPage, contributionLongTitle, type ContributionView } from './fixtures';

function Example({
  readingState,
  mode = 'recorded',
  view,
}: {
  readingState?: 'conservative' | 'loading' | 'ready';
  mode?:
    | 'recorded'
    | 'fallbacks'
    | 'discussion'
    | 'clipped'
    | 'clipped-discussion'
    | 'empty'
    | 'missing'
    | 'denied'
    | 'unavailable'
    | 'expired'
    | 'continued';
  view?: ContributionView;
}) {
  const page = mode === 'clipped' || mode === 'clipped-discussion' ? clippedContributionPage() : contributionPage(view);
  for (const result of Object.values(page.reads)) {
    if (!isRecord(result.body)) continue;
    const { posts, threads, collections } = result.body;
    if (['empty', 'missing', 'denied', 'unavailable', 'expired', 'continued'].includes(mode)) {
      const field = Array.isArray(posts)
        ? 'posts'
        : Array.isArray(threads)
          ? 'threads'
          : Array.isArray(collections)
            ? 'collections'
            : null;
      if (field) {
        if (mode === 'missing') result.body = {};
        else if (mode === 'denied' || mode === 'unavailable' || mode === 'expired') {
          result.status = mode === 'denied' ? 403 : mode === 'expired' ? 400 : 503;
          result.body = {};
        } else {
          result.body[field] = [];
          result.body.next = mode === 'continued' ? 'signed+/=next' : null;
        }
      }
    }
    if (mode === 'fallbacks') {
      if (Array.isArray(posts) && isRecord(posts[0]) && isRecord(posts[0].thread)) posts[0].thread.title = '';
      if (Array.isArray(threads)) {
        if (isRecord(threads[0])) threads[0].title = '';
        if (isRecord(threads[1])) threads[1].title = null;
      }
      if (Array.isArray(collections) && isRecord(collections[0])) collections[0].title = '';
    }
    if (mode === 'discussion') {
      // Reuse supplied native documents, keeping account item IDs, order and dates.
      if (Array.isArray(posts)) {
        if (isRecord(posts[0])) posts[0].body = threadPosts.posts[1]!.body;
        if (isRecord(posts[1])) posts[1].body = threadPosts.posts[2]!.body;
      }
      if (Array.isArray(threads)) {
        for (const thread of threads) if (isRecord(thread)) thread.kind = 'discussion';
        if (isRecord(threads[0]) && isRecord(threads[0].firstPost))
          threads[0].firstPost.body = threadPosts.posts[1]!.body;
        if (isRecord(threads[1]) && isRecord(threads[1].firstPost))
          threads[1].firstPost.body = threadPosts.posts[2]!.body;
      }
    }
    if (mode === 'clipped-discussion' && Array.isArray(threads))
      for (const thread of threads) if (isRecord(thread)) thread.kind = 'discussion';
  }
  if (mode === 'discussion' || mode === 'clipped-discussion') {
    for (const node of page.document.content) if (node.type === 'AccountThreads') node.props.threadKind = 'discussion';
  }
  const locale = getLocale();
  return (
    <PatternStory visitor="Signed Out" path={`/@${page.account!.handle}`}>
      <AppShell>
        <PublicProfilePage
          page={page}
          {...(readingState
            ? {
                reading: {
                  state: readingState,
                  response: readingState,
                  reader:
                    readingState === 'ready'
                      ? { spoilerLevel: preferences.spoilerLevel, suitability: preferences.suitability }
                      : defaultReader,
                  ...(readingState !== 'conservative' ? { retry: () => {} } : {}),
                } as ProfileReading,
              }
            : {})}
          locale={locale}
          messages={subjectPageMessages()}
          tabs={subjectTabs(page)}
          tabLabels={viewTabLabels()}
          base={`/${locale}/@${page.account!.handle}`}
          publicRealms
          renderJsonLd={false}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Account/Public Profile/Contributions',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

function contributionRows(canvasElement: HTMLElement, slot: string) {
  const list = canvasElement.querySelector<HTMLElement>(`[data-slot="${slot}-items"]`);
  if (!list) throw new Error(`Missing public contribution list: ${slot}`);
  return Array.from(list.children) as HTMLElement[];
}

async function titleDestination(row: HTMLElement, title: string, href: string) {
  const view = within(row);
  const heading = view.getByRole('heading', { level: 3, name: title });
  await expect(heading).toBeVisible();
  await expect(heading).toHaveAttribute('data-content-item-slot', 'title');
  await expect(view.getAllByRole('heading', { level: 3 })).toHaveLength(1);
  const primary = await view.findByRole('link', { name: title });
  await expect(primary).toHaveAttribute('href', href);
  await expect(primary).toHaveAttribute('aria-labelledby', heading.id);
  await expect(primary.querySelector('a, button')).toBeNull();
  return primary;
}

async function contributionsReady(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { level: 1, name: 'Mira Okabe' });
  await expect(canvas.getAllByRole('main')).toHaveLength(1);
}

export const RecordedContributions: Story = {
  play: async ({ canvasElement }) => {
    await contributionsReady(canvasElement);
    const locale = getLocale();
    const prefix = `/${encodeURIComponent(locale)}`;
    const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
    const posts = contributionRows(canvasElement, 'account-posts');
    await expect(posts).toHaveLength(recording.reads.r11.body.posts.length);
    for (const [index, post] of recording.reads.r11.body.posts.entries()) {
      const row = posts[index]!;
      await titleDestination(
        row,
        post.thread.title || m.threads_untitled(),
        `${prefix}${threadHref({ id: post.threadId, title: post.thread.title })}`,
      );
      await expect(row.querySelector('[data-content-item-slot="metadata"]')).toHaveTextContent(
        dates.format(new Date(post.createdAt)),
      );
      await expect(row.querySelector('[data-content-item-slot="preview"] [data-slot="excerpt"]')).toHaveTextContent(
        post.body.doc.content[0]!.content[0]!.text,
      );
      await expect(within(row).getAllByRole('link')).toHaveLength(1);
    }
    const reviews = contributionRows(canvasElement, 'account-reviews');
    await expect(reviews).toHaveLength(recording.reads.r12.body.threads.length);
    await expect(within(canvasElement).getByRole('heading', { level: 2, name: m.subject_reviews() })).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="account-threads"]')).toBeNull();
    for (const [index, thread] of recording.reads.r12.body.threads.entries()) {
      const row = reviews[index]!;
      await titleDestination(row, thread.title, `${prefix}${threadHref(thread)}`);
      await expect(row.querySelector('[data-content-item-slot="metadata"]')).toHaveTextContent(
        dates.format(new Date(thread.firstPost.createdAt)),
      );
      await expect(row.querySelector('[data-content-item-slot="preview"] [data-slot="excerpt"]')).toHaveTextContent(
        thread.firstPost.body.doc.content[0]!.content[0]!.text,
      );
    }
    const collections = contributionRows(canvasElement, 'account-collections');
    await expect(collections).toHaveLength(recording.reads.r13.body.collections.length);
    for (const [index, collection] of recording.reads.r13.body.collections.entries()) {
      const row = collections[index]!;
      await titleDestination(row, collection.title, `${prefix}/collections/${encodeURIComponent(collection.id)}`);
      await expect(within(row).getAllByRole('link')).toHaveLength(1);
      await expect(row.querySelector('[data-content-item-slot="metadata"]')).toHaveTextContent(
        m.agent_collection_items({ count: collection.memberCount }),
      );
      if (collection.description)
        await expect(row.querySelector('[data-content-item-slot="preview"]')).toHaveTextContent(collection.description);
      else await expect(row.querySelector('[data-content-item-slot="preview"]')).toBeNull();
    }
  },
};

export const TitleFallbacksAndWithheldCollections: Story = {
  args: { mode: 'fallbacks' },
  parameters: { admitted: [] },
  play: async ({ canvasElement }) => {
    await contributionsReady(canvasElement);
    const prefix = `/${encodeURIComponent(getLocale())}`;
    const posts = contributionRows(canvasElement, 'account-posts');
    // Both a supplied empty title and the recording's null title retain the canonical fallback slug.
    for (const index of [0, 2])
      await titleDestination(
        posts[index]!,
        m.threads_untitled(),
        `${prefix}/threads/${recording.reads.r11.body.posts[index]!.threadId}/thread`,
      );
    const reviews = contributionRows(canvasElement, 'account-reviews');
    for (const [index, thread] of recording.reads.r12.body.threads.entries())
      await titleDestination(reviews[index]!, m.threads_untitled(), `${prefix}/threads/${thread.id}/thread`);
    const collections = contributionRows(canvasElement, 'account-collections');
    await expect(collections).toHaveLength(recording.reads.r13.body.collections.length);
    for (const [index, collection] of recording.reads.r13.body.collections.entries()) {
      const row = collections[index]!;
      const view = within(row);
      const heading = view.getByRole('heading', {
        level: 3,
        name: index === 0 ? m.subject_value_unlabelled() : collection.title,
      });
      await expect(heading).toBeVisible();
      await expect(heading).toHaveAttribute('data-content-item-slot', 'title');
      await expect(view.queryByRole('link')).toBeNull();
      await expect(row.querySelector('a, [role="link"], [aria-hidden="true"]')).toBeNull();
      await expect(row.querySelector('[data-content-item-slot="metadata"]')).toHaveTextContent(
        m.agent_collection_items({ count: collection.memberCount }),
      );
      if (collection.description)
        await expect(row.querySelector('[data-content-item-slot="preview"]')).toHaveTextContent(collection.description);
    }
  },
};

export const LinkedCollectionFallback: Story = {
  args: { mode: 'fallbacks' },
  play: async ({ canvasElement }) => {
    await contributionsReady(canvasElement);
    const [row] = contributionRows(canvasElement, 'account-collections');
    await titleDestination(
      row!,
      m.subject_value_unlabelled(),
      `/${encodeURIComponent(getLocale())}/collections/${recording.reads.r13.body.collections[0]!.id}`,
    );
    await expect(within(row!).getAllByRole('link')).toHaveLength(1);
  },
};

export const DiscussionAndIndependentExcerpts: Story = {
  args: { mode: 'discussion' },
  play: async ({ canvasElement }) => {
    await contributionsReady(canvasElement);
    await expect(within(canvasElement).getByRole('heading', { level: 2, name: m.subject_discussion() })).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="account-reviews"]')).toBeNull();
    for (const slot of ['account-posts', 'account-threads']) {
      const rows = contributionRows(canvasElement, slot);
      const row = rows[0]!;
      const thread =
        slot === 'account-posts' ? recording.reads.r11.body.posts[0]!.thread : recording.reads.r12.body.threads[0]!;
      const primary = await titleDestination(
        row,
        thread.title!,
        `/${encodeURIComponent(getLocale())}${threadHref(thread)}`,
      );
      const excerpt = row.querySelector<HTMLElement>('[data-content-item-slot="preview"] [data-slot="excerpt"]')!;
      const link = within(excerpt).getByRole('link', { name: 'The asteroid' });
      await expect(link).toHaveAttribute('href', 'https://example.com/b612');
      await expect(getComputedStyle(link).position).toBe('relative');
      await expect(getComputedStyle(link).zIndex).toBe('10');
      await expect(excerpt.closest('[data-slot="list-row-control"]')).toBeNull();
      await expect(primary.contains(link)).toBe(false);
      primary.focus();
      await userEvent.tab();
      await expect(link).toHaveFocus();
      const openReference = fn((event: Event) => event.preventDefault());
      link.addEventListener('click', openReference, { once: true });
      await userEvent.click(link);
      await expect(openReference).toHaveBeenCalledOnce();

      const spoilerRow = rows[1]!;
      const reveal = within(spoilerRow).getByRole('button', { name: m.thread_reveal_spoiler() });
      await expect(reveal.closest('[data-content-item-slot="preview"]')).toBeTruthy();
      await expect(getComputedStyle(reveal).position).toBe('relative');
      await expect(getComputedStyle(reveal).zIndex).toBe('10');
      await expect(reveal.closest('[data-slot="list-row-control"]')).toBeNull();
      await expect(reveal).toHaveAttribute('aria-expanded', 'false');
      reveal.focus();
      await userEvent.keyboard('{Enter}');
      await expect(within(spoilerRow).queryByRole('button', { name: m.thread_reveal_spoiler() })).toBeNull();
      const revealed = within(spoilerRow).getByText('The rose was unique');
      await expect(revealed).toBeVisible();
      await expect(revealed.closest('.document-spoiler-revealed')).toHaveFocus();
      await expect(contributionRows(canvasElement, slot)).toHaveLength(rows.length);
    }
  },
};

async function independentClippedExcerpts(canvasElement: HTMLElement, threadSlot: string) {
  await contributionsReady(canvasElement);
  for (const slot of ['account-posts', threadSlot]) {
    const rows = contributionRows(canvasElement, slot);
    const row = rows[0]!;
    const source =
      slot === 'account-posts' ? recording.reads.r11.body.posts[0]!.thread : recording.reads.r12.body.threads[0]!;
    const primary = await titleDestination(
      row,
      contributionLongTitle,
      `/${encodeURIComponent(getLocale())}${threadHref({ id: source.id, title: contributionLongTitle })}`,
    );
    const excerpt = row.querySelector<HTMLElement>('[data-slot="excerpt"]')!;
    await expect(excerpt).toHaveClass('max-h-40', 'overflow-hidden');
    await expect(excerpt.scrollHeight).toBeGreaterThan(excerpt.clientHeight);
    await expect(excerpt.closest('[data-slot="list-row-control"]')).toBeNull();
    await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    const paragraph = excerpt.querySelector('p')!;
    const reference = within(excerpt).getByRole('link', { name: 'The asteroid' });
    await expect(getComputedStyle(reference).position).toBe('relative');
    await expect(getComputedStyle(reference).zIndex).toBe('10');
    await expect(primary.contains(reference)).toBe(false);
    primary.focus();
    await userEvent.tab();
    await expect(reference).toHaveFocus();
    const openReference = fn((event: Event) => event.preventDefault());
    reference.addEventListener('click', openReference);
    try {
      await userEvent.keyboard('{Enter}');
      await userEvent.pointer([
        { keys: '[TouchA>]', target: reference },
        { keys: '[/TouchA]', target: reference },
      ]);
      await expect(openReference).toHaveBeenCalledTimes(2);
    } finally {
      reference.removeEventListener('click', openReference);
    }
    // Hit-test the rendered paragraph, since clicking its DOM node would bypass the stretched anchor.
    paragraph.scrollIntoView({ block: 'center' });
    const box = paragraph.getBoundingClientRect();
    const point = { x: box.left + Math.min(8, box.width / 2), y: box.top + Math.min(8, box.height / 2) };
    const target = document.elementFromPoint(point.x, point.y)!;
    await expect(target.closest('a')).toBe(primary);
    const openThread = fn((event: Event) => event.preventDefault());
    primary.addEventListener('click', openThread);
    try {
      await userEvent.click(target);
      await userEvent.pointer([
        { keys: '[TouchA>]', target },
        { keys: '[/TouchA]', target },
      ]);
      await expect(openThread).toHaveBeenCalledTimes(2);
    } finally {
      primary.removeEventListener('click', openThread);
    }
    const reveal = within(rows[1]!).getByRole('button', { name: m.thread_reveal_spoiler() });
    await expect(reveal.closest('[data-slot="list-row-control"]')).toBeNull();
    await expect(getComputedStyle(reveal).zIndex).toBe('10');
    reveal.focus();
    await userEvent.keyboard(' ');
    const revealed = within(rows[1]!).getByText('The rose was unique').closest('.document-spoiler-revealed');
    await expect(revealed).toHaveFocus();
    await expect(revealed).toBeVisible();
  }
}

export const ClippedNativeControls: Story = {
  args: { mode: 'clipped' },
  play: async ({ canvasElement }) => independentClippedExcerpts(canvasElement, 'account-reviews'),
};

export const ClippedDiscussionControls: Story = {
  args: { mode: 'clipped-discussion' },
  play: async ({ canvasElement }) => independentClippedExcerpts(canvasElement, 'account-threads'),
};

export const DedicatedEmpty: Story = {
  args: { mode: 'empty', view: 'posts' },
  play: async ({ canvasElement }) => {
    await contributionsReady(canvasElement);
    const section = canvasElement.querySelector<HTMLElement>('[data-slot="account-posts"]')!;
    await expect(within(section).getByText(m.agent_empty())).toBeVisible();
    await expect(section.querySelector('[data-slot="see-all"], [data-slot="continuation"]')).toBeNull();
  },
};

export const DedicatedMissing: Story = {
  args: { mode: 'missing', view: 'reviews' },
  play: async ({ canvasElement }) => {
    await contributionsReady(canvasElement);
    const section = canvasElement.querySelector<HTMLElement>('[data-slot="account-reviews"]')!;
    await expect(section).toHaveAttribute('data-state', 'failed');
    await expect(within(section).getByRole('status')).toHaveTextContent(m.subject_section_failed());
    await expect(within(section).getByRole('link', { name: m.subject_section_retry() })).toHaveAttribute('href', '');
    await expect(within(section).queryByText(m.agent_empty())).toBeNull();
  },
};

export const DedicatedDenied: Story = {
  args: { mode: 'denied', view: 'collections' },
  play: async ({ canvasElement }) => {
    await contributionsReady(canvasElement);
    const section = canvasElement.querySelector<HTMLElement>('[data-slot="account-collections"]')!;
    await expect(within(section).getByRole('status')).toHaveTextContent(m.public_account_denied());
    await expect(within(section).queryByRole('link')).toBeNull();
  },
};

export const DedicatedUnavailable: Story = {
  args: { mode: 'unavailable', view: 'posts' },
  play: async ({ canvasElement }) => {
    await contributionsReady(canvasElement);
    const section = canvasElement.querySelector<HTMLElement>('[data-slot="account-posts"]')!;
    await expect(within(section).getByRole('alert')).toHaveTextContent(m.public_account_unavailable());
    await expect(within(section).getByRole('link', { name: m.public_account_retry() })).toHaveAttribute('href', '');
  },
};

export const DedicatedExpired: Story = {
  args: { mode: 'expired', view: 'reviews' },
  play: async ({ canvasElement }) => {
    await contributionsReady(canvasElement);
    const section = canvasElement.querySelector<HTMLElement>('[data-slot="account-reviews"]')!;
    await expect(within(section).getByRole('status')).toHaveTextContent(m.public_account_cursor_expired());
    await expect(within(section).getByRole('link', { name: m.public_account_start_again() })).toHaveAttribute(
      'href',
      `/${encodeURIComponent(getLocale())}/@mira/reviews`,
    );
  },
};

export const DedicatedSparseContinuation: Story = {
  args: { mode: 'continued', view: 'collections' },
  play: async ({ canvasElement }) => {
    await contributionsReady(canvasElement);
    await expect(contributionRows(canvasElement, 'account-collections')).toHaveLength(0);
    const section = canvasElement.querySelector<HTMLElement>('[data-slot="account-collections"]')!;
    await expect(within(section).getByRole('link', { name: m.threads_next_page() })).toHaveAttribute(
      'href',
      '?cursor=signed%2B%2F%3Dnext',
    );
    await expect(within(section).queryByText(m.agent_empty())).toBeNull();
  },
};

export const WithheldCollectionContinuation: Story = {
  args: { mode: 'continued', view: 'collections' },
  parameters: { admitted: [] },
  play: async ({ canvasElement }) => {
    await contributionsReady(canvasElement);
    const section = canvasElement.querySelector<HTMLElement>('[data-slot="account-collections"]')!;
    await expect(within(section).queryByRole('link')).toBeNull();
    await expect(within(section).queryByText(m.agent_empty())).toBeNull();
  },
};

export const ConservativeReading: Story = { render: () => <Example view="posts" readingState="conservative" /> };
export const RecoveringReading: Story = { render: () => <Example view="posts" readingState="loading" /> };
export const AdmittedReading: Story = { render: () => <Example view="posts" readingState="ready" /> };
