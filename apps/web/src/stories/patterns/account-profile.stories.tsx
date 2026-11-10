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
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { createProfileStoryIO, type ProfileScenario } from '../../kernel/fake/settings-profile';
import { m } from '../../paraglide/messages.js';
import { ProfileCard } from '../../settings/profile';
import { settingsContent } from '../../settings/adapters/presentation';
import { PublicViewsCard } from '../../settings/public-views';
import { ProfileEditor, type ProfileAttempt } from '../../settings/profile-write';
import { ProfileNavigation } from '../../settings/profile-navigation';
import { EditableProfileReadError, nativeProfileFailure } from '../../settings/ports/profile-editor';

type SaveObserver = ((attempt: ProfileAttempt) => void) | undefined;
type RecoveryScenario = 'delay' | 'date' | 'short' | 'malformed' | 'read';

function ProfileExample({
  scenario,
  recovery,
  onSave,
}: {
  scenario: ProfileScenario;
  recovery?: RecoveryScenario | undefined;
  onSave?: SaveObserver;
}) {
  const [editor] = useState(() => {
    const io = createProfileStoryIO(scenario);
    let failed = false;
    const failure = () =>
      nativeProfileFailure(
        503,
        {
          type: 'https://rezics.com/problems/dependency_unavailable',
          title: 'Dependency Unavailable',
          code: 'dependency_unavailable',
          retryable: true,
          request_id: 'profile-story-request',
        },
        {
          'retry-after':
            recovery === 'date'
              ? new Date(Date.now() + 60_000).toUTCString()
              : recovery === 'short'
                ? '1'
                : recovery === 'malformed'
                  ? 'invalid'
                  : '60',
        },
      );
    return new ProfileEditor({
      ...io,
      read: async () => {
        if (recovery === 'read' && !failed) {
          failed = true;
          throw new EditableProfileReadError(503, failure());
        }
        return io.read();
      },
      save: async (attempt) => {
        onSave?.(attempt);
        if (recovery && recovery !== 'read' && !failed) {
          failed = true;
          return { ok: false, status: 503, message: '', failure: failure() };
        }
        return io.save(attempt);
      },
    });
  });
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
          <ProfileCard editor={editor} content={settingsContent} />
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

function Example({
  scenario = 'normal',
  recovery,
  onSave,
}: {
  scenario?: ProfileScenario;
  recovery?: RecoveryScenario;
  onSave?: SaveObserver;
}) {
  const router = useMemo(() => {
    const root = createRootRoute({ component: Outlet });
    const profile = createRoute({
      getParentRoute: () => root,
      path: '/settings',
      component: () => <ProfileExample scenario={scenario} recovery={recovery} onSave={onSave} />,
    });
    const home = createRoute({ getParentRoute: () => root, path: '/', component: ProfileHome });
    return createRouter({
      routeTree: root.addChildren([profile, home]),
      history: createMemoryHistory({ initialEntries: ['/settings'] }),
    });
  }, [scenario, recovery, onSave]);
  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Account/Profile Workflow',
  id: 'patterns-account-profile',
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
    await view.findByText(m.settings_profile_read_failed());
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
    await view.findByText(m.settings_profile_save_unknown());
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
    await userEvent.click(activity.getByRole('button', { name: m.settings_profile_save_activity() }));
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

export const ValidationFeedback: Story = {
  name: 'Submitting an invalid profile announces actionable field errors and focuses the first invalid control while preserving the exact draft and sending no native command',
  args: { onSave: fn() },
  play: async ({ canvasElement, args }) => {
    const view = await profileView(canvasElement);
    const label = await view.findByRole('textbox', { name: m.settings_profile_link_label() });
    const url = view.getByRole('textbox', { name: m.settings_profile_link_url() });
    const biography = view.getByRole('textbox', { name: m.settings_profile_biography() });
    const draftLabel = 'x'.repeat(65);
    await userEvent.clear(label);
    await userEvent.type(label, draftLabel);
    await userEvent.clear(url);
    await userEvent.type(url, 'http://example.test');
    await userEvent.clear(biography);
    await userEvent.type(biography, 'Keep this draft exactly.');
    await expect(view.queryByRole('alert')).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_save() }));
    await waitFor(() => expect(label).toHaveFocus());
    const announcement = view.getByRole('alert');
    await expect(announcement).toHaveTextContent(m.settings_profile_validation_summary());
    const summary = within(view.getByRole('group', { name: m.settings_profile_validation_summary() }));
    const links = summary.getAllByRole('link');
    await expect(links).toHaveLength(2);
    await expect(links[0]).toHaveAttribute('href', `#${label.id}`);
    await expect(links[1]).toHaveAttribute('href', `#${url.id}`);
    await expect(label).toHaveAttribute('aria-invalid', 'true');
    await expect(label).toHaveAccessibleDescription(m.settings_profile_label_limit());
    await expect(url).toHaveAccessibleDescription(m.settings_profile_https_link());
    links[1]!.focus();
    await userEvent.keyboard('{Enter}');
    await expect(url).toHaveFocus();
    await userEvent.type(url, '/draft');
    await expect(url).toHaveFocus();
    await expect(view.queryByRole('alert')).toBeNull();
    await expect(view.getByText(m.settings_profile_validation_summary())).toBe(announcement);
    await expect(label).toHaveValue(draftLabel);
    await expect(url).toHaveValue('http://example.test/draft');
    await expect(biography).toHaveValue('Keep this draft exactly.');
    await expect(args.onSave).not.toHaveBeenCalled();
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_save() }));
    await waitFor(() => expect(label).toHaveFocus());
    await expect(view.getByRole('alert')).not.toBe(announcement);
    await userEvent.clear(label);
    await userEvent.type(label, 'Notes');
    await userEvent.clear(url);
    await userEvent.type(url, 'https://example.test/notes');
    await expect(view.queryByRole('alert')).toBeNull();
    await expect(view.queryByRole('group', { name: m.settings_profile_validation_summary() })).toBeNull();
    // A newly invalid draft after correction stays quiet until the next explicit submission.
    await userEvent.clear(url);
    await userEvent.type(url, 'http://example.test');
    await expect(url).toHaveFocus();
    await expect(view.queryByRole('alert')).toBeNull();
    await userEvent.clear(url);
    await userEvent.type(url, 'https://example.test/notes');
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_save() }));
    await view.findByText(m.settings_saved());
    await expect(args.onSave).toHaveBeenCalledTimes(1);
    await expect(args.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({
          biography: 'Keep this draft exactly.',
          links: [{ label: 'Notes', url: 'https://example.test/notes' }],
        }),
      }),
    );
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
    await view.findByText(m.settings_profile_save_unknown());
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

