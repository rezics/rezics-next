import type { Meta, StoryObj } from '@storybook/react-vite';
import { ContextSetupReview, Unavailable, Denied } from './space-setup-context.stories';

const meta = {
  title: 'Community/Space Setup Context Page',
  id: 'pages-community-space-setup-context',
  component: ContextSetupReview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ContextSetupReview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const UnavailableSearch: Story = { args: { mode: 'unavailable', shell: true }, play: Unavailable.play! };
export const CurrentContextDenied: Story = { args: { mode: 'denied', shell: true }, play: Denied.play! };
