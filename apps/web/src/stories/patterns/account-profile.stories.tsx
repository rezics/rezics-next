import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { createProfileStoryIO, type ProfileScenario } from '../../kernel/fake/settings-profile';
import { m } from '../../paraglide/messages.js';
import { ProfileCard } from '../../settings/profile';
import { PublicViewsCard } from '../../settings/public-views';
import { ProfileEditor } from '../../settings/profile-write';

function Example({ scenario = 'normal' }: { scenario?: ProfileScenario }) {
  const [editor] = useState(() => new ProfileEditor(createProfileStoryIO(scenario)));
  useEffect(() => {
    void editor.reload().then(() => {
      if (scenario === 'pending') {
        editor.edit({ displayName: 'Avery Updated' });
        void editor.submit('profile');
      }
    });
  }, [editor, scenario]);
  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <section aria-label={m.settings_profile_heading()}>
        <ProfileCard editor={editor} />
      </section>
      <section aria-label={m.settings_public_activity_heading()}>
        <PublicViewsCard editor={editor} />
      </section>
    </div>
  );
}

const meta = {
  title: 'Patterns/Account/Profile',
  component: Example,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The same profile and public-activity cards used in Settings, sharing one confirmed readback and an immutable unresolved save. Interface fakes demonstrate recovery; they do not establish backend authorization.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

function profileView(canvasElement: HTMLElement) {
  return within(within(canvasElement).getByRole('region', { name: m.settings_profile_heading() }));
}
async function editName(canvasElement: HTMLElement) {
  const view = profileView(canvasElement);
  const input = await view.findByRole('textbox', { name: m.settings_profile_display_name() });
  await userEvent.clear(input);
  await userEvent.type(input, 'Avery Updated');
  await userEvent.click(view.getByRole('button', { name: m.settings_profile_save() }));
  return view;
}
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const view = await editName(canvasElement);
    await view.findByText(m.settings_saved());
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_reload_current() }));
    await expect(view.getByRole('textbox', { name: m.settings_profile_display_name() })).toHaveValue('Avery Updated');
  },
};
export const Empty: Story = { args: { scenario: 'empty' } };
export const Organization: Story = { args: { scenario: 'organization' } };
export const Pending: Story = {
  args: { scenario: 'pending' },
  play: async ({ canvasElement }) => {
    const view = profileView(canvasElement);
    await view.findByRole('button', { name: m.settings_saving() });
    await expect(view.getByRole('textbox', { name: m.settings_profile_display_name() })).toBeEnabled();
  },
};
export const Denied: Story = {
  args: { scenario: 'refused' },
  play: async ({ canvasElement }) => {
    const view = await editName(canvasElement);
    await view.findByText(m.settings_profile_edit_denied());
    await expect(view.getByRole('textbox', { name: m.settings_profile_display_name() })).toHaveValue('Avery Updated');
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_review_draft() }));
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_save() }));
    await view.findByText(m.settings_saved());
  },
};
export const TransportUnavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const view = profileView(canvasElement);
    await view.findByText(m.settings_profile_self_unavailable());
    await expect(view.queryByRole('textbox')).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_reload_current() }));
    await view.findByRole('textbox', { name: m.settings_profile_display_name() });
  },
};
export const Handleless: Story = {
  args: { scenario: 'handleless' },
  play: async ({ canvasElement }) => {
    const view = profileView(canvasElement);
    await view.findByText(m.settings_profile_self_unavailable());
    await expect(view.queryByRole('textbox')).toBeNull();
  },
};
export const LostResponse: Story = {
  args: { scenario: 'lost' },
  play: async ({ canvasElement }) => {
    const view = await editName(canvasElement);
    await view.findByText(m.settings_profile_network_error());
    const input = view.getByRole('textbox', { name: m.settings_profile_display_name() });
    await userEvent.clear(input);
    await userEvent.type(input, 'Later draft');
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_retry_save() }));
    await view.findByText(m.settings_profile_review_needed());
    await expect(input).toHaveValue('Later draft');
    await expect(view.queryByText(m.settings_saved())).toBeNull();
  },
};
export const CurrentReadback: Story = {
  args: { scenario: 'readback' },
  play: async ({ canvasElement }) => {
    const view = await editName(canvasElement);
    await view.findByText(m.settings_profile_review_needed());
    await expect(view.queryByText(m.settings_saved())).toBeNull();
  },
};
export const SharedReadback: Story = {
  play: async ({ canvasElement }) => {
    const view = profileView(canvasElement);
    const name = await view.findByRole('textbox', { name: m.settings_profile_display_name() });
    await userEvent.clear(name);
    await userEvent.type(name, 'Unsaved draft');
    const activity = within(within(canvasElement).getByRole('region', { name: m.settings_public_activity_heading() }));
    await userEvent.click(activity.getByRole('switch', { name: m.settings_public_reviews() }));
    // A profile draft keeps the shared editor in review after the independent view write.
    await activity.findByText(m.settings_profile_review_needed());
    await expect(name).toHaveValue('Unsaved draft');
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_save() }));
    await view.findByText(m.settings_saved());
    await expect(activity.getByRole('switch', { name: m.settings_public_reviews() })).not.toBeChecked();
  },
};
export const InvalidLink: Story = {
  play: async ({ canvasElement }) => {
    const view = profileView(canvasElement);
    const url = await view.findByRole('textbox', { name: m.settings_profile_link_url() });
    await userEvent.clear(url);
    await userEvent.type(url, 'http://example.test');
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_save() }));
    await view.findByText(m.settings_profile_https_link());
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(url);
    await userEvent.type(url, 'https://example.test/notes');
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_save() }));
    await view.findByText(m.settings_saved());
  },
};