export const LinkRows: Story = {
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const view = await profileView(canvasElement);
    const name = await view.findByRole('textbox', { name: m.settings_profile_display_name() });
    await userEvent.clear(name);
    await userEvent.type(name, 'Unsaved link draft');
    const row = (number: number, label = 'Duplicate') =>
      view.getByRole('group', { name: m.settings_profile_link_named_row({ number, label }) });
    const labelIn = (group: HTMLElement) =>
      within(group).getByRole('textbox', { name: m.settings_profile_link_label() });
    const urlIn = (group: HTMLElement) => within(group).getByRole('textbox', { name: m.settings_profile_link_url() });
    const removeIn = (group: HTMLElement) => within(group).getByRole('button');
    const add = view.getByRole('button', { name: m.settings_profile_add_link() });
    const first = row(1, 'Website');
    const firstLabel = labelIn(first);
    const firstUrl = urlIn(first);
    const longUrl = `https://example.test/${'reading-notes-'.repeat(25)}`;
    await userEvent.clear(firstLabel);
    await userEvent.type(firstLabel, 'Duplicate');
    await userEvent.clear(firstUrl);
    await userEvent.type(firstUrl, longUrl);
    await userEvent.tab();
    await expect(removeIn(first)).toHaveFocus();
    await userEvent.tab();
    await expect(add).toHaveFocus();
    for (let number = 2; number <= 5; number++) {
      await userEvent.keyboard('{Enter}');
      const added = view.getByRole('group', { name: m.settings_profile_link_row({ number }) });
      await expect(labelIn(added)).toHaveFocus();
      await userEvent.keyboard('Duplicate');
      await userEvent.tab();
      await expect(urlIn(added)).toHaveFocus();
      await userEvent.keyboard(longUrl);
      if (number < 5) {
        await userEvent.tab();
        await userEvent.tab();
        await expect(add).toHaveFocus();
      }
    }
    await expect(add).toBeDisabled();
    const middle = row(3);
    const next = row(4);
    const nextLabel = labelIn(next);
    // Keyboard removal moves to the same next input node, with its new current ordinal/ID.
    await userEvent.click(urlIn(middle));
    await userEvent.tab();
    await expect(removeIn(middle)).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(nextLabel).toHaveFocus();
    await expect(row(3)).toBe(next);
    await expect(nextLabel.id).toMatch(/-label-2$/);
    await expect(labelIn(row(1))).toBe(firstLabel);
    await expect(firstUrl).toHaveValue(longUrl);
    await expect(view.getByRole('status')).toHaveTextContent(
      m.settings_profile_link_removed({ link: m.settings_profile_link_named_row({ number: 3, label: 'Duplicate' }) }),
    );
    await expect(add).toBeEnabled();
    await expect(name).toHaveValue('Unsaved link draft');
    const reload = view.getByRole('button', { name: m.settings_profile_reload_current() });
    await userEvent.click(reload);
    await view.findByText(m.settings_profile_review_needed());
    await expect(labelIn(row(3))).toBe(nextLabel);
    await expect(firstUrl).toHaveValue(longUrl);
    await expect(name).toHaveValue('Unsaved link draft');
    await expect(nextLabel).not.toHaveFocus();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};

