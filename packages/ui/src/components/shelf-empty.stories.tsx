import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../shadcn/button.tsx';
import { ShelfEmpty } from './shelf-empty.tsx';
const meta = {
  title: 'Components/Shelf Empty',
  component: ShelfEmpty,
  args: {
    kind: 'library',
    title: 'Start your library',
    description: 'Add something to begin.',
    actions: (
      <>
        <Button>Browse</Button>
        <Button variant="outline">Import</Button>
      </>
    ),
  },
} satisfies Meta<typeof ShelfEmpty>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Library: Story = {};
export const Tab: Story = {
  args: {
    kind: 'tab',
    title: 'Nothing here yet',
    description: 'Find something to read next.',
    actions: <Button>Browse</Button>,
  },
};
export const NoMatch: Story = {
  args: {
    kind: 'no-match',
    title: 'No matches',
    description: 'Try changing your filters.',
    actions: <Button>Clear filters</Button>,
  },
};
