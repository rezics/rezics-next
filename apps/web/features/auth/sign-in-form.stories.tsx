import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card, CardContent } from '@rezics/ui/card';
import { expect, userEvent, within } from 'storybook/test';
import { SignInForm } from '../../app/sign-in/sign-in-form.tsx';
import { PageContainer } from '../shell/page.tsx';
import { messages } from './messages.ts';

const meta = { title: 'Auth/Sign in', component: SignInForm,
  args: { next: '/studio', messages: messages.en },
  decorators: [Story => <PageContainer className="max-w-md sm:py-12"><Card><CardContent><Story /></CardContent></Card></PageContainer>],
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

export const ChineseSignIn: Story = {
  args: { messages: messages['zh-CN'] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: '登录 REZICS' })).toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: '电子邮箱' })).toBeInTheDocument();
  },
};

export const ChineseCreateAccount: Story = {
  args: { messages: messages['zh-CN'] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '创建账户' }));
    await expect(canvas.getByRole('heading', { name: '创建 REZICS 账户' })).toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: '姓名' })).toBeInTheDocument();
  },
};