export const LinkRowsPhone: Story = {
  ...LinkRows,
  globals: { viewport: { value: 'phone390' } },
};

export const LinkRemovalEdges: Story = {
  play: async ({ canvasElement }) => {
    const view = await profileView(canvasElement);
    const original = await view.findByRole('textbox', { name: m.settings_profile_link_label() });
    const originalUrl = view.getByRole('textbox', { name: m.settings_profile_link_url() });
    const add = view.getByRole('button', { name: m.settings_profile_add_link() });
    await userEvent.click(originalUrl);
    await userEvent.tab();
    await userEvent.tab();
    await expect(add).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const last = view.getByRole('group', { name: m.settings_profile_link_row({ number: 2 }) });
    const lastLabel = within(last).getByRole('textbox', { name: m.settings_profile_link_label() });
    await expect(lastLabel).toHaveFocus();
    await userEvent.keyboard('Second');
    await userEvent.tab();
    await userEvent.keyboard('https://example.test/second');
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await expect(original).toHaveFocus();
    await expect(original).toHaveValue('Website');
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await expect(add).toHaveFocus();
    await expect(view.getByRole('status')).toHaveTextContent(
      m.settings_profile_link_removed({ link: m.settings_profile_link_named_row({ number: 1, label: 'Website' }) }),
    );
    await userEvent.keyboard('{Enter}');
    const replacement = view.getByRole('textbox', { name: m.settings_profile_link_label() });
    await expect(replacement).toHaveFocus();
    await expect(replacement).not.toBe(original);
    await expect(replacement).toHaveValue('');
  },
};

