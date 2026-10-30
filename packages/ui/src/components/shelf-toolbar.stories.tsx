import type { Meta, StoryObj } from '@storybook/react-vite';
import { ShelfTypeChips } from './shelf-toolbar.tsx';
const meta = {
  title: 'Components/Shelf Toolbar',
  component: ShelfTypeChips,
  args: {
    label: 'Type',
    options: [
      { value: 'all', label: 'All types' },
      { value: 'books', label: 'Books' },
    ],
    value: 'all',
    onValueChange: () => {},
  },
} satisfies Meta<typeof ShelfTypeChips>;
export default meta;
export const Types: StoryObj<typeof meta> = {};
