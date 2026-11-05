import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Field',
  component: Field,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Field>;
export default meta;
type Story = StoryObj<typeof meta>;

const ShelfForm = () => {
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const invalid = submitted && name.trim() === '';
  return (
    <form
      className="max-w-sm"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}
    >
      <FieldSet>
        <FieldLegend>Create a shelf</FieldLegend>
        <FieldGroup>
          <Field data-invalid={invalid || undefined}>
            <FieldLabel htmlFor="shelf-name">Shelf name</FieldLabel>
            <Input
              id="shelf-name"
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? 'shelf-name-error' : 'shelf-name-help'}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {invalid ? (
              <FieldError id="shelf-name-error">Give the shelf a name.</FieldError>
            ) : (
              <FieldDescription id="shelf-name-help">
                Visible on your profile to anyone you share it with.
              </FieldDescription>
            )}
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="shelf-private" />
            <FieldLabel htmlFor="shelf-private">Keep this shelf private</FieldLabel>
          </Field>
          <Button type="submit">Create shelf</Button>
        </FieldGroup>
      </FieldSet>
    </form>
  );
};

export const Default: Story = {
  render: () => <ShelfForm />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('textbox', { name: 'Shelf name' })).toHaveAccessibleDescription(
      'Visible on your profile to anyone you share it with.',
    );
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Keep this shelf private' }));
    await expect(canvas.getByRole('checkbox', { name: 'Keep this shelf private' })).toBeChecked();
  },
};

export const Invalid: Story = {
  render: () => <ShelfForm />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create shelf' }));
    await expect(canvas.getByRole('alert')).toHaveTextContent('Give the shelf a name.');
    const input = canvas.getByRole('textbox', { name: 'Shelf name' });
    await expect(input).toBeInvalid();
    await expect(input).toHaveAccessibleDescription('Give the shelf a name.');
    await userEvent.type(input, 'Hard science fiction');
    await expect(canvas.queryByRole('alert')).toBeNull();
  },
};