export const RetryDelay: Story = {
  args: { recovery: 'delay', onSave: fn() },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement, args }) => {
    const view = await editName(canvasElement);
    await view.findByText(m.settings_retry_wait());
    await expect(view.getByRole('button', { name: m.settings_profile_retry_save() })).toBeDisabled();
    for (const reload of view.getAllByRole('button', { name: m.settings_profile_reload_current() }))
      await expect(reload).toBeDisabled();
    await expect(view.getByRole('button', { name: m.settings_profile_review_draft() })).toBeEnabled();
    await userEvent.click(view.getByRole('button', { name: m.settings_profile_review_draft() }));
    await expect(view.getByRole('button', { name: m.settings_profile_retry_save() })).toBeDisabled();
    await expect(view.getByRole('textbox', { name: m.settings_profile_display_name() })).toBeEnabled();
    await expect(args.onSave).toHaveBeenCalledTimes(1);
  },
};

export const PublicActivityRetryDate: Story = {
  args: { recovery: 'date', onSave: fn() },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement, args }) => {
    const activity = within(within(canvasElement).getByRole('region', { name: m.settings_public_activity_heading() }));
    await userEvent.click(await activity.findByRole('switch', { name: m.settings_public_reviews() }));
    await userEvent.click(activity.getByRole('button', { name: m.settings_profile_save_activity() }));
    await activity.findByText(m.settings_retry_wait());
    await expect(activity.getByRole('button', { name: m.settings_public_activity_retry() })).toBeDisabled();
    await expect(activity.getByRole('button', { name: m.settings_profile_reload_current() })).toBeDisabled();
    await expect(activity.getByRole('button', { name: m.settings_profile_review_draft() })).toBeEnabled();
    const view = await profileView(canvasElement);
    await expect(view.getByRole('button', { name: m.settings_profile_reload_current() })).toBeDisabled();
    await expect(args.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { publicViews: { reviews: false } } }),
    );
    await expect(args.onSave).toHaveBeenCalledTimes(1);
  },
};

export const RetryOriginalAfterDelay: Story = {
  args: { recovery: 'short', onSave: fn() },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement, args }) => {
    const view = await editName(canvasElement);
    await view.findByText(m.settings_retry_wait());
    const retry = view.getByRole('button', { name: m.settings_profile_retry_save() });
    await expect(retry).toBeDisabled();
    const input = view.getByRole('textbox', { name: m.settings_profile_display_name() });
    await userEvent.clear(input);
    await userEvent.type(input, 'Later draft');
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 3000 });
    await expect(args.onSave).toHaveBeenCalledTimes(1);
    await userEvent.click(retry);
    await view.findByText(m.settings_profile_review_needed());
    await expect(input).toHaveValue('Later draft');
    const original = expect.objectContaining({
      after: expect.objectContaining({ displayName: 'Avery Updated' }),
      patch: { displayName: 'Avery Updated' },
    });
    await expect(args.onSave).toHaveBeenNthCalledWith(1, original);
    await expect(args.onSave).toHaveBeenNthCalledWith(2, original);
    const observer = args.onSave as ReturnType<typeof fn>;
    await expect(observer.mock.calls[1]?.[0]).toBe(observer.mock.calls[0]?.[0]);
  },
};

export const MalformedRetryAfter: Story = {
  args: { recovery: 'malformed' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const view = await editName(canvasElement);
    await view.findByText(m.settings_profile_save_unknown());
    await expect(view.queryByText(m.settings_retry_wait())).toBeNull();
    await expect(view.getByRole('button', { name: m.settings_profile_retry_save() })).toBeEnabled();
    for (const reload of view.getAllByRole('button', { name: m.settings_profile_reload_current() }))
      await expect(reload).toBeEnabled();
  },
};

export const ReadRetryDelay: Story = {
  args: { recovery: 'read' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    for (const name of [m.settings_profile_heading(), m.settings_public_activity_heading()]) {
      const view = within(await within(canvasElement).findByRole('region', { name }));
      await view.findByText(m.settings_retry_wait());
      await expect(view.getByRole('button', { name: m.settings_profile_reload_current() })).toBeDisabled();
      await expect(view.queryByRole('textbox')).toBeNull();
      await expect(view.queryByRole('switch')).toBeNull();
    }
  },
};
