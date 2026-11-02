import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
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
    const view = within(context.canvasElement);
    await expect(view.getByRole('button', { name: m.space_setup_identity() })).toHaveAttribute('aria-current', 'step');
    await expect(view.getByText(m.space_setup_details_heading()).closest('details')).not.toHaveAttribute('open');
    await expect(view.getByText(m.space_setup_saved_hint())).toBeVisible();
  },
};

export const NewCommunityRtl: Story = {
  render: () => (
    <div dir="rtl">
      <PageStory visitor="Signed In" path="/realms/new" />
    </div>
  ),
  play: NewCommunity.play!,
};
