import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { DocumentSpoiler } from './document-spoiler.tsx';

const meta = {
  title: 'Rezics UI/Document Spoiler',
  component: DocumentSpoiler,
  args: { children: 'Hidden passage' },
} satisfies Meta<typeof DocumentSpoiler>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AccessibleReveal: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Reveal spoiler' });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(button);
    await expect(within(canvasElement).getByText('Hidden passage')).toBeVisible();
  },
};
