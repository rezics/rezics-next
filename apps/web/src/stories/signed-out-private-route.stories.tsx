import type { Meta, StoryObj } from '@storybook/react-vite';
import { SessionUnavailablePrompt } from '../session/private-page';

const meta = {
  title: 'Pages/Private destination',
  component: SessionUnavailablePrompt,
  args: { signInHref: '/auth/sign-in?return_to=%2Fen%2Flibrary' },
} satisfies Meta<typeof SessionUnavailablePrompt>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SessionStatusUnavailable: Story = {};
