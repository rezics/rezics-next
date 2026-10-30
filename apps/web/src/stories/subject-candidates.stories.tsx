import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CandidateStory } from '../subject/candidate-story';
import { m } from '../paraglide/messages.js';
import { candidateProperty } from '../kernel/fake/subject-candidates';

const meta = {
  title: 'Pages/Subjects/Candidate Review',
  component: CandidateStory,
  args: { page: true },
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
