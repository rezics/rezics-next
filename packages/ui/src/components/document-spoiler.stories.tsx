import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { DocumentSpoiler } from './document-spoiler.tsx';

const meta = { title: 'Components/Document Spoiler', component: DocumentSpoiler } satisfies Meta<
  typeof DocumentSpoiler
>;
export default meta;
type Story = StoryObj<typeof meta>;

export const HiddenUntilRevealed: Story = {
  args: { children: 'The answer is 42.' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', { name: 'Reveal spoiler' });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(button);
    await expect(canvas.getByText('The answer is 42.')).toBeVisible();
  },
};
