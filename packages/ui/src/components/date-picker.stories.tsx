import { parseDate } from '@ark-ui/react/date-picker';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { CalendarIcon } from 'lucide-react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button } from './button.tsx';
import {
  CalendarNextTrigger,
  CalendarPrevTrigger,
  CalendarTable,
  CalendarTableDays,
  CalendarView,
  CalendarViewControl,
  CalendarViewDate,
  CalendarWeekDays,
} from './calendar.tsx';
import {
  DatePicker,
  DatePickerContent,
  DatePickerInput,
  DatePickerLabel,
  DatePickerPresetTrigger,
  DatePickerTrigger,
  DatePickerValue,
} from './date-picker.tsx';

const Month = () => (
  <CalendarView view="day">
    <CalendarViewControl>
      <CalendarPrevTrigger />
      <CalendarViewDate />
      <CalendarNextTrigger />
    </CalendarViewControl>
    <CalendarTable>
      <CalendarWeekDays />
      <CalendarTableDays />
    </CalendarTable>
  </CalendarView>
);

const Surface = ({ children }: { children: React.ReactNode }) => {
  return (
    <div>
      <div className="min-h-[30rem] bg-background p-6 font-sans text-foreground">
        <div className="flex max-w-xs flex-col gap-4">{children}</div>
      </div>
    </div>
  );
};

const meta = {
  title: 'Rezics UI/Date Picker',
  component: DatePicker,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A date field with a calendar popover: readers can type the date or browse a month. In REZICS use it for dates people rarely know by heart, such as when a Realm reading-club session happens, a “read on” date for a shelf entry, or a moderation suspension end date. It shares its parts with Calendar; use Date Input for dates typed from a source, like a publication date.',
      },
    },
  },
  args: { locale: 'en-US', defaultValue: [parseDate('2026-10-14')] },
  decorators: [
    (Story) => (
      <Surface>
        <Story />
      </Surface>
    ),
  ],
  render: (args) => (
    <DatePicker {...args}>
      <DatePickerLabel>Reading club session</DatePickerLabel>
      <DatePickerInput placeholder="mm/dd/yyyy" />
      <DatePickerContent>
        <Month />
      </DatePickerContent>
    </DatePicker>
  ),
} satisfies Meta<typeof DatePicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const input = canvas.getByRole('textbox', { name: 'Reading club session' });
    await expect(input).toHaveValue('10/14/2026');
    await userEvent.click(canvas.getByRole('button', { name: /calendar/i }));
    const grid = await page.findByRole('grid');
    await waitFor(() => expect(grid).toBeVisible());
    await userEvent.click(page.getByRole('button', { name: /October 21, 2026/ }));
    await waitFor(() => expect(input).toHaveValue('10/21/2026'));
  },
};

export const Typed: Story = {
  args: { defaultValue: undefined },
  async play({ canvasElement }) {
    const input = within(canvasElement).getByRole('textbox', { name: 'Reading club session' });
    await userEvent.type(input, '11/05/2026{Enter}');
    await waitFor(() => expect(input).toHaveValue('11/05/2026'));
  },
};

export const Open: Story = { args: { defaultOpen: true } };

export const ButtonTrigger: Story = {
  args: { defaultValue: undefined },
  render: (args) => (
    <DatePicker {...args}>
      <DatePickerLabel>Read on</DatePickerLabel>
      <DatePickerTrigger asChild>
        <Button className="w-full" variant="outline">
          <CalendarIcon aria-hidden />
          <DatePickerValue placeholder="Pick a date" />
        </Button>
      </DatePickerTrigger>
      <DatePickerContent>
        <Month />
      </DatePickerContent>
    </DatePicker>
  ),
};

export const Range: Story = {
  args: {
    selectionMode: 'range',
    defaultValue: [parseDate('2026-10-05'), parseDate('2026-10-18')],
    defaultOpen: true,
  },
  render: (args) => (
    <DatePicker {...args}>
      <DatePickerLabel>Suspension period</DatePickerLabel>
      <div className="flex gap-2">
        <DatePickerInput index={0} placeholder="Start" />
        <DatePickerInput index={1} placeholder="End" />
      </div>
      <DatePickerContent>
        <div className="mb-2 flex flex-wrap gap-1.5">
          <DatePickerPresetTrigger asChild value="last7Days">
            <Button size="xs" variant="soft">
              Last 7 days
            </Button>
          </DatePickerPresetTrigger>
          <DatePickerPresetTrigger asChild value="thisMonth">
            <Button size="xs" variant="soft">
              This month
            </Button>
          </DatePickerPresetTrigger>
        </div>
        <Month />
      </DatePickerContent>
    </DatePicker>
  ),
};

export const Invalid: Story = { args: { invalid: true, defaultValue: [parseDate('2025-01-01')] } };

export const Disabled: Story = {
  args: { disabled: true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox')).toBeDisabled();
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-CN', startOfWeek: 1, defaultOpen: true },
  render: (args) => (
    <DatePicker {...args}>
      <DatePickerLabel>读书会日期</DatePickerLabel>
      <DatePickerInput />
      <DatePickerContent>
        <Month />
      </DatePickerContent>
    </DatePicker>
  ),
};

export const Dark: Story = { globals: { theme: 'dark' }, args: { defaultOpen: true } };
