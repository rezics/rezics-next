import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageHeading } from './page-heading';

const meta = {
  title: 'Shell/Page heading',
  component: PageHeading,
} satisfies Meta<typeof PageHeading>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Plain: Story = {
  args: { children: 'Reading room' },
};

export const Cjk: Story = {
  args: { children: '読書室', lang: 'ja' },
};
