import type { Meta, StoryObj } from '@storybook/react-vite';
import { Bell, MessageCircle } from 'lucide-react';
import { Float } from './float.tsx';

const meta = {
  title: 'UI/Float',
  component: Float,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Use Float to anchor a small status mark to a REZICS avatar, Work cover or card; the mark should supplement nearby text rather than carry the only explanation.',
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
} satisfies Meta<typeof Float>;

export default meta;
type Story = StoryObj<typeof meta>;

const CoverCard = ({ dark = false }: { dark?: boolean }) => (
  <div className={dark ? 'dark rounded-2xl bg-background p-8 text-foreground' : 'p-8'}>
    <article className="relative w-72 rounded-2xl border border-border/60 bg-card p-5 shadow-[var(--aura-shadow-card)]">
      <div className="relative mb-4 grid size-20 place-items-center rounded-xl bg-accent text-accent-foreground">
        <Bell aria-hidden="true" className="size-8" />
        <Float
          aria-hidden="true"
          className="grid size-7 place-items-center rounded-full bg-primary font-semibold text-primary-foreground text-xs"
        >
          3
        </Float>
      </div>
      <h2 className="font-semibold text-foreground">Science Fiction Realm</h2>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
        <MessageCircle aria-hidden="true" className="size-4" />3 new discussion replies
      </p>
    </article>
  </div>
);

export const UpdateBadge: Story = { render: () => <CoverCard /> };
export const DarkMode: Story = { render: () => <CoverCard dark /> };
