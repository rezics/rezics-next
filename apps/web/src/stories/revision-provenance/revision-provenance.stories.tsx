import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { RevisionProvenance } from '../../threads/revision-provenance-view';
import { STANDARD_QUESTION_ID } from '../../threads/review-vote';
import { m } from '../../paraglide/messages.js';

const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const citation = { questionId: STANDARD_QUESTION_ID, units: 14, revision: 2 };
const revision = { licence: 'CC-BY-SA-4.0', subjectIds: [subjectId], voteCitation: citation };
const meta = {
  title: 'Community/Revision provenance',
  id: 'patterns-community-revision-provenance',
  component: RevisionProvenance,
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl p-4 sm:p-8">
        <ContentItemFrame as="article" data-slot="content-item-frame" className="space-y-4 rounded-xl">
          <ContentItemHeading level={2} className="text-lg font-semibold">
            {m.thread_provenance_heading()}
          </ContentItemHeading>
          <Story />
        </ContentItemFrame>
      </div>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        story:
          'This composition uses supplied example values to show the reading hierarchy; it is not native response or authorization evidence.',
      },
    },
  },
  args: {
    revision,
    review: true,
    subjects: [{ id: subjectId, types: ['schema:Book'], label: 'The first edition', labels: {}, cover: null }],
  },
} satisfies Meta<typeof RevisionProvenance>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Recorded: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('heading', { level: 2, name: m.thread_provenance_heading() }),
    ).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="content-item-frame"]')).not.toBeNull();
    const link = within(canvasElement).getByRole('link', { name: 'The first edition' });
    await userEvent.tab();
    await expect(link).toHaveFocus();
    await expect(link).toHaveAttribute('href', expect.stringContaining(subjectId));
    await expect(within(canvasElement).queryByText(m.thread_provenance_current_vote())).toBeNull();
    const summary = canvasElement.querySelector('aside > dl');
    if (!summary) throw new Error('The scored revision has no rating summary.');
    await expect(summary).toHaveTextContent(m.discussion_provenance_details_rating_units({ units: '14' }));
    await expect(summary).not.toHaveTextContent(STANDARD_QUESTION_ID);
  },
};
export const ChangedVote: Story = {
  args: { currentVote: { ...citation, units: 0, revision: 7 } },
  parameters: {
    docs: {
      description: {
        story:
          'Constructed author-private vote example; it is shown only as supplied currentVote data and is not native authorization evidence.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.thread_provenance_rating())).toBeVisible();
    await expect(canvas.getByText(m.thread_provenance_current_vote())).toBeVisible();
    const summary = canvasElement.querySelector('aside > dl');
    if (!summary) throw new Error('The scored revision has no rating summary.');
    await expect(summary).not.toHaveTextContent(STANDARD_QUESTION_ID);
    const detailsSummary = canvas.getByText(m.discussion_provenance_details_heading());
    await userEvent.click(detailsSummary);
    await expect(
      canvas.getByText(m.thread_provenance_vote({ units: '14', questionId: STANDARD_QUESTION_ID, revision: '2' })),
    ).toBeVisible();
    await expect(
      canvas.getByText(m.thread_provenance_vote({ units: '0', questionId: STANDARD_QUESTION_ID, revision: '7' })),
    ).toBeVisible();
  },
};
export const UnavailableReference: Story = {
  args: { subjects: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.getByText(m.discussion_provenance_details_subject_unavailable())).toBeVisible();
    await userEvent.click(canvas.getByText(m.discussion_provenance_details_heading()));
    await expect(canvas.getByText(m.thread_provenance_subject_reference({ id: subjectId }))).toBeVisible();
  },
};
export const Unscored: Story = {
  args: { revision: { ...revision, voteCitation: null } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.thread_provenance_unscored())).toBeVisible();
    await expect(canvas.queryByText(m.discussion_provenance_details_heading())).toBeNull();
  },
};
export const PrivateReadUnavailable: Story = { args: { currentVote: null } };
export const UnchangedVote: Story = { args: { currentVote: citation } };

const longSubjectId = `${subjectId}-source-${'0123456789'.repeat(6)}`;
const longQuestionId = `${STANDARD_QUESTION_ID}-question-${'q'.repeat(48)}`;
const longSubjectTitle = 'A supplied subject title that remains complete while it wraps across a narrow reading column';
export const LongLocalizedReferences: Story = {
  args: {
    revision: {
      ...revision,
      subjectIds: [subjectId, longSubjectId],
      voteCitation: { ...citation, questionId: longQuestionId },
    },
    subjects: [
      {
        id: subjectId,
        types: ['schema:Book'],
        label: longSubjectTitle,
        labels: {},
        cover: null,
      },
    ],
    currentVote: { questionId: longQuestionId, units: 8, revision: 7 },
  },
  parameters: {
    docs: {
      description: {
        story:
          'Constructed long-label and author-private vote example for the 390px and 1280px viewports; it is not native authorization evidence.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: longSubjectTitle })).toBeVisible();
    await expect(canvas.getByText(m.discussion_provenance_details_subject_unavailable())).toBeVisible();
    await userEvent.click(canvas.getByText(m.discussion_provenance_details_heading()));
    await expect(canvas.getByText(m.thread_provenance_subject_reference({ id: longSubjectId }))).toBeVisible();
    await expect(canvas.getByText((text) => text.includes(longQuestionId))).toBeVisible();
    const details = canvasElement.querySelector('details');
    if (!details) throw new Error('The long source example has no native details region.');
    await expect(details.className).toContain('overflow-wrap:anywhere');
  },
};
