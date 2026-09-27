import { parseDate } from '@ark-ui/react/date-picker';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { DateInput, DateInputLabel } from './date-input.tsx';

const meta = {
  title: 'Rezics UI/Date Input',
  component: DateInput,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A keyboard-first date field made of editable segments that follow the locale’s order. In REZICS use it where readers type a known date rather than browse a calendar: a Work’s first publication date, an edition’s release date, or the start and end of a Realm reading challenge (`selectionMode="range"`). Pass `locale` so zh-CN readers see 年/月/日 order; use Date Picker when browsing a month helps.',
      },
    },
  },
  args: { locale: 'en-US', defaultValue: [parseDate('2008-01-01')] },
  decorators: [
    (Story, { parameters }) => (
      <div className={cn(parameters.theme === 'dark' && 'dark')}>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <div className="flex max-w-xs flex-col gap-4">
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <DateInput {...args}>
      <DateInputLabel>First published</DateInputLabel>
    </DateInput>
  ),
} satisfies Meta<typeof DateInput>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const segments = canvas.getAllByRole('spinbutton');
    await expect(segments).toHaveLength(3);
    await userEvent.click(segments[0] as HTMLElement);
    await userEvent.keyboard('{ArrowUp}');
    await waitFor(() => expect(segments[0]).toHaveTextContent('02'));
  },
};

export const Empty: Story = { args: { defaultValue: undefined } };

export const WithClear: Story = {
  args: { showClear: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Clear date' }));
    await waitFor(() =>
      expect(canvas.queryByRole('button', { name: 'Clear date' })).not.toBeInTheDocument(),
    );
  },
};

export const Range: Story = {
  args: {
    selectionMode: 'range',
    separator: '–',
    defaultValue: [parseDate('2026-10-01'), parseDate('2026-10-31')],
  },
  render: (args) => (
    <DateInput {...args}>
      <DateInputLabel>Reading challenge dates</DateInputLabel>
    </DateInput>
  ),
};

export const Sizes: Story = {
  render: (args) => (
    <>
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <DateInput {...args} key={size} size={size}>
          <DateInputLabel>First published ({size})</DateInputLabel>
        </DateInput>
      ))}
    </>
  ),
};

export const Invalid: Story = {
  args: { invalid: true, defaultValue: [parseDate('2099-01-01')] },
  render: (args) => (
    <DateInput {...args}>
      <DateInputLabel>First published</DateInputLabel>
    </DateInput>
  ),
};

export const Disabled: Story = { args: { disabled: true } };

export const ReadOnly: Story = { args: { readOnly: true } };

export const Chinese: Story = {
  args: { locale: 'zh-CN', defaultValue: [parseDate('2008-01-01')] },
  render: (args) => (
    <DateInput {...args}>
      <DateInputLabel>《三体》首次出版日期</DateInputLabel>
    </DateInput>
  ),
};

export const Dark: Story = {
  parameters: { theme: 'dark' },
  render: (args, context) => (
    <>
      {meta.render(args)}
      {Range.render?.({ ...args, ...Range.args }, context)}
      {Invalid.render?.({ ...args, ...Invalid.args }, context)}
    </>
  ),
};
