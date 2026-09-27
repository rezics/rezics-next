import type { Meta, StoryObj } from '@storybook/react-vite';
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltipContent, type ChartConfig } from './chart.tsx';

const data = [
  { month: 'Jan', ratings: 18 },
  { month: 'Feb', ratings: 27 },
  { month: 'Mar', ratings: 21 },
  { month: 'Apr', ratings: 34 },
  { month: 'May', ratings: 29 },
  { month: 'Jun', ratings: 42 },
];

const config = {
  ratings: { label: 'Ratings recorded', theme: { light: 'var(--brand)', dark: 'var(--brand)' } },
} satisfies ChartConfig;

const meta = {
  title: 'UI/Chart',
  component: ChartContainer,
  tags: ['autodocs'],
  args: { children: <div />, config },
  parameters: {
    docs: {
      description: {
        component:
          'Use charts in REZICS to summarize community activity such as ratings over time; pair every visualization with a plain-language summary so the data remains understandable without color or hover.',
      },
    },
  },
  decorators: [
    (Story, context) => (
      <main
        className={
          context.name === 'Dark Mode'
            ? 'dark aura-canvas min-h-screen bg-background p-6'
            : 'aura-canvas min-h-screen bg-background p-6'
        }
      >
        <div className="mx-auto max-w-3xl pt-10">
          <Story />
        </div>
      </main>
    ),
  ],
} satisfies Meta<typeof ChartContainer>;

export default meta;
type Story = StoryObj<typeof meta>;

const RatingsChart = ({ dark = false, empty = false }: { dark?: boolean; empty?: boolean }) => (
  <div className={dark ? 'dark rounded-2xl bg-background p-4 text-foreground' : undefined}>
    <figure>
      <figcaption className="mb-3">
        <h2 className="font-semibold text-foreground text-lg">Realm ratings this year</h2>
        <p className="text-sm text-muted-foreground">
          Members recorded {empty ? 'no ratings yet' : '171 ratings from January through June'}.
        </p>
      </figcaption>
      {empty ? (
        <div className="flex aspect-video items-center justify-center rounded-2xl border border-dashed border-border/60 bg-card text-center text-sm text-muted-foreground">
          Ratings will appear here when this Realm has activity.
        </div>
      ) : (
        <ChartContainer
          aria-label="Bar chart: 18 ratings in January, rising to 42 in June"
          className="w-full"
          config={config}
          role="img"
        >
          <BarChart accessibilityLayer data={data} margin={{ top: 12, right: 12, bottom: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis axisLine={false} dataKey="month" tickLine={false} />
            <YAxis allowDecimals={false} axisLine={false} tickLine={false} width={32} />
            <Tooltip content={<ChartTooltipContent />} cursor={false} />
            <Bar dataKey="ratings" fill="var(--color-ratings)" radius={[8, 8, 0, 0]} />
          </BarChart>
        </ChartContainer>
      )}
    </figure>
  </div>
);

export const RatingsOverTime: Story = { render: () => <RatingsChart /> };
export const Empty: Story = { render: () => <RatingsChart empty /> };
export const DarkMode: Story = { render: () => <RatingsChart dark /> };
