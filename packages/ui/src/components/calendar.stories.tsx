import { parseDate } from '@ark-ui/react/date-picker';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import {
  Calendar,
  CalendarMonthSelect,
  CalendarNextTrigger,
  CalendarPrevTrigger,
  CalendarTable,
  CalendarTableDays,
  CalendarTableNextMonth,
  CalendarTodayTrigger,
  CalendarView,
  CalendarViewControl,
  CalendarViewDate,
  CalendarWeekDays,
  CalendarYearSelect,
} from './calendar.tsx';

const Month = ({ selects = false }: { selects?: boolean }) => (
  <CalendarView view="day">
    <CalendarViewControl>
      <CalendarPrevTrigger />
      {selects ? (
        <div className="flex gap-2">
          <CalendarMonthSelect />
          <CalendarYearSelect />
        </div>
      ) : (
        <CalendarViewDate />
      )}
      <CalendarNextTrigger />
    </CalendarViewControl>
    <CalendarTable>
      <CalendarWeekDays />
      <CalendarTableDays />
    </CalendarTable>
  </CalendarView>
);

const meta = {
  title: 'Rezics UI/Calendar',
  component: Calendar,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'An always-visible month grid for choosing a date or a range, with full keyboard navigation. In REZICS use it inline where the calendar is the content: scheduling a Realm reading-club session, picking a reading-challenge range, or showing when a serialised Work publishes chapters. It is built from parts (view control, week days, day table) so layouts can show one or two months; Date Picker puts the same parts in a popover.',
      },
    },
  },
  args: {
    defaultValue: [parseDate('2026-10-14')],
    defaultFocusedValue: parseDate('2026-10-14'),
    locale: 'en-US',
  },
  decorators: [
    (Story, { parameters }) => (
      <div className={cn(parameters.theme === 'dark' && 'dark [color-scheme:dark]')}>
        <div className="min-h-96 bg-background p-6 font-sans text-foreground">
          <Story />
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <Calendar {...args}>
      <Month />
    </Calendar>
  ),
} satisfies Meta<typeof Calendar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('grid')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: /October 21, 2026/ }));
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: /October 21, 2026/ })).toHaveAttribute(
        'data-selected',
      ),
    );
    await userEvent.keyboard('{ArrowRight}{Enter}');
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: /October 22, 2026/ })).toHaveAttribute(
        'data-selected',
      ),
    );
    await userEvent.click(canvas.getByRole('button', { name: /next/i }));
    await expect(canvas.getByText('November 2026')).toBeInTheDocument();
  },
};

export const Range: Story = {
  args: {
    selectionMode: 'range',
    defaultValue: [parseDate('2026-10-05'), parseDate('2026-10-18')],
  },
};

export const TwoMonths: Story = {
  args: {
    selectionMode: 'range',
    defaultValue: [parseDate('2026-10-25'), parseDate('2026-11-08')],
    numOfMonths: 2,
  },
  render: (args) => (
    <Calendar {...args}>
      <CalendarView view="day">
        <CalendarViewControl>
          <CalendarPrevTrigger />
          <CalendarViewDate />
          <CalendarNextTrigger />
        </CalendarViewControl>
        <div className="flex gap-6">
          <CalendarTable>
            <CalendarWeekDays />
            <CalendarTableDays />
          </CalendarTable>
          <CalendarTable>
            <CalendarWeekDays />
            <CalendarTableNextMonth />
          </CalendarTable>
        </div>
      </CalendarView>
    </Calendar>
  ),
};

export const WithSelects: Story = {
  render: (args) => (
    <Calendar {...args}>
      <Month selects />
    </Calendar>
  ),
};

export const WithToday: Story = {
  render: (args) => (
    <Calendar {...args}>
      <Month />
      <CalendarTodayTrigger className="mt-3 w-full" size="sm" />
    </Calendar>
  ),
};

export const Unavailable: Story = {
  args: {
    min: parseDate('2026-10-06'),
    max: parseDate('2026-10-28'),
    isDateUnavailable: (date) => date.day === 7 || date.day === 21,
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-CN', startOfWeek: 1 },
  render: (args) => (
    <Calendar {...args}>
      <Month />
      <CalendarTodayTrigger className="mt-3 w-full" size="sm">
        今天
      </CalendarTodayTrigger>
    </Calendar>
  ),
};

export const Disabled: Story = { args: { disabled: true } };

export const Dark: Story = {
  parameters: { theme: 'dark' },
  render: (args) => (
    <div className="flex flex-wrap gap-6">
      <Calendar {...args}>
        <Month selects />
      </Calendar>
      <Calendar
        {...args}
        defaultValue={[parseDate('2026-10-05'), parseDate('2026-10-18')]}
        selectionMode="range"
      >
        <Month />
      </Calendar>
    </div>
  ),
};
