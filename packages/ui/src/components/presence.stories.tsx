import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from './button.tsx';
import { Presence } from './presence.tsx';

const meta = {
  title: 'UI/Presence',
  component: Presence,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Use Presence to mount and unmount short-lived REZICS feedback, such as confirming that a Work was added to a shelf, while keeping the surrounding page stable.',
      },
    },
  },
  decorators: [
    (Story) => (
      <main
        className={'aura-canvas flex min-h-screen items-center justify-center bg-background p-6'}
      >
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Presence>;

export default meta;
type Story = StoryObj<typeof meta>;

const ShelfFeedback = ({ dark = false }: { dark?: boolean }) => {
  const [visible, setVisible] = React.useState(true);
  return (
    <section
      className={
        dark
          ? 'rounded-2xl bg-background p-6 text-foreground'
          : 'rounded-2xl border border-border/60 bg-card p-6'
      }
    >
      <Button onClick={() => setVisible((current) => !current)} variant="outline">
        {visible ? 'Hide confirmation' : 'Show confirmation'}
      </Button>
      <Presence present={visible}>
        <p
          className="mt-4 rounded-xl bg-success/10 px-4 py-3 text-sm text-success-foreground"
          role="status"
        >
          《三体》 was added to your reading shelf.
        </p>
      </Presence>
    </section>
  );
};

export const ShelfConfirmation: Story = {
  render: () => <ShelfFeedback />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Hide confirmation' }));
    await expect(canvas.getByRole('button', { name: 'Show confirmation' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Show confirmation' }));
    await expect(canvas.getByRole('status')).toBeVisible();
  },
};

export const DarkMode: Story = { globals: { theme: 'dark' }, render: () => <ShelfFeedback dark /> };
