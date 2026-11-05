import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { REGEXP_ONLY_DIGITS } from 'input-otp';
import { expect, userEvent, within } from 'storybook/test';
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@rezics/ui/shadcn/input-otp';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Input OTP',
  component: InputOTPGroup,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof InputOTPGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

const Code = ({ disabled, invalid }: { disabled?: boolean; invalid?: boolean }) => {
  const [value, setValue] = useState('');
  return (
    <div className="grid gap-2">
      <InputOTP
        maxLength={6}
        pattern={REGEXP_ONLY_DIGITS}
        aria-label="Verification code"
        aria-invalid={invalid || undefined}
        disabled={disabled}
        value={value}
        onChange={setValue}
      >
        <InputOTPGroup>
          <InputOTPSlot index={0} aria-invalid={invalid || undefined} />
          <InputOTPSlot index={1} aria-invalid={invalid || undefined} />
          <InputOTPSlot index={2} aria-invalid={invalid || undefined} />
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
          <InputOTPSlot index={3} aria-invalid={invalid || undefined} />
          <InputOTPSlot index={4} aria-invalid={invalid || undefined} />
          <InputOTPSlot index={5} aria-invalid={invalid || undefined} />
        </InputOTPGroup>
      </InputOTP>
      <p className="text-sm text-muted-foreground" data-testid="entered">
        {value ? `Entered ${value}` : 'Enter the six digits we emailed you.'}
      </p>
    </div>
  );
};

export const Default: Story = {
  render: () => <Code />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('textbox', { name: 'Verification code' });
    await userEvent.click(input);
    await userEvent.keyboard('12ab34');
    // Letters are rejected by the digit pattern.
    await expect(canvas.getByTestId('entered')).toHaveTextContent('Entered 1234');
    await userEvent.keyboard('56');
    await expect(input).toHaveValue('123456');
  },
};

export const Paste: Story = {
  render: () => <Code />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('textbox', { name: 'Verification code' }));
    await userEvent.paste('987654');
    await expect(canvas.getByTestId('entered')).toHaveTextContent('Entered 987654');
  },
};

export const Disabled: Story = {
  render: () => <Code disabled />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox', { name: 'Verification code' })).toBeDisabled();
  },
};

export const Invalid: Story = {
  render: () => <Code invalid />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox', { name: 'Verification code' })).toBeInvalid();
  },
};
