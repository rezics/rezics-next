import type { Meta, StoryObj } from '@storybook/react-vite';
import { DependencyUnavailablePage } from '../shell/dependency-recovery/page';

const meta = {
  title: 'Pages/Private destination',
  component: DependencyUnavailablePage,
  args: { locale: 'en' },
} satisfies Meta<typeof DependencyUnavailablePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SessionStatusUnavailable: Story = {};
