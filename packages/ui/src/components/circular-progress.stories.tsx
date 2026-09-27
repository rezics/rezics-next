import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { CircularProgress, CircularProgressValue } from './circular-progress.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div className={cn('bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Feedback/Circular Progress',
  component: CircularProgress,
  tags: ['autodocs'],
  decorators: [surface],
  args: { value: 64, 'aria-label': 'Reading challenge progress' },
  parameters: {
    docs: {
      description: {
        component:
          'A ring for a measurable amount in a tight space: a reading-challenge badge on a profile, a Work card showing how far the reader is, or an upload next to a cover. Put a `CircularProgressValue` inside for the percentage. The ring carries the `progressbar` role, so give it an `aria-label`. Use the linear Progress when there is room for a label.',
      },
    },
  },
} satisfies Meta<typeof CircularProgress>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const ring = within(canvasElement).getByRole('progressbar', {
      name: 'Reading challenge progress',
    });
    await expect(ring).toHaveAttribute('aria-valuenow', '64');
  },
};

export const WithValue: Story = {
  args: { size: 56, thickness: 5 },
  render: (args) => (
    <CircularProgress {...args}>
      <CircularProgressValue className="absolute" />
    </CircularProgress>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('64%')).toBeVisible();
  },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      {(
        [
          [20, 3],
          [32, 4],
          [48, 5],
          [72, 6],
        ] as const
      ).map(([size, thickness]) => (
        <CircularProgress
          aria-label={`Upload progress, ${size}px`}
          key={size}
          size={size}
          thickness={thickness}
          value={40}
        />
      ))}
    </div>
  ),
};

export const States: Story = {
  render: () => (
    <div className="flex items-center gap-6 text-sm">
      {[0, 25, 100].map((value) => (
        <div className="flex flex-col items-center gap-2" key={value}>
          <CircularProgress aria-label={`Challenge at ${value}%`} size={48} value={value}>
            <CircularProgressValue className="absolute" />
          </CircularProgress>
          <span className="text-muted-foreground">{value === 100 ? 'Complete' : 'Reading'}</span>
        </div>
      ))}
    </div>
  ),
};

export const Indeterminate: Story = {
  args: { indeterminate: true, 'aria-label': 'Uploading cover' },
  async play({ canvasElement }) {
    const ring = within(canvasElement).getByRole('progressbar', { name: 'Uploading cover' });
    await expect(ring).not.toHaveAttribute('aria-valuenow');
  },
};

export const Chinese: Story = {
  name: 'zh-CN',
  render: () => (
    <div className="flex items-center gap-3 text-sm" lang="zh-CN">
      <CircularProgress aria-label="年度阅读挑战" size={48} thickness={5} value={37}>
        <CircularProgressValue className="absolute" />
      </CircularProgress>
      <span>
        <span className="block font-medium">2026 年度阅读挑战</span>
        <span className="text-muted-foreground">已读 18 / 48 本，含《三体》三部曲</span>
      </span>
    </div>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <div className="flex items-center gap-6">
      <CircularProgress aria-label="Reading challenge" size={56} thickness={5} value={64}>
        <CircularProgressValue className="absolute" />
      </CircularProgress>
      <CircularProgress aria-label="Uploading cover" indeterminate />
    </div>
  ),
};
