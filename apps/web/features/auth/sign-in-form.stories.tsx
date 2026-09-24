import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SignInForm } from '../../app/sign-in/sign-in-form.tsx';

const meta = { title: 'Auth/Sign in', component: SignInForm,
  args: { next: '/studio' },
  decorators: [Story => <main className="page-width"><div className="auth-layout"><Story /></div></main>],
} satisfies Meta<typeof SignInForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignIn: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('textbox', { name: 'Email' })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /^Sign in$/ })).toBeInTheDocument();
  },
};

export const CreateAccount: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create an account' }));
    await expect(canvas.getByRole('heading', { name: 'Create your REZICS account' })).toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /^Create account$/ })).toBeInTheDocument();
  },
};
