import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import {
  readSubjectCommunity,
  type CommunityKind,
  type CommunityRegion,
  type SubjectCommunity,
} from '../features/pages/subject-community';
import { SubjectCommunityContext, SubjectCommunityRegion } from '../features/pages/subject-community-view';
import { createStoryRecordedKernelFetch } from '../kernel/fake';
import { communityAuthor, communityCharacter, communitySubject } from '../kernel/fake/subject-community';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectViewHref } from '../subject/subject-href';
import { PageStory, PatternStory } from './page';
import { DirectoryExample } from './board-directory.stories';
import { boardDirectorySearch, type BoardDirectorySearch } from '../threads/board-directory';

type State = 'populated' | 'empty' | 'loading' | 'unavailable' | 'closed' | 'continuation';
const storyReader = 'story-reader';
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
queryClient.setQueryData(['session'], { state: 'signed-in', subject: storyReader, csrfToken: 'story-csrf' });
const preparedTransport = {
  async change() {
    return { ok: true as const };
  },
  async read({
    data,
  }: {
    data: { kind: 'upvote' | 'downvote' | 'like' | 'love' | 'laugh' | 'insightful' | 'sad' | null };
  }) {
    return { ok: true as const, counts: { upvote: 3, like: 2, insightful: 1 }, value: data.kind };
  },
};

function CommunityPattern({
  state = 'populated',
  subject = communitySubject,
  kind = 'review',
}: {
  state?: State;
  subject?: typeof communitySubject;
  kind?: CommunityKind;
}) {
  const locale = getLocale();
  const [data, setData] = useState<SubjectCommunity>();
  const [cursor, setCursor] = useState<string>();
  const [paged, setPaged] = useState(false);
  const [entry, setEntry] = useState<string>();
  const [directory, setDirectory] = useState<BoardDirectorySearch>();
  useEffect(() => {
    let current = true;
    const client = createKernelClient('https://kernel.invalid', { fetch: createStoryRecordedKernelFetch() });
    void readSubjectCommunity(client, subject.id, [kind], paged, cursor, storyReader).then((result) => {
      if (current) setData(result);
    });
    return () => {
      current = false;
    };
  }, [paged, cursor, locale, subject.id, kind]);
  if (entry) return <PageStory visitor="Signed In" path={entry} />;
  if (directory) return <DirectoryExample initialSearch={directory} />;
  const loaded = data?.regions[kind] ?? { state: 'loading' };
  const region: CommunityRegion =
    state === 'populated'
      ? loaded
      : state === 'empty'
        ? { state: 'ready', threads: [], next: null, contributionScope: 'global' }
        : state === 'continuation'
          ? { state: 'ready', threads: [], next: 'community-next' }
          : { state };
  const href = subjectViewHref(subject, locale, kind === 'review' ? 'reviews' : 'discussion');
  return (
    <QueryClientProvider client={queryClient}>
      <SubjectCommunityContext.Provider value={data}>
        <PatternStory>
          <div
            className="w-full max-w-4xl p-4 sm:p-8"
            onClick={(event) => {
              const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a') : null;
              if (!anchor) return;
              if (anchor.dataset.slot === 'choose-board') {
                event.preventDefault();
                setDirectory(boardDirectorySearch(Object.fromEntries(new URL(anchor.href).searchParams)));
              } else if (anchor.dataset.slot === 'create-thread') {
                event.preventDefault();
                setEntry(anchor.pathname.replace(`/${locale}`, '') + anchor.search);
              } else if (anchor.dataset.slot === 'see-all' || anchor.dataset.slot === 'community-next') {
                event.preventDefault();
                setPaged(true);
                setCursor(new URL(anchor.href).searchParams.get('cursor') ?? undefined);
              }
            }}
          >
            <SubjectCommunityRegion
              id="subject-community"
              kind={kind}
              region={region}
              authors={data?.authors ?? {}}
              now={data?.now ?? '2026-10-31T00:00:00.000Z'}
              subject={subject}
              locale={locale}
              href={href}
              paged={paged}
              preparedTransport={preparedTransport}
            />
          </div>
        </PatternStory>
      </SubjectCommunityContext.Provider>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Patterns/Subject Community',
  component: CommunityPattern,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CommunityPattern>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: { state: 'populated' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'A small book with lasting questions' })).toBeVisible();
    await userEvent.click(canvas.getByRole('link', { name: m.home_see_all() }));
    await userEvent.click(await canvas.findByRole('link', { name: m.subject_community_more() }));
    await expect(await canvas.findByRole('link', { name: 'Reading it again' })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.subject_community_more() })).toBeNull();
  },
};
export const CharacterDiscussion: Story = {
  args: { state: 'populated', subject: communityCharacter, kind: 'discussion' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'What does the fox teach the prince?' })).toBeVisible();
    await expect(await canvas.findByRole('group', { name: m.reaction_reactions() })).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.subject_community_discuss() })).toHaveAttribute(
      'href',
      expect.stringContaining(`subject=${communityCharacter.id}`),
    );
  },
};
export const Empty: Story = {
  args: { state: 'empty' },
  parameters: {
    docs: {
      description: {
        story:
          'Illustrative terminal Global empty region. The real action opens the default directory with the exact Subject preset. No native directory recording is supplied; its response remains unavailable.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const choose = canvas.getByRole('link', { name: m.subject_choose_review_board() });
    const url = new URL(choose.getAttribute('href')!, window.location.origin);
    await expect(url.searchParams.get('subject')).toBe(communitySubject.id);
    await expect(url.searchParams.get('subjectTitle')).toBe(communitySubject.label);
    await expect(url.searchParams.get('purpose')).toBe('reviews');
    await userEvent.click(choose);
    await expect(await canvas.findByRole('heading', { name: m.board_directory_heading() })).toBeVisible();
    await expect(await canvas.findByText(m.board_directory_unavailable())).toBeVisible();
    await expect(canvas.queryByText(m.board_directory_empty())).toBeNull();
  },
};
export const Loading: Story = { args: { state: 'loading' } };
export const Unavailable: Story = { args: { state: 'unavailable' } };
export const Closed: Story = { args: { state: 'closed' } };
export const FilteredPage: Story = { args: { state: 'continuation' } };
export const OwnExistingReview: Story = {
  args: { state: 'populated' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: m.subject_community_review() }));
    await userEvent.type(await canvas.findByRole('textbox', { name: m.thread_title_label() }), 'A second review');
    const editor = await canvas.findByRole('textbox', { name: m.thread_new_body_label() });
    await userEvent.click(editor);
    await userEvent.type(editor, 'A second look at the journey.');
    await userEvent.click(canvas.getByRole('button', { name: m.thread_write_send() }));
    await expect(await canvas.findByRole('link', { name: m.thread_review_existing() })).toHaveAttribute(
      'href',
      expect.stringContaining('/threads/0192f3a0-6c1e-7b2a-9d4e-000000000009'),
    );
  },
};
