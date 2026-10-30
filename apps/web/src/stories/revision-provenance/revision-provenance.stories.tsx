import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RevisionProvenance } from '../../threads/revision-provenance-view';
import { STANDARD_QUESTION_ID } from '../../threads/review-vote';
import { m } from '../../paraglide/messages.js';

const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const citation = { questionId: STANDARD_QUESTION_ID, units: 14, revision: 2 };
const revision = { licence: 'CC-BY-SA-4.0', subjectIds: [subjectId], voteCitation: citation };
const meta = {
  title: 'Patterns/Community/Revision provenance',
  component: RevisionProvenance,
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl p-4 sm:p-8">
        <Story />
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
    const link = within(canvasElement).getByRole('link', { name: 'The first edition' });
    await userEvent.tab();
    await expect(link).toHaveFocus();
    await expect(link).toHaveAttribute('href', expect.stringContaining(subjectId));
    await expect(within(canvasElement).queryByText(m.thread_provenance_current_vote())).toBeNull();
  },
};
export const ChangedVote: Story = {
  args: { currentVote: { ...citation, units: 0, revision: 7 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.thread_provenance_rating())).toBeVisible();
    await expect(canvas.getByText(m.thread_provenance_current_vote())).toBeVisible();
  },
};
export const UnavailableReference: Story = {
  args: { subjects: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.getByText(m.thread_provenance_subject_reference({ id: subjectId }))).toBeVisible();
  },
};
export const Unscored: Story = { args: { revision: { ...revision, voteCitation: null } } };
export const PrivateReadUnavailable: Story = { args: { currentVote: null } };
export const UnchangedVote: Story = { args: { currentVote: citation } };
