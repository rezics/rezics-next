import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { BookmarkCheck, BookmarkPlus } from 'lucide-react';
import { Swap, SwapIndicator } from './swap.tsx';

const meta = {
  title: 'UI/Swap',
  component: Swap,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Use Swap in REZICS when one compact control changes between two clear states, such as adding or removing a Work from a member shelf.',
      },
    },
  },
  decorators: [
    (Story, context) => (
      <main
        className={
          context.name === 'Dark Mode'
            ? 'dark aura-canvas flex min-h-screen items-center justify-center bg-background p-6'
            : 'aura-canvas flex min-h-screen items-center justify-center bg-background p-6'
        }
      >
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Swap>;

export default meta;
type Story = StoryObj<typeof meta>;

const ShelfToggle = ({ dark = false }: { dark?: boolean }) => {
  const [saved, setSaved] = React.useState(false);
  return (
    <div className={dark ? 'dark rounded-2xl bg-background p-6 text-foreground' : 'p-6'}>
      <button
        aria-pressed={saved}
        className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border/60 bg-card px-4 font-medium text-sm text-foreground shadow-xs/5 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => setSaved((current) => !current)}
        type="button"
      >
        <Swap swap={saved} variant="scale">
          <SwapIndicator type="off">
            <span className="inline-flex items-center gap-2">
              <BookmarkPlus aria-hidden="true" className="size-4" /> Save to shelf
            </span>
          </SwapIndicator>
          <SwapIndicator type="on">
            <span className="inline-flex items-center gap-2">
              <BookmarkCheck aria-hidden="true" className="size-4 text-primary" /> On your shelf
            </span>
          </SwapIndicator>
        </Swap>
      </button>
    </div>
  );
};

export const ShelfAction: Story = {
  render: () => <ShelfToggle />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', { name: /Save to shelf/ });
    await userEvent.click(button);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByRole('button', { name: /On your shelf/ })).toBeVisible();
  },
};

export const DarkMode: Story = { render: () => <ShelfToggle dark /> };
