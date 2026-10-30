import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Settings/Profile', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
export const Self: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?profile=self#profile" />,
  play: async (context) => {
    await pageReady(context);
    const profile = within(
      await within(context.canvasElement).findByRole('region', { name: m.settings_profile_heading() }),
    );
    const name = await profile.findByRole('textbox', { name: m.settings_profile_display_name() });
    await userEvent.clear(name);
    await userEvent.type(name, 'Avery Updated');
    await userEvent.click(profile.getByRole('button', { name: m.settings_profile_save() }));
    await profile.findByText(m.settings_saved());
    const activity = within(
      within(context.canvasElement).getByRole('region', { name: m.settings_public_activity_heading() }),
    );
    await userEvent.click(activity.getByRole('switch', { name: m.settings_public_reviews() }));
    await activity.findByText(m.settings_saved());
    await userEvent.click(profile.getByRole('button', { name: m.settings_profile_reload_current() }));
    await expect(name).toHaveValue('Avery Updated');
    await expect(activity.getByRole('switch', { name: m.settings_public_reviews() })).not.toBeChecked();
  },
};
export const Handleless: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?profile=handleless#profile" />,
  play: async (context) => {
    await pageReady(context);
    const profile = within(
      await within(context.canvasElement).findByRole('region', { name: m.settings_profile_heading() }),
    );
    const name = await profile.findByRole('textbox', { name: m.settings_profile_display_name() });
    await expect(name).toHaveValue('Avery Reader');
    await expect(profile.getByRole('textbox', { name: m.settings_profile_biography() })).not.toHaveValue('');
    await userEvent.clear(name);
    await userEvent.type(name, 'Handleless Reader');
    await userEvent.click(profile.getByRole('button', { name: m.settings_profile_save() }));
    await profile.findByText(m.settings_saved());
    await userEvent.click(profile.getByRole('button', { name: m.settings_profile_reload_current() }));
    await expect(name).toHaveValue('Handleless Reader');
  },
};
export const Unavailable: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?profile=unavailable#public-activity" />,
};
