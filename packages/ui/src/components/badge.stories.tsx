import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from './badge.tsx';

const meta = {
  title: 'Rezics UI/Badge',
  component: Badge,
  tags: ['autodocs'],
  args: { children: 'Reading' },
  decorators: [
    (Story) => (
      <div className="flex min-h-40 items-center p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Badge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SemanticTints: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3">
      <Badge variant="success">Published</Badge>
      <Badge variant="info">Source statistic</Badge>
      <Badge variant="warning">Needs review</Badge>
      <Badge variant="destructive">Removed</Badge>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Badge size="sm">Small</Badge>
      <Badge size="md">Medium</Badge>
      <Badge size="lg">Large</Badge>
    </div>
  ),
};
