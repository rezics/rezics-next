import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useState } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useRouter,
} from '@tanstack/react-router';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { createProfileStoryIO, type ProfileScenario } from '../../kernel/fake/settings-profile';
import { m } from '../../paraglide/messages.js';
import { ProfileCard } from '../../settings/profile';
import { PublicViewsCard } from '../../settings/public-views';
import { ProfileEditor } from '../../settings/profile-write';
import { ProfileNavigation } from '../../settings/profile-navigation';

function ProfileExample({ scenario }: { scenario: ProfileScenario }) {
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
    <ProfileNavigation editor={editor}>
      <div className="mx-auto grid max-w-2xl gap-6">
        <nav aria-label={m.settings_sections_label()} className="flex flex-wrap gap-4">
          <Link to="/" className="min-h-11 content-center underline">
            {m.nav_home()}
          </Link>
          <Link to="." hash="public-activity" className="min-h-11 content-center underline">
            {m.settings_public_activity_heading()}
          </Link>
        </nav>
        <section aria-label={m.settings_profile_heading()}>
          <ProfileCard editor={editor} />
        </section>
        <section id="public-activity" aria-label={m.settings_public_activity_heading()}>
          <PublicViewsCard editor={editor} />
        </section>
      </div>
    </ProfileNavigation>
  );
}

function ProfileHome() {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <h2>{m.nav_home()}</h2>
      <Button onClick={() => void router.navigate({ href: '/settings' })}>{m.settings_heading()}</Button>
    </div>
  );
}

function Example({ scenario = 'normal' }: { scenario?: ProfileScenario }) {
  const router = useMemo(() => {
    const root = createRootRoute({ component: Outlet });
    const profile = createRoute({
      getParentRoute: () => root,
      path: '/settings',
      component: () => <ProfileExample scenario={scenario} />,
    });
    const home = createRoute({ getParentRoute: () => root, path: '/', component: ProfileHome });
    return createRouter({
      routeTree: root.addChildren([profile, home]),
      history: createMemoryHistory({ initialEntries: ['/settings'] }),
    });
  }, [scenario]);
  return <RouterProvider router={router} />;
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

async function profileView(canvasElement: HTMLElement) {
  return within(await within(canvasElement).findByRole('region', { name: m.settings_profile_heading() }));
}
async function editName(canvasElement: HTMLElement) {
  const view = await profileView(canvasElement);
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
    const view = await profileView(canvasElement);
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
    const view = await profileView(canvasElement);
    await view.findByText(m.settings_profile_self_unavailable());
    await expect(view.queryByRole('textbox')).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_reload_current() }));
    await view.findByRole('textbox', { name: m.settings_profile_display_name() });
  },
};
export const Handleless: Story = {
  args: { scenario: 'handleless' },
  play: async ({ canvasElement }) => {
    const view = await editName(canvasElement);
    await view.findByText(m.settings_saved());
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_reload_current() }));
    await expect(view.getByRole('textbox', { name: m.settings_profile_display_name() })).toHaveValue('Avery Updated');
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
    const view = await profileView(canvasElement);
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
    const view = await profileView(canvasElement);
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

export const CancelThenLeave: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const view = await profileView(canvasElement);
    const input = await view.findByRole('textbox', { name: m.settings_profile_display_name() });
    await userEvent.clear(input);
    await userEvent.type(input, 'Keep this draft');
    // Changing sections keeps both cards and the same editor mounted.
    await userEvent.click(canvas.getByRole('link', { name: m.settings_public_activity_heading() }));
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.queryByRole('alertdialog')).toBeNull();
    const home = canvas.getByRole('link', { name: m.nav_home() });
    await userEvent.click(home);
    const dialog = within(await page.findByRole('alertdialog'));
    const stay = dialog.getByRole('button', { name: m.settings_profile_stay() });
    await waitFor(() => expect(stay).toHaveFocus());
    await userEvent.click(stay);
    await waitFor(() => expect(page.queryByRole('alertdialog')).toBeNull());
    await expect(input).toHaveValue('Keep this draft');
    await expect(home).toHaveFocus();
    await userEvent.click(home);
    await page.findByRole('alertdialog');
    await userEvent.click(page.getByRole('button', { name: m.settings_profile_leave() }));
    await canvas.findByRole('heading', { name: m.nav_home() });
    await userEvent.click(canvas.getByRole('button', { name: m.settings_heading() }));
    await expect(
      await (
        await profileView(canvasElement)
      ).findByRole('textbox', {
        name: m.settings_profile_display_name(),
      }),
    ).toHaveValue('Avery Reader');
  },
};

export const UnresolvedNavigation: Story = {
  args: { scenario: 'lost' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const view = await editName(canvasElement);
    await view.findByText(m.settings_profile_network_error());
    const input = view.getByRole('textbox', { name: m.settings_profile_display_name() });
    await userEvent.clear(input);
    await userEvent.type(input, 'Later draft');
    await userEvent.click(canvas.getByRole('link', { name: m.nav_home() }));
    const page = within(canvasElement.ownerDocument.body);
    await page.findByRole('alertdialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('alertdialog')).toBeNull());
    await expect(input).toHaveValue('Later draft');
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_retry_save() }));
    await view.findByText(m.settings_profile_review_needed());
    await expect(input).toHaveValue('Later draft');
  },
};

export const CleanNavigation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await (await profileView(canvasElement)).findByRole('textbox', { name: m.settings_profile_display_name() });
    await userEvent.click(canvas.getByRole('link', { name: m.nav_home() }));
    await canvas.findByRole('heading', { name: m.nav_home() });
    await userEvent.click(canvas.getByRole('button', { name: m.settings_heading() }));
    const view = await editName(canvasElement);
    await view.findByText(m.settings_saved());
    await userEvent.click(canvas.getByRole('link', { name: m.nav_home() }));
    await canvas.findByRole('heading', { name: m.nav_home() });
    await expect(within(canvasElement.ownerDocument.body).queryByRole('alertdialog')).toBeNull();
  },
};
