import type { Meta, StoryObj } from '@storybook/react-vite';
import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';
import { expect, waitFor, within } from 'storybook/test';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@rezics/ui/shadcn/chart';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Chart',
  component: ChartContainer,
  tags: ['autodocs'],
  decorators: [withSurface],
  args: { config: {}, children: <BarChart data={[]} /> },
} satisfies Meta<typeof ChartContainer>;
export default meta;
type Story = StoryObj<typeof meta>;

const config = {
  read: { label: 'Finished', color: 'var(--chart-1)' },
  started: { label: 'Started', color: 'var(--chart-2)' },
} satisfies ChartConfig;

const months = [
  { month: 'May', read: 4, started: 6 },
  { month: 'June', read: 7, started: 5 },
  { month: 'July', read: 3, started: 8 },
  { month: 'August', read: 9, started: 4 },
];

const Books = ({ data, chartConfig }: { data: typeof months; chartConfig: ChartConfig }) => (
  <ChartContainer config={chartConfig} className="h-64 w-full max-w-md" aria-label="Books per month" role="img">
    <BarChart data={data} accessibilityLayer={false}>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="month" tickLine={false} axisLine={false} />
      <ChartTooltip content={<ChartTooltipContent />} />
      <ChartLegend content={<ChartLegendContent />} />
      <Bar dataKey="read" fill="var(--color-read)" radius={4} />
      <Bar dataKey="started" fill="var(--color-started)" radius={4} />
    </BarChart>
  </ChartContainer>
);

export const Default: Story = {
  render: () => <Books data={months} chartConfig={config} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('img', { name: 'Books per month' })).toBeVisible();
    await waitFor(() => expect(canvasElement.querySelectorAll('.recharts-bar-rectangle').length).toBe(8));
    await expect(await canvas.findByText('Finished')).toBeVisible();
    await expect(canvas.getByText('Started')).toBeVisible();
  },
};

export const LongAndCjkLabels: Story = {
  render: () => (
    <Books
      data={[
        { month: '五月', read: 4, started: 6 },
        { month: '六月（暑假）', read: 7, started: 5 },
        { month: '七月', read: 3, started: 8 },
      ]}
      chartConfig={{
        read: { label: '讀完的書', color: 'var(--chart-1)' },
        started: { label: 'Started but not yet finished', color: 'var(--chart-2)' },
      }}
    />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('讀完的書')).toBeVisible();
    await expect(canvas.getByText('六月（暑假）')).toBeVisible();
  },
};

export const NoData: Story = {
  render: () => <Books data={[]} chartConfig={config} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('img', { name: 'Books per month' })).toBeVisible();
    await expect(canvasElement.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(0);
  },
};
