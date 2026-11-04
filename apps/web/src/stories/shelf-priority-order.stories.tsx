import type { Meta, StoryObj } from '@storybook/react-vite';
import { ShelfScoreUnavailable } from '../library/shelf-view';

const meta = {
  title: 'Patterns/Library/Priority order',
  component: ShelfScoreUnavailable,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ShelfScoreUnavailable>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unavailable: Story = {
  args: {
    locale: 'en',
    view: { type: 'schema:Book', state: 'planned', orderBy: 'priority', direction: 'asc', cursor: 'retained' },
  },
};
