import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldDescription, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Checkbox',
  component: Checkbox,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Checkbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Field orientation="horizontal">
      <Checkbox id="checkbox-notify" />
      <FieldLabel htmlFor="checkbox-notify">Email me about new editions</FieldLabel>
    </Field>
  ),
  async play({ canvasElement }) {
    const checkbox = within(canvasElement).getByRole('checkbox', { name: 'Email me about new editions' });
    await expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    await userEvent.click(within(canvasElement).getByText('Email me about new editions'));
    await waitFor(() => expect(checkbox).not.toBeChecked());
  },
};

export const KeyboardAndChecked: Story = {
  render: () => (
    <Field orientation="horizontal">
      <Checkbox id="checkbox-private" defaultChecked />
      <FieldLabel htmlFor="checkbox-private">Keep this shelf private</FieldLabel>
    </Field>
  ),
  async play({ canvasElement }) {
    const checkbox = within(canvasElement).getByRole('checkbox', { name: 'Keep this shelf private' });
    await expect(checkbox).toBeChecked();
    await userEvent.tab();
    await expect(checkbox).toHaveFocus();
    await userEvent.keyboard(' ');
    await waitFor(() => expect(checkbox).not.toBeChecked());
  },
};

export const Disabled: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Field orientation="horizontal" data-disabled="true">
        <Checkbox id="checkbox-off" disabled />
        <FieldLabel htmlFor="checkbox-off">Show spoilers (managed by your Realm)</FieldLabel>
      </Field>
      <Field orientation="horizontal" data-disabled="true">
        <Checkbox id="checkbox-on" disabled defaultChecked />
        <FieldLabel htmlFor="checkbox-on">Show content warnings (required)</FieldLabel>
      </Field>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('checkbox', { name: /^Show spoilers/ })).toHaveAttribute('aria-disabled', 'true');
    await expect(canvas.getByRole('checkbox', { name: /^Show content warnings/ })).toBeChecked();
    await userEvent.click(canvas.getByRole('checkbox', { name: /^Show spoilers/ }));
    await expect(canvas.getByRole('checkbox', { name: /^Show spoilers/ })).not.toBeChecked();
  },
};

const Terms = () => {
  const [accepted, setAccepted] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const invalid = submitted && !accepted;
  return (
    <form
      className="max-w-sm"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}
    >
      <Field orientation="horizontal" data-invalid={invalid || undefined}>
        <Checkbox
          id="checkbox-terms"
          checked={accepted}
          onCheckedChange={setAccepted}
          aria-invalid={invalid || undefined}
          aria-describedby="checkbox-terms-help"
        />
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor="checkbox-terms">I accept the community rules</FieldLabel>
          {invalid ? (
            <FieldError id="checkbox-terms-help">You must accept the rules to join.</FieldError>
          ) : (
            <FieldDescription id="checkbox-terms-help">Spoiler tags, credits and civility.</FieldDescription>
          )}
        </div>
      </Field>
      <button type="submit" className="mt-3 rounded-md border px-3 py-1 text-sm">
        Join
      </button>
    </form>
  );
};

export const Invalid: Story = {
  render: () => <Terms />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Join' }));
    const checkbox = canvas.getByRole('checkbox', { name: 'I accept the community rules' });
    await expect(checkbox).toBeInvalid();
    await expect(await canvas.findByRole('alert')).toHaveTextContent('You must accept the rules to join.');
    await userEvent.click(checkbox);
    await waitFor(() => expect(canvas.queryByRole('alert')).toBeNull());
  },
};

export const LongAndCjkLabels: Story = {
  render: () => (
    <div className="flex max-w-xs flex-col gap-3">
      <Field orientation="horizontal">
        <Checkbox id="checkbox-long" />
        <FieldLabel htmlFor="checkbox-long">
          Notify me when any edition, translation or audiobook of a Work on this shelf is added to the catalogue
        </FieldLabel>
      </Field>
      <Field orientation="horizontal">
        <Checkbox id="checkbox-cjk" defaultChecked />
        <FieldLabel htmlFor="checkbox-cjk">有新版本或新譯本時通知我（日本語の通知も含む）</FieldLabel>
      </Field>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('checkbox', { name: /^Notify me when any edition/ })).toBeVisible();
    await expect(canvas.getByRole('checkbox', { name: /^有新版本/ })).toBeChecked();
  },
};
