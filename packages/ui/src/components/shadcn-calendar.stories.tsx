import type { Meta, StoryObj } from '@storybook/react-vite';
import { ja, zhTW } from 'date-fns/locale';
import type { Labels } from 'react-day-picker';
import { useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Calendar } from '@rezics/ui/shadcn/calendar';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Calendar',
  component: Calendar,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Calendar>;
export default meta;
type Story = StoryObj<typeof meta>;

const october = new Date(2026, 9, 1);

// react-day-picker's default day label spells the day as an ordinal ("27th") while the button shows "27", which
// fails the accessibility rule that visible text be part of the accessible name. Name each day with the full date.
const labelsFor = (language: string): Partial<Labels> => ({
  labelDayButton: (date, modifiers) => {
    const label = new Intl.DateTimeFormat(language, { dateStyle: 'full' }).format(date);
    return modifiers.selected ? `${label}, selected` : label;
  },
});
const labels = labelsFor('en');

const Single = () => {
  const [selected, setSelected] = useState<Date | undefined>(new Date(2026, 9, 14));
  return (
    <div className="w-fit">
      <Calendar
        labels={labels}
        mode="single"
        required={false}
        defaultMonth={october}
        selected={selected}
        onSelect={setSelected}
      />
      <p className="mt-2 text-sm" aria-live="polite">
        {selected ? `Session on ${selected.toDateString()}` : 'No session date'}
      </p>
    </div>
  );
};

export const Default: Story = {
  render: () => <Single />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Session on Wed Oct 14 2026')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /October 20, 2026/ }));
    await expect(await canvas.findByText('Session on Tue Oct 20 2026')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /October 20, 2026/ }));
    await expect(await canvas.findByText('No session date')).toBeVisible();
  },
};

const Range = () => {
  const [range, setRange] = useState<DateRange | undefined>({ from: new Date(2026, 9, 5), to: new Date(2026, 9, 9) });
  return (
    <div className="w-fit">
      <Calendar labels={labels} mode="range" defaultMonth={october} selected={range} onSelect={setRange} />
      <p className="mt-2 text-sm" aria-live="polite">
        {range?.from ? `${range.from.getDate()} to ${range.to?.getDate() ?? '…'}` : 'No range'}
      </p>
    </div>
  );
};

export const SelectedRange: Story = {
  render: () => <Range />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('5 to 9')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /October 12, 2026/ }));
    await waitFor(() => expect(canvas.getByText(/^(5|9|12) to /)).toBeVisible());
  },
};

export const DisabledDays: Story = {
  render: () => (
    <Calendar
      labels={labels}
      mode="single"
      defaultMonth={october}
      disabled={[{ before: new Date(2026, 9, 10) }, { dayOfWeek: [0, 6] }]}
    />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: /October 5, 2026/ })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: /October 17, 2026/ })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: /October 14, 2026/ })).toBeEnabled();
  },
};

export const Navigation: Story = {
  render: () => <Calendar labels={labels} mode="single" defaultMonth={october} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('October 2026')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /next month/i }));
    await expect(await canvas.findByText('November 2026')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /previous month/i }));
    await expect(await canvas.findByText('October 2026')).toBeVisible();
  },
};

export const TraditionalChinese: Story = {
  render: () => (
    <Calendar labels={labelsFor('zh-TW')} mode="single" locale={zhTW} defaultMonth={october} showOutsideDays={false} />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/2026年10月/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /2026年10月14日/ }));
    await waitFor(() => expect(canvas.getByRole('button', { name: /2026年10月14日.*selected/ })).toBeVisible());
  },
};

export const Japanese: Story = {
  render: () => (
    <Calendar labels={labelsFor('ja')} mode="single" locale={ja} defaultMonth={october} showOutsideDays={false} />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/2026年10月/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: /2026年10月1日/ })).toBeVisible();
  },
};
