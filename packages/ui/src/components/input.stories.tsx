import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
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
    await expect(
      within(canvasElement).getByRole('textbox', { name: 'Original title' }),
    ).toHaveAttribute('aria-invalid', 'true');
  },
};

export const Disabled: Story = {
  render: () => (
    <Field disabled>
      <FieldLabel>Imported title</FieldLabel>
      <Input defaultValue="三体" />
    </Field>
  ),
};
