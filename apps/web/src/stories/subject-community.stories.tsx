import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { createKernelClient } from '@rezics/client';
import {
  readSubjectCommunity,
  type CommunityKind,
  type CommunityRegion,
  type SubjectCommunity,
} from '../features/pages/subject-community';
import { SubjectCommunityContext, SubjectCommunityRegion } from '../features/pages/subject-community-view';
import { createStoryRecordedKernelFetch } from '../kernel/fake';
import { communityCharacter, communitySubject } from '../kernel/fake/subject-community';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectViewHref } from '../subject/subject-href';
import { PatternStory } from './page';

type State = 'populated' | 'empty' | 'loading' | 'unavailable' | 'closed' | 'continuation';
const storyReader = 'story-reader';

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
  const loaded = data?.regions[kind] ?? { state: 'loading' };
  const region: CommunityRegion =
    state === 'populated'
      ? loaded
      : state === 'empty'
        ? { state: 'ready', threads: [], next: null }
        : state === 'continuation'
          ? { state: 'ready', threads: [], next: 'community-next' }
          : { state };
  const href = subjectViewHref(subject, locale, kind === 'review' ? 'reviews' : 'discussion');
  return (
    <SubjectCommunityContext.Provider value={data}>
      <PatternStory>
        <div
          className="w-full max-w-4xl p-4 sm:p-8"
          onClick={(event) => {
            const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a') : null;
            if (!anchor) return;
            if (anchor.dataset.slot === 'see-all' || anchor.dataset.slot === 'community-next') {
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
          />
        </div>
      </PatternStory>
    </SubjectCommunityContext.Provider>
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
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.subject_community_discuss() })).toBeNull();
  },
};
export const Empty: Story = {
  args: { state: 'empty' },
  parameters: {
    docs: {
      description: {
        story:
          'Illustrative terminal Global empty region. Creation remains unavailable until Content supplies current action advice for the exact Subject and place.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.subject_community_board_unavailable())).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.subject_choose_review_board() })).toBeNull();
  },
};
export const Loading: Story = { args: { state: 'loading' } };
export const Unavailable: Story = { args: { state: 'unavailable' } };
export const Closed: Story = { args: { state: 'closed' } };
export const FilteredPage: Story = { args: { state: 'continuation' } };
