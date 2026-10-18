import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { expectControlBoundary } from '../test/control-contrast.ts';
import { Field, FieldError, FieldLabel } from './field.tsx';
import { Input } from './input.tsx';

const meta = {
  title: 'Rezics UI/Input',
  component: Input,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-sm p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Field>
      <FieldLabel>Work title</FieldLabel>
      <Input placeholder="The Three-Body Problem" />
    </Field>
  ),
};

export const EmptyFields: Story = {
  globals: { theme: 'light' },
  render: () => (
    <div className="flex flex-col gap-4">
      {['bg-background', 'bg-card', 'bg-muted'].map(surface => (
        <div className={`flex flex-col gap-4 rounded-2xl border p-4 ${surface}`} key={surface}>
          <Field>
            <FieldLabel>Display name</FieldLabel>
            <Input autoComplete="off" />
          </Field>
          <Field>
            <FieldLabel>Email</FieldLabel>
            <Input autoComplete="off" type="email" />
          </Field>
        </div>
      ))}
    </div>
  ),
  async play({ canvasElement }) {
    const inputs = within(canvasElement).getAllByRole('textbox');
    for (const input of inputs) {
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue('');
      await expect(input).not.toHaveFocus();
      await expectControlBoundary(input);
    }
    const first = inputs[0]!;
    await userEvent.tab();
    await expect(first).toHaveFocus();
    await expectControlBoundary(first);
    await userEvent.type(first, 'Reader');
    await expect(first).toHaveValue('Reader');
    await userEvent.clear(first);
    first.blur();
  },
};

export const EmptyFieldsDark: Story = { ...EmptyFields, globals: { theme: 'dark' } };

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel>Small</FieldLabel>
        <Input size="sm" placeholder="Small" />
      </Field>
      <Field>
        <FieldLabel>Medium</FieldLabel>
        <Input placeholder="Medium" />
      </Field>
      <Field>
        <FieldLabel>Large</FieldLabel>
        <Input size="lg" placeholder="Large" />
      </Field>
    </div>
  ),
};

export const Invalid: Story = {
  render: () => (
    <Field invalid>
      <FieldLabel>Original title</FieldLabel>
      <Input defaultValue="" />
      <FieldError>Give the Work a title.</FieldError>
    </Field>
  ),
  async play({ canvasElement }) {
    const input = within(canvasElement).getByRole('textbox', { name: 'Original title' });
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expectControlBoundary(input);
    await userEvent.tab();
    await expect(input).toHaveFocus();
    await expectControlBoundary(input);
    input.blur();
  },
};

export const InvalidDark: Story = { ...Invalid, globals: { theme: 'dark' } };

export const Disabled: Story = {
  render: () => (
    <Field disabled>
      <FieldLabel>Imported title</FieldLabel>
      <Input defaultValue="三体" />
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox', { name: 'Imported title' })).toBeDisabled();
  },
};
