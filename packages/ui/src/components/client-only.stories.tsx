import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ClientOnly } from './client-only.tsx';

const meta = {
  title: 'UI/ClientOnly',
  component: ClientOnly,
  tags: ['autodocs'],
  args: { children: () => <span />, fallback: null },
  parameters: {
    docs: {
      description: {
        component:
          'Use ClientOnly for REZICS details that depend on browser state, such as restoring a local reading position; provide a useful fallback for the initial render.',
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
} satisfies Meta<typeof ClientOnly>;

export default meta;
type Story = StoryObj<typeof meta>;

const ShelfPreview = ({ dark = false, empty = false }: { dark?: boolean; empty?: boolean }) => (
  <section
    className={
      dark
        ? 'dark rounded-2xl bg-background p-6 text-foreground'
        : 'rounded-2xl border border-border/60 bg-card p-6'
    }
  >
    <h2 className="font-semibold text-foreground">Continue reading</h2>
    <ClientOnly
      fallback={<p className="mt-3 text-sm text-muted-foreground">Restoring your reading shelf…</p>}
    >
      {() => (
        <p className="mt-3 text-sm text-muted-foreground">
          {empty
            ? 'Your shelf has no Works yet.'
            : '《三体》 · Chapter 4 · last opened on this device'}
        </p>
      )}
    </ClientOnly>
  </section>
);

export const RestoredShelf: Story = {
  render: () => <ShelfPreview />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('《三体》 · Chapter 4 · last opened on this device'),
    ).toBeVisible();
  },
};

export const EmptyShelf: Story = { render: () => <ShelfPreview empty /> };
export const DarkMode: Story = { render: () => <ShelfPreview dark /> };
