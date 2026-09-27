import type { Meta, StoryObj } from '@storybook/react-vite';
import { HeartIcon } from 'lucide-react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Rating, RatingLabel } from './rating.tsx';

const meta = {
  title: 'Rezics UI/Rating',
  component: Rating,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A star rating that readers set with pointer or arrow keys, or that displays an average read-only. In REZICS use it for a reader’s rating of a Work (half stars allowed), the read-only average on Work cards and pages next to its count and Context label, and review scores in a Realm. Stars use the `--rating` color; show the number as text beside a read-only rating so it is not conveyed by color and shape alone.',
      },
    },
  },
  args: { defaultValue: 4, allowHalf: true },
  decorators: [
    (Story, { parameters }) => (
      <div className={cn(parameters.theme === 'dark' && 'dark')}>
        <div className="flex min-h-32 flex-col gap-6 bg-background p-6 font-sans text-foreground">
          <Story />
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <Rating {...args}>
      <RatingLabel>Your rating of 《三体》</RatingLabel>
    </Rating>
  ),
} satisfies Meta<typeof Rating>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const radios = canvas.getAllByRole('radio');
    await expect(radios).toHaveLength(5);
    const hidden = canvasElement.querySelector('input') as HTMLInputElement;
    await expect(hidden).toHaveValue('4');
    await userEvent.click(radios[1] as HTMLElement);
    await waitFor(() => expect(hidden).toHaveValue('2'));
  },
};

export const Empty: Story = { args: { defaultValue: undefined } };

export const ReadOnlyAverage: Story = {
  args: { readOnly: true, defaultValue: 4.5, size: 'sm' },
  render: (args) => (
    <div className="flex items-center gap-2 text-sm">
      <Rating {...args} aria-label="Average rating 4.3 out of 5" />
      <span className="font-medium tabular-nums">4.3</span>
      <span className="text-muted-foreground">· 12,408 ratings · Science fiction readers</span>
    </div>
  ),
};

export const Sizes: Story = {
  render: (args) => (
    <>
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Rating {...args} key={size} size={size}>
          <RatingLabel>Rating ({size})</RatingLabel>
        </Rating>
      ))}
    </>
  ),
};

export const TenPoint: Story = {
  args: { count: 10, allowHalf: false, defaultValue: 8, size: 'sm' },
  render: (args) => (
    <Rating {...args}>
      <RatingLabel>Realm review score (out of 10)</RatingLabel>
    </Rating>
  ),
};

export const CustomIcon: Story = {
  args: { icon: <HeartIcon />, allowHalf: false, defaultValue: 3 },
  render: (args) => (
    <Rating {...args}>
      <RatingLabel>How much did this chapter move you?</RatingLabel>
    </Rating>
  ),
};

export const Disabled: Story = { args: { disabled: true } };

export const Chinese: Story = {
  args: { defaultValue: 3.5 },
  render: (args) => (
    <Rating {...args}>
      <RatingLabel>你对《银河英雄传说》的评分</RatingLabel>
    </Rating>
  ),
};

export const Dark: Story = {
  parameters: { theme: 'dark' },
  render: (args, context) => (
    <>
      {meta.render(args)}
      {ReadOnlyAverage.render?.({ ...args, ...ReadOnlyAverage.args }, context)}
      {meta.render({ ...args, disabled: true })}
    </>
  ),
};
