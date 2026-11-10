import type { Meta, StoryObj } from '@storybook/react-vite';
import { ShelfTitlePreparation } from '../library/shelf-title-preparation';

const meta = {
  title: 'Library/Title preparation',
  id: 'patterns-library-title-preparation',
  component: ShelfTitlePreparation,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ShelfTitlePreparation>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Preparing: Story = {
  args: {
    isCurrent: () => true,
    prepare: async () => ({ installation: 'pending', prepared: 20 }),
    refresh: async () => {},
  },
};
