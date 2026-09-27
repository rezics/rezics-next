import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Field, FieldError, FieldHelper, FieldLabel } from './field.tsx';
import {
  PasswordInput,
  PasswordInputGroup,
  PasswordInputInput,
  PasswordInputTrigger,
} from './password-input.tsx';

const meta = {
  title: 'Rezics UI/Password Input',
  component: PasswordInput,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A password field with a show/hide button. In REZICS use it on the Accounts sign-in and sign-up forms, when changing a password, and when confirming a sensitive action such as transferring Realm ownership. Set `autoComplete` to `current-password` or `new-password` so password managers fill it, and pass `translations` for the button label outside English.',
      },
    },
  },
  args: { autoComplete: 'current-password' },
  decorators: [
    (Story, { parameters }) => (
      <div className={cn(parameters.theme === 'dark' && 'dark')}>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <div className="flex max-w-sm flex-col gap-4">
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <Field>
      <FieldLabel>Password</FieldLabel>
      <PasswordInput {...args}>
        <PasswordInputGroup>
          <PasswordInputInput placeholder="Your REZICS password" />
          <PasswordInputTrigger />
        </PasswordInputGroup>
      </PasswordInput>
    </Field>
  ),
} satisfies Meta<typeof PasswordInput>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText('Password');
    await userEvent.type(input, 'red-coast-1971');
    await expect(input).toHaveAttribute('type', 'password');
    await userEvent.click(canvas.getByRole('button', { name: /show password/i }));
    await expect(input).toHaveAttribute('type', 'text');
    await expect(input).toHaveValue('red-coast-1971');
    await userEvent.click(canvas.getByRole('button', { name: /hide password/i }));
    await expect(input).toHaveAttribute('type', 'password');
  },
};

export const Visible: Story = {
  args: { defaultVisible: true },
  render: (args) => (
    <Field>
      <FieldLabel>Password</FieldLabel>
      <PasswordInput {...args}>
        <PasswordInputGroup>
          <PasswordInputInput defaultValue="red-coast-1971" />
          <PasswordInputTrigger />
        </PasswordInputGroup>
      </PasswordInput>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByLabelText('Password')).toHaveAttribute('type', 'text');
  },
};

export const Sizes: Story = {
  render: (args) => (
    <>
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Field key={size}>
          <FieldLabel>Password ({size})</FieldLabel>
          <PasswordInput {...args} size={size}>
            <PasswordInputGroup>
              <PasswordInputInput size={size} />
              <PasswordInputTrigger />
            </PasswordInputGroup>
          </PasswordInput>
        </Field>
      ))}
    </>
  ),
};

export const NewPassword: Story = {
  args: { autoComplete: 'new-password' },
  render: (args) => (
    <Field>
      <FieldLabel>New password</FieldLabel>
      <PasswordInput {...args}>
        <PasswordInputGroup>
          <PasswordInputInput />
          <PasswordInputTrigger />
        </PasswordInputGroup>
      </PasswordInput>
      <FieldHelper>
        At least 12 characters. A passphrase like “dark forest sophon” works well.
      </FieldHelper>
    </Field>
  ),
};

export const Invalid: Story = {
  render: (args) => (
    <Field invalid>
      <FieldLabel>Password</FieldLabel>
      <PasswordInput {...args}>
        <PasswordInputGroup>
          <PasswordInputInput defaultValue="sophon" />
          <PasswordInputTrigger />
        </PasswordInputGroup>
      </PasswordInput>
      <FieldError>That password does not match this account.</FieldError>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByLabelText('Password')).toBeInvalid();
  },
};

export const Disabled: Story = {
  render: (args) => (
    <Field disabled>
      <FieldLabel>Password</FieldLabel>
      <PasswordInput {...args} disabled>
        <PasswordInputGroup>
          <PasswordInputInput defaultValue="red-coast-1971" />
          <PasswordInputTrigger />
        </PasswordInputGroup>
      </PasswordInput>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByLabelText('Password')).toBeDisabled();
  },
};

export const Chinese: Story = {
  args: {
    translations: { visibilityTrigger: (visible: boolean) => (visible ? '隐藏密码' : '显示密码') },
  },
  render: (args) => (
    <Field>
      <FieldLabel>密码</FieldLabel>
      <PasswordInput {...args}>
        <PasswordInputGroup>
          <PasswordInputInput placeholder="输入你的 REZICS 密码" />
          <PasswordInputTrigger />
        </PasswordInputGroup>
      </PasswordInput>
      <FieldHelper>忘记密码？可以通过邮箱重置。</FieldHelper>
    </Field>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '显示密码' }));
    await expect(canvas.getByRole('button', { name: '隐藏密码' })).toBeInTheDocument();
  },
};

export const Dark: Story = {
  parameters: { theme: 'dark' },
  render: (args, context) => (
    <>
      {meta.render(args)}
      {Invalid.render?.(args, context)}
      {Disabled.render?.(args, context)}
    </>
  ),
};
