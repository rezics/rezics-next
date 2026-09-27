import type { Meta, StoryObj } from '@storybook/react-vite';
import { Marquee, MarqueeContent, MarqueeItem } from './marquee.tsx';

const realms = [
  'Science Fiction',
  'Modern Poetry',
  '城市与记忆',
  'Community translations',
  'Film adaptations',
];

const meta = {
  title: 'UI/Marquee',
  component: Marquee,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Use a marquee sparingly in REZICS to show a nonessential stream of Realm names or recent catalogue topics; keep the full information available elsewhere and honor reduced-motion preferences.',
      },
    },
  },
  decorators: [
    (Story, context) => (
      <main
        className={
          context.name === 'Dark Mode'
            ? 'dark aura-canvas flex min-h-screen items-center bg-background p-6'
            : 'aura-canvas flex min-h-screen items-center bg-background p-6'
        }
      >
        <div className="mx-auto w-full max-w-3xl">
          <Story />
        </div>
      </main>
    ),
  ],
} satisfies Meta<typeof Marquee>;

export default meta;
type Story = StoryObj<typeof meta>;

const RealmStream = ({
  dark = false,
  orientation = 'horizontal',
}: {
  dark?: boolean;
  orientation?: 'horizontal' | 'vertical';
}) => (
  <section className={dark ? 'dark rounded-2xl bg-background p-6 text-foreground' : 'p-6'}>
    <h2 className="mb-4 font-semibold text-foreground">Active reading communities</h2>
    <Marquee
      aria-label="Active reading communities"
      className={orientation === 'vertical' ? 'h-48' : ''}
      orientation={orientation}
      speed={32}
    >
      <MarqueeContent className="gap-3">
        {realms.map((realm) => (
          <MarqueeItem key={realm}>
            <span className="inline-flex rounded-full border border-border/60 bg-card px-4 py-2 text-sm text-foreground">
              {realm}
            </span>
          </MarqueeItem>
        ))}
      </MarqueeContent>
    </Marquee>
  </section>
);

export const Horizontal: Story = { render: () => <RealmStream /> };
export const Vertical: Story = { render: () => <RealmStream orientation="vertical" /> };
export const DarkMode: Story = { render: () => <RealmStream dark /> };
