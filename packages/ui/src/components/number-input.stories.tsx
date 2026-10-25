import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Field, FieldError, FieldHelper, FieldLabel } from './field.tsx';
import {
  NumberInput,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
  NumberInputInput,
  NumberInputScrubber,
} from './number-input.tsx';

const meta = {
  title: 'Rezics UI/Number Input',
  component: NumberInput,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A numeric field with step buttons, arrow-key, Home/End and wheel stepping, clamping on blur, and `Intl.NumberFormat` formatting. In REZICS use it for the current page or chapter in reading progress, the first publication year in the Work editor, and limits in Realm settings such as slow-mode minutes. Pass `formatOptions` for units or grouping and `translations` for the step button labels.',
      },
    },
  },
  args: { defaultValue: '128', min: 0, max: 402 },
  decorators: [
    (Story, { parameters }) => (
      <div>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <div className="flex max-w-xs flex-col gap-4">
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <Field>
      <FieldLabel>Current page</FieldLabel>
      <NumberInput {...args}>
        <NumberInputGroup>
          <NumberInputDecrement />
          <NumberInputInput />
          <NumberInputIncrement />
        </NumberInputGroup>
      </NumberInput>
      <FieldHelper>《三体》 (Tor Books, 2014) has 402 pages.</FieldHelper>
    </Field>
  ),
} satisfies Meta<typeof NumberInput>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('spinbutton', { name: 'Current page' });
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowDown}');
    await waitFor(() => expect(input).toHaveValue('129'));
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(input).toHaveValue('402'));
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(input).toHaveValue('0'));
  },
};

export const Accessibility: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('spinbutton', { name: 'Current page' });
    await expect(input).toHaveAttribute('aria-valuenow', '128');
    await expect(input).toHaveAttribute('aria-valuemin', '0');
    await expect(input).toHaveAttribute('aria-valuemax', '402');
    await expect(canvas.getByRole('button', { name: 'Increase' })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Decrease' })).toBeInTheDocument();
  },
};

export const AtMaximum: Story = {
  args: { defaultValue: '402' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Increase' })).toBeDisabled();
  },
};

export const Empty: Story = { args: { defaultValue: undefined } };

export const InputOnly: Story = {
  args: { defaultValue: '1965', min: 1000, max: 2100, formatOptions: { useGrouping: false } },
  render: (args) => (
    <Field>
      <FieldLabel>First published</FieldLabel>
      <NumberInput {...args}>
        <NumberInputGroup>
          <NumberInputInput className="text-start" />
        </NumberInputGroup>
      </NumberInput>
    </Field>
  ),
};

export const Scrubber: Story = {
  args: { defaultValue: '10', min: 0, max: 120, step: 5 },
  render: (args) => (
    <NumberInput {...args}>
      <NumberInputScrubber>Slow mode (minutes)</NumberInputScrubber>
      <NumberInputGroup>
        <NumberInputDecrement />
        <NumberInputInput />
        <NumberInputIncrement />
      </NumberInputGroup>
    </NumberInput>
  ),
};

export const Sizes: Story = {
  render: (args) => (
    <>
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Field key={size}>
          <FieldLabel>Chapter ({size})</FieldLabel>
          <NumberInput {...args} size={size}>
            <NumberInputGroup>
              <NumberInputDecrement />
              <NumberInputInput />
              <NumberInputIncrement />
            </NumberInputGroup>
          </NumberInput>
        </Field>
      ))}
    </>
  ),
};

export const Invalid: Story = {
  args: { defaultValue: '0' },
  render: (args) => (
    <Field invalid>
      <FieldLabel>Current page</FieldLabel>
      <NumberInput {...args}>
        <NumberInputGroup>
          <NumberInputDecrement />
          <NumberInputInput />
          <NumberInputIncrement />
        </NumberInputGroup>
      </NumberInput>
      <FieldError>Start from page 1.</FieldError>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('spinbutton')).toBeInvalid();
  },
};

export const Disabled: Story = {
  render: (args) => (
    <Field disabled>
      <FieldLabel>Current page</FieldLabel>
      <NumberInput {...args}>
        <NumberInputGroup>
          <NumberInputDecrement />
          <NumberInputInput />
          <NumberInputIncrement />
        </NumberInputGroup>
      </NumberInput>
      <FieldHelper>Finish the edition choice first.</FieldHelper>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('spinbutton')).toBeDisabled();
  },
};

export const Chinese: Story = {
  args: {
    defaultValue: '12500',
    min: 0,
    max: 1000000,
    step: 100,
    locale: 'zh-CN',
    formatOptions: { useGrouping: true },
    translations: { incrementLabel: '增加', decrementLabel: '减少' },
  },
  render: (args) => (
    <Field>
      <FieldLabel>已读字数</FieldLabel>
      <NumberInput {...args}>
        <NumberInputGroup>
          <NumberInputDecrement />
          <NumberInputInput />
          <NumberInputIncrement />
        </NumberInputGroup>
      </NumberInput>
      <FieldHelper>《银河英雄传说》第一卷约 20 万字。</FieldHelper>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: '增加' })).toBeInTheDocument();
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: (args, context) => (
    <>
      {meta.render(args)}
      {Invalid.render?.({ ...args, defaultValue: '0' }, context)}
      {Disabled.render?.(args, context)}
    </>
  ),
};
