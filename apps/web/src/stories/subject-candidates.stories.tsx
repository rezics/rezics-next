import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CandidateStory } from '../subject/candidate-story';
import { m } from '../paraglide/messages.js';
import { candidateProperty } from '../kernel/fake/subject-candidates';
import { AppShell } from '../shell/shell';
import { pagePaths, PatternStory } from './page';

const meta = {
  title: 'Subjects/Candidate Review',
  id: 'pages-subjects-candidate-review',
  component: CandidateStory,
  args: { page: true },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path={pagePaths.subject}>
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CandidateStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReviewImportedSuggestion: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = within(await canvas.findByRole('region', { name: m.candidate_title() }));
    await userEvent.click(region.getByRole('button', { name: m.candidate_entry() }));
    await userEvent.selectOptions(
      await region.findByRole('combobox', { name: m.candidate_field() }),
      candidateProperty,
    );
    await userEvent.click(await region.findByRole('button', { name: m.candidate_review() }));
    expect(region.getByRole('heading', { name: m.candidate_current() })).toBeTruthy();
    expect(canvas.getByRole('heading', { level: 1 })).toBeTruthy();
  },
};

// Page states reuse the review pattern's interactions and the ordinary subject shell.
import {
  RejectSuggestion as reject,
  RankedSelection as ranked,
  StaleRankedSelection as stale,
} from './subject-candidate-review.stories';
export const RejectSuggestion: Story = { ...reject, args: { ...reject.args, page: true } };
export const RankedSelection: Story = { ...ranked, args: { ...ranked.args, page: true } };
export const StaleRankedSelection: Story = { ...stale, args: { ...stale.args, page: true } };
