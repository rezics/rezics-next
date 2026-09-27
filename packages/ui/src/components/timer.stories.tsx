import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  Timer,
  TimerArea,
  TimerControl,
  TimerItem,
  TimerItemGroup,
  TimerPause,
  TimerReset,
  TimerStart,
} from './timer.tsx';

const meta = {
  title: 'UI/Timer',
  component: Timer,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Use a timer in REZICS for an optional reading sprint or a time-bounded moderation review; keep controls explicit and announce the remaining time accessibly.',
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
} satisfies Meta<typeof Timer>;

export default meta;
type Story = StoryObj<typeof meta>;

const ReadingTimer = ({ dark = false }: { dark?: boolean }) => (
  <section className={dark ? 'rounded-2xl bg-background p-6 text-foreground' : 'p-6'}>
    <h2 className="mb-4 font-semibold text-foreground">Reading sprint</h2>
    <Timer
      autoStart={false}
      countdown
      startMs={90_000}
      targetMs={0}
      translations={{
        areaLabel: (_time, formatted) =>
          `${formatted.minutes} minutes and ${formatted.seconds} seconds remaining`,
      }}
    >
      <TimerArea>
        <TimerItemGroup aria-label="Time remaining" className="flex-row gap-2">
          <TimerItem aria-label="Minutes remaining" type="minutes" />
          <span aria-hidden="true" className="text-muted-foreground">
            :
          </span>
          <TimerItem aria-label="Seconds remaining" type="seconds" />
        </TimerItemGroup>
      </TimerArea>
      <TimerControl>
        <TimerStart className="rounded-xl bg-primary px-4 py-2 font-medium text-primary-foreground text-sm focus-visible:outline-2 focus-visible:outline-ring">
          Start
        </TimerStart>
        <TimerPause className="rounded-xl border border-border/60 bg-card px-4 py-2 font-medium text-foreground text-sm focus-visible:outline-2 focus-visible:outline-ring">
          Pause
        </TimerPause>
        <TimerReset className="rounded-xl border border-border/60 bg-card px-4 py-2 font-medium text-foreground text-sm focus-visible:outline-2 focus-visible:outline-ring">
          Reset
        </TimerReset>
      </TimerControl>
    </Timer>
  </section>
);

export const ReadingSession: Story = {
  render: () => <ReadingTimer />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Start' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Pause' }));
    await expect(canvas.getByRole('button', { name: 'Reset' })).toBeEnabled();
  },
};

export const DarkMode: Story = { globals: { theme: 'dark' }, render: () => <ReadingTimer dark /> };
