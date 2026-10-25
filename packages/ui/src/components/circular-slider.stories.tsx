import type { Meta, StoryObj } from '@storybook/react-vite';
import { CircularSlider, CircularSliderValue } from './circular-slider.tsx';

const meta = {
  title: 'UI/CircularSlider',
  component: CircularSlider,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Use a circular slider for a bounded radial setting in REZICS, such as adjusting a reading-session target; keep the value and its unit visible beside the control.',
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
} satisfies Meta<typeof CircularSlider>;

export default meta;
type Story = StoryObj<typeof meta>;

const Dial = ({
  dark = false,
  disabled = false,
  size = 128,
}: {
  dark?: boolean;
  disabled?: boolean;
  size?: number;
}) => (
  <div className={dark ? 'rounded-2xl bg-background p-8 text-foreground' : 'p-8'}>
    <div className="flex flex-col items-center gap-4">
      <CircularSlider
        aria-label="Reading session target"
        defaultValue={225}
        disabled={disabled}
        markers
        size={size}
        step={5}
      >
        <CircularSliderValue aria-label="Reading session target" suffix="°" />
      </CircularSlider>
      <p className="max-w-56 text-center text-sm text-muted-foreground">
        Set the weekly reading-session goal for the Realm.
      </p>
    </div>
  </div>
);

export const Standard: Story = { render: () => <Dial /> };
export const Compact: Story = { render: () => <Dial size={96} /> };
export const Disabled: Story = { render: () => <Dial disabled /> };
export const DarkMode: Story = { globals: { theme: 'dark' }, render: () => <Dial dark /> };
