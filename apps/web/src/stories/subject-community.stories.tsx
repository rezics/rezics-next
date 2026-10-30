import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { createKernelClient } from '@rezics/client';
import { readSubjectCommunity, type CommunityRegion, type SubjectCommunity } from '../features/pages/subject-community';
import { SubjectCommunityRegion } from '../features/pages/subject-community-view';
import { createStoryRecordedKernelFetch } from '../kernel/fake';
import { communitySubject } from '../kernel/fake/subject-community';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectViewHref } from '../subject/subject-href';
import { PageStory, PatternStory } from './page';

type State = 'populated' | 'empty' | 'loading' | 'unavailable' | 'closed' | 'continuation';

function CommunityPattern({ state = 'populated' }: { state?: State }) {
  const locale = getLocale();
  const [data, setData] = useState<SubjectCommunity>();
  const [cursor, setCursor] = useState<string>();
  const [paged, setPaged] = useState(false);
  const [entry, setEntry] = useState<string>();
  useEffect(() => {
    let current = true;
    const client = createKernelClient('https://kernel.invalid', { fetch: createStoryRecordedKernelFetch() });
    void readSubjectCommunity(client, communitySubject.id, ['review'], paged, cursor).then((result) => {
      if (current) setData(result);
    });
    return () => {
      current = false;
    };
  }, [paged, cursor, locale]);
  if (entry) return <PageStory visitor="Signed In" path={entry} />;
  const loaded = data?.regions.review ?? { state: 'loading' };
  const region: CommunityRegion =
    state === 'populated'
      ? loaded
      : state === 'empty'
        ? { state: 'ready', threads: [], next: null }
        : state === 'continuation'
          ? { state: 'ready', threads: [], next: 'community-next' }
          : { state };
  const href = subjectViewHref(communitySubject, locale, 'reviews');
  return (
    <PatternStory>
      <div
        className="w-full max-w-4xl p-4 sm:p-8"
        onClick={(event) => {
          const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a') : null;
          if (!anchor) return;
          if (anchor.dataset.slot === 'create-thread') {
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
          id="subject-reviews"
          kind="review"
          region={region}
          authors={data?.authors ?? {}}
          now={data?.now ?? '2026-10-31T00:00:00.000Z'}
          subject={communitySubject}
          locale={locale}
          href={href}
          paged={paged}
        />
      </div>
    </PatternStory>
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
export const Empty: Story = { args: { state: 'empty' } };
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
