import type { Meta, StoryObj } from '@storybook/react-vite';
import { within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Community/Space Setup', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const NewCommunity: Story = {
  render: () => <PageStory visitor="Signed In" path="/realms/new" />,
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByRole('heading', { level: 1, name: m.space_setup_heading() });
    await within(context.canvasElement).findByRole('button', { name: m.space_setup_create_space() });
  },
};
