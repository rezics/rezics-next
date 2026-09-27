import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Show } from './show.tsx';

const meta = {
  title: 'UI/Show',
  component: Show,
  tags: ['autodocs'],
  args: { children: '4.6 out of 5 · 287 member ratings', when: true },
  parameters: {
    docs: {
      description: {
        component:
          'Use Show for a small conditional REZICS fragment when the visible fallback is useful, such as explaining why a Work has no community rating yet.',
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
} satisfies Meta<typeof Show>;

export default meta;
type Story = StoryObj<typeof meta>;

const RatingSummary = ({
  dark = false,
  hasRatings = true,
}: {
  dark?: boolean;
  hasRatings?: boolean;
}) => (
  <section
    className={
      dark
        ? 'dark rounded-2xl bg-background p-6 text-foreground'
        : 'rounded-2xl border border-border/60 bg-card p-6'
    }
  >
    <h2 className="font-semibold text-foreground">《三体》 community rating</h2>
    <Show
      fallback={
        <p className="mt-2 text-sm text-muted-foreground">
          No member ratings yet. Be the first to rate this Work.
        </p>
      }
      when={hasRatings}
    >
      <p className="mt-2 text-sm text-foreground">4.6 out of 5 · 287 member ratings</p>
    </Show>
  </section>
);

export const HasRatings: Story = { render: () => <RatingSummary /> };
export const Empty: Story = {
  render: () => <RatingSummary hasRatings={false} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('No member ratings yet. Be the first to rate this Work.'),
    ).toBeVisible();
  },
};
export const DarkMode: Story = { render: () => <RatingSummary dark /> };
