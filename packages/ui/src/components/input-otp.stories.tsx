import type { Meta, StoryObj } from '@storybook/react-vite';
import { Fragment, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Field, FieldError, FieldHelper, FieldLabel } from './field.tsx';
import { InputOTP, InputOTPSeparator, InputOTPSlot } from './input-otp.tsx';

const Slots = ({ count = 6, split = 3 }: { count?: number; split?: number }) => (
  <>
    {Array.from({ length: count }, (_, index) => (
      <Fragment key={index}>
        {index === split && <InputOTPSeparator />}
        <InputOTPSlot index={index} />
      </Fragment>
    ))}
  </>
);

const meta = {
  title: 'Rezics UI/Input OTP',
  component: InputOTP,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A row of single-character cells for one-time codes. In REZICS use it for the email verification code at sign-up, two-factor sign-in on the Accounts site, and confirming a Realm ownership transfer. It sets `autocomplete="one-time-code"`, moves focus between cells, and accepts a pasted code.',
      },
    },
  },
  decorators: [
    (Story, { parameters }) => (
      <div className={cn(parameters.theme === 'dark' && 'dark')}>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <Story />
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <Field>
      <FieldLabel>Verification code</FieldLabel>
      <InputOTP {...args}>
        <Slots />
      </InputOTP>
      <FieldHelper>We sent a 6-digit code to ye.wenjie@example.com.</FieldHelper>
    </Field>
  ),
} satisfies Meta<typeof InputOTP>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const cells = within(canvasElement).getAllByRole('textbox');
    await expect(cells).toHaveLength(6);
    await userEvent.click(cells[0] as HTMLElement);
    await userEvent.keyboard('271828');
    await expect(cells.map((cell) => (cell as HTMLInputElement).value).join('')).toBe('271828');
    await userEvent.keyboard('{Backspace}');
    await expect(cells[5]).toHaveValue('');
  },
};

const Completed = () => {
  const [code, setCode] = useState('');
  return (
    <Field>
      <FieldLabel>Verification code</FieldLabel>
      <InputOTP
        onValueChange={({ valueAsString }) =>
          setCode(valueAsString.length === 6 ? valueAsString : '')
        }
      >
        <Slots />
      </InputOTP>
      <FieldHelper>
        {code ? `Checking ${code}…` : 'Paste or type the code from your email.'}
      </FieldHelper>
    </Field>
  );
};

export const Paste: Story = {
  render: () => <Completed />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByRole('textbox')[0] as HTMLElement);
    await userEvent.paste('314159');
    await expect(await canvas.findByText('Checking 314159…')).toBeInTheDocument();
  },
};

export const Filled: Story = { args: { defaultValue: ['4', '2', '1', '9', '7', '3'] } };

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <InputOTP
          aria-label={`Code (${size})`}
          defaultValue={['1', '9', '7']}
          key={size}
          size={size}
        >
          <Slots />
        </InputOTP>
      ))}
    </div>
  ),
};

export const FourDigits: Story = {
  render: (args) => (
    <Field>
      <FieldLabel>Transfer PIN</FieldLabel>
      <InputOTP {...args} mask>
        <Slots count={4} split={-1} />
      </InputOTP>
      <FieldHelper>Masked, because it confirms transferring ownership of 科幻 Realm.</FieldHelper>
    </Field>
  ),
};

export const Invalid: Story = {
  args: { defaultValue: ['0', '0', '0', '0', '0', '0'] },
  render: (args) => (
    <Field invalid>
      <FieldLabel>Verification code</FieldLabel>
      <InputOTP {...args}>
        <Slots />
      </InputOTP>
      <FieldError>That code has expired. Request a new one.</FieldError>
    </Field>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args) => (
    <Field disabled>
      <FieldLabel>Verification code</FieldLabel>
      <InputOTP {...args}>
        <Slots />
      </InputOTP>
      <FieldHelper>Too many attempts. Try again in 5 minutes.</FieldHelper>
    </Field>
  ),
  async play({ canvasElement }) {
    for (const cell of within(canvasElement).getAllByRole('textbox')) {
      await expect(cell).toBeDisabled();
    }
  },
};

export const Chinese: Story = {
  render: (args) => (
    <Field>
      <FieldLabel>验证码</FieldLabel>
      <InputOTP {...args}>
        <Slots />
      </InputOTP>
      <FieldHelper>我们已向 ye.wenjie@example.com 发送 6 位验证码，10 分钟内有效。</FieldHelper>
    </Field>
  ),
};

export const Dark: Story = {
  parameters: { theme: 'dark' },
  render: (args, context) => (
    <div className="flex flex-col gap-6">
      {meta.render({ ...args, defaultValue: ['4', '2', '1'] })}
      {Invalid.render?.({ ...args, defaultValue: ['0', '0', '0', '0', '0', '0'] }, context)}
    </div>
  ),
};
