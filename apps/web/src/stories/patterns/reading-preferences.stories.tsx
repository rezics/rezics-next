import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { readingFixture, type ReadingScenario } from '../../kernel/fake/settings-preferences-reading';
import { ReadingCard } from '../../settings/reading-card';
import { SettingsShellProvider } from '../../settings';
import { DisplayPreferences } from '../../settings/display-preferences';
import { boundSettingsShellPort } from '../../shell/app-shell';
import { getLocale, locales } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { createProfileStoryIO, profileStoryValues } from '../../kernel/fake/settings-profile';
import { ProfileCard } from '../../settings/profile';
import { settingsContent } from '../../settings/adapters/presentation';
import { ProfileEditor } from '../../settings/profile-write';
import { ProfileNavigation } from '../../settings/profile-navigation';
import { SettingsNavigationProvider } from '../../settings/reading-navigation';

const meta = {
  title: 'Patterns/Account/Reading preferences',
  component: ReadingCard,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ReadingCard>;
export default meta;
type Story = StoryObj;

function Example({ scenario = 'default' }: { scenario?: ReadingScenario }) {
  const [fixture] = useState(() => readingFixture(scenario));
  const [version, setVersion] = useState(fixture.initial.version);
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <ReadingCard
        initial={fixture.initial}
        version={version}
        csrfToken="story-token"
        onVersionChange={setVersion}
        io={fixture.io}
      />
      {scenario === 'delayed' ? (
        <button type="button" onClick={fixture.release}>
          Finish delayed save
        </button>
      ) : null}
    </div>
  );
}
async function change(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  await userEvent.click(await view.findByRole('radio', { name: m.settings_spoiler_1_title() }));
  return view;
}
export const Default: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('radio', { name: m.settings_spoiler_0_title() })).toBeChecked();
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).not.toBeChecked();
  },
};
export const ChangedChoice: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const view = await change(canvasElement);
    await view.findByText(m.settings_saved());
    await expect(view.getByRole('radio', { name: m.settings_spoiler_1_title() })).toBeChecked();
    await userEvent.click(view.getByRole('switch', { name: m.settings_suitability_title() }));
    await view.findByText(m.settings_saved());
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).toBeChecked();
  },
};
export const DelayedSaveKeepsLaterDraft: Story = {
  render: () => <Example scenario="delayed" />,
  play: async ({ canvasElement }) => {
    const view = await change(canvasElement);
    await view.findByText(m.settings_saving());
    await userEvent.click(view.getByRole('switch', { name: m.settings_suitability_title() }));
    await userEvent.click(view.getByRole('button', { name: 'Finish delayed save' }));
    await view.findByText(m.settings_reading_review_title());
    await expect(view.queryByText(m.settings_saved())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.settings_reading_save_draft() }));
    await view.findByText(m.settings_saved());
  },
};
export const LostResponseWithLaterDraft: Story = {
  render: () => <Example scenario="lost" />,
  play: async ({ canvasElement }) => {
    const view = await change(canvasElement);
    await view.findByText(m.settings_reading_uncertain_title());
    await userEvent.click(view.getByRole('switch', { name: m.settings_suitability_title() }));
    await userEvent.click(view.getByRole('button', { name: m.settings_reload() }));
    await view.findByText(m.settings_reading_uncertain_title());
    await expect(view.queryByText(m.settings_saved())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.settings_reading_retry_original() }));
    await view.findByText(m.settings_reading_review_title());
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).toBeChecked();
    await userEvent.click(view.getByRole('button', { name: m.settings_reading_save_draft() }));
    await view.findByText(m.settings_saved());
  },
};
export const ConflictAndReload: Story = {
  render: () => <Example scenario="conflict" />,
  play: async ({ canvasElement }) => {
    const view = await change(canvasElement);
    await view.findByText(m.settings_conflict_title());
    await expect(view.getByRole('radio', { name: m.settings_spoiler_1_title() })).toBeChecked();
    await userEvent.click(view.getByRole('button', { name: m.settings_reload() }));
    await expect(view.getByRole('radio', { name: m.settings_spoiler_2_title() })).toBeChecked();
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).toBeChecked();
    await expect(view.queryByRole('alert')).toBeNull();
    await userEvent.click(view.getByRole('radio', { name: m.settings_spoiler_0_title() }));
    await view.findByText(m.settings_saved());
  },
};
export const ConflictAndReview: Story = {
  render: () => <Example scenario="conflict" />,
  play: async ({ canvasElement }) => {
    const view = await change(canvasElement);
    await view.findByText(m.settings_conflict_title());
    await userEvent.click(view.getByRole('button', { name: m.settings_reading_review_changes() }));
    await view.findByText(m.settings_reading_review_title());
    await expect(view.getByRole('radio', { name: m.settings_spoiler_1_title() })).toBeChecked();
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).not.toBeChecked();
    await userEvent.click(view.getByRole('button', { name: m.settings_reading_save_draft() }));
    await view.findByText(m.settings_saved());
  },
};
export const ReadbackUnavailable: Story = {
  render: () => <Example scenario="unavailable" />,
  play: async ({ canvasElement }) => {
    const view = await change(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.settings_reading_retry_original() }));
    await view.findByText(m.settings_reading_read_unavailable_title());
    await view.findByText(m.settings_reading_uncertain_text());
    await expect(view.queryByText(m.settings_saved())).toBeNull();
    await expect(view.queryByRole('button', { name: m.settings_reading_save_draft() })).toBeNull();
  },
};
export const Closed: Story = {
  render: () => <Example scenario="closed" />,
  play: async ({ canvasElement }) => {
    const view = await change(canvasElement);
    await view.findByText(m.settings_closed_title());
    await userEvent.click(view.getByRole('button', { name: m.settings_reload() }));
    await view.findByText(m.settings_reading_read_closed_title());
    await expect(view.queryByText(m.settings_saved())).toBeNull();
  },
};
export const Denied: Story = {
  render: () => <Example scenario="denied" />,
  play: async ({ canvasElement }) => {
    const view = await change(canvasElement);
    await view.findByText(m.settings_failed_title());
    await expect(view.queryByText(m.settings_saved())).toBeNull();
  },
};
export const ShellDisplayChoices: Story = {
  render: () => (
    <SettingsShellProvider port={boundSettingsShellPort}>
      <DisplayPreferences />
    </SettingsShellProvider>
  ),
  play: async ({ canvasElement, globals }) => {
    const view = within(await within(canvasElement).findByRole('region', { name: m.shell_appearance() }));
    const menu = within(document.body);
    const choiceRole =
      window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches
        ? 'radio'
        : 'menuitemradio';
    const language = view.getByRole('button', { name: (name) => name.startsWith(m.shell_language()) });
    const locale = getLocale();
    const localeCookie = document.cookie.match(/(?:^|;\s*)rezics_locale=([^;]+)/)?.[1];
    await userEvent.click(language);
    await expect(await menu.findAllByRole(choiceRole)).toHaveLength(locales.length);
    const currentLanguage = menu.getByRole(choiceRole, { checked: true });
    await expect(language).toHaveTextContent(currentLanguage.textContent!.trim());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(language).toHaveFocus());
    await expect(getLocale()).toBe(locale);
    await expect(document.cookie.match(/(?:^|;\s*)rezics_locale=([^;]+)/)?.[1]).toBe(localeCookie);

    const theme = view.getByRole('button', { name: m.shell_theme() });
    const labels = { system: m.shell_theme_system(), dark: m.shell_theme_dark(), light: m.shell_theme_light() };
    const initialTheme = globals.theme === 'dark' ? 'dark' : 'light';
    let currentTheme: keyof typeof labels = initialTheme;
    for (const value of ['system', 'dark', 'light', initialTheme] as const) {
      await userEvent.click(theme);
      await expect(await menu.findAllByRole(choiceRole)).toHaveLength(3);
      await expect(menu.getByRole(choiceRole, { name: labels[currentTheme] })).toBeChecked();
      if (value === currentTheme) await userEvent.keyboard('{Escape}');
      else await userEvent.click(menu.getByRole(choiceRole, { name: labels[value] }));
      await waitFor(() => expect(theme).toHaveFocus());
      await expect(document.cookie).toContain(`rezics_theme=${value}`);
      const dark =
        value === 'dark' || (value === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      await waitFor(() => expect(document.documentElement).toHaveClass(dark ? 'dark' : 'light'));
      currentTheme = value;
    }
  },
};

function ReadingLeaveEditor() {
  const [fixture] = useState(() => readingFixture('lost'));
  const [version, setVersion] = useState(fixture.initial.version);
  const [editor] = useState(() => new ProfileEditor(createProfileStoryIO('normal'), profileStoryValues()));
  return (
    <SettingsNavigationProvider>
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <nav aria-label={m.settings_sections_label()} className="flex flex-wrap gap-4">
          <Link to="/" className="min-h-11 content-center underline">
            {m.nav_home()}
          </Link>
          <Link to="." search={{ section: 'reading' }} hash="reading" className="min-h-11 content-center underline">
            {m.settings_reading_heading()}
          </Link>
        </nav>
        <section id="reading" aria-labelledby="settings-reading-heading">
          <ReadingCard
            initial={fixture.initial}
            version={version}
            csrfToken="story-token"
            onVersionChange={setVersion}
            io={fixture.io}
          />
        </section>
        <ProfileNavigation editor={editor}>
          <ProfileCard editor={editor} content={settingsContent} />
        </ProfileNavigation>
      </div>
    </SettingsNavigationProvider>
  );
}

function ReadingLeaveExample() {
  const router = useMemo(() => {
    const root = createRootRoute({ component: Outlet });
    const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: ReadingLeaveEditor });
    const home = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () => (
        <div>
          <h2>{m.nav_home()}</h2>
          <Link to="/settings">{m.settings_heading()}</Link>
        </div>
      ),
    });
    return createRouter({
      routeTree: root.addChildren([settings, home]),
      history: createMemoryHistory({ initialEntries: ['/settings'] }),
    });
  }, []);
  return <RouterProvider router={router} />;
}

export const SingleDiscardDecision: Story = {
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <ReadingLeaveExample />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    // A clean mounted card leaves freely.
    await view.findByRole('radio', { name: m.settings_spoiler_0_title() });
    await userEvent.click(view.getByRole('link', { name: m.nav_home() }));
    await view.findByRole('heading', { name: m.nav_home() });
    await expect(page.queryByRole('alertdialog')).toBeNull();
    await userEvent.click(view.getByRole('link', { name: m.settings_heading() }));
    await userEvent.click(await view.findByRole('radio', { name: m.settings_spoiler_1_title() }));
    await view.findByText(m.settings_reading_uncertain_title());
    await userEvent.click(view.getByRole('switch', { name: m.settings_suitability_title() }));
    await userEvent.click(view.getByRole('link', { name: m.settings_reading_heading() }));
    await expect(page.queryByRole('alertdialog')).toBeNull();
    const home = view.getByRole('link', { name: m.nav_home() });
    await userEvent.click(home);
    let dialog = within(await page.findByRole('alertdialog'));
    await expect(dialog.getByRole('heading', { name: m.settings_reading_leave_title() })).toBeVisible();
    await waitFor(() => expect(dialog.getByRole('button', { name: m.settings_profile_stay() })).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('alertdialog')).toBeNull());
    await expect(home).toHaveFocus();
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).toBeChecked();
    await userEvent.click(view.getByRole('button', { name: m.settings_reading_retry_original() }));
    await view.findByText(m.settings_reading_review_title());
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).toBeChecked();
    const name = view.getByRole('textbox', { name: m.settings_profile_display_name() });
    await userEvent.clear(name);
    await userEvent.type(name, 'Local profile draft');
    await userEvent.click(home);
    dialog = within(await page.findByRole('alertdialog'));
    await expect(page.getAllByRole('alertdialog')).toHaveLength(1);
    await expect(dialog.getByRole('heading', { name: m.settings_drafts_leave_title() })).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: m.settings_profile_stay() }));
    await waitFor(() => expect(page.queryByRole('alertdialog')).toBeNull());
    await expect(name).toHaveValue('Local profile draft');
    await userEvent.click(home);
    dialog = within(await page.findByRole('alertdialog'));
    await userEvent.click(dialog.getByRole('button', { name: m.settings_profile_leave() }));
    await view.findByRole('heading', { name: m.nav_home() });
    await userEvent.click(view.getByRole('link', { name: m.settings_heading() }));
    await expect(await view.findByRole('radio', { name: m.settings_spoiler_0_title() })).toBeChecked();
    await expect(view.getByRole('textbox', { name: m.settings_profile_display_name() })).toHaveValue('Avery Reader');
    await userEvent.click(view.getByRole('radio', { name: m.settings_spoiler_1_title() }));
    await view.findByText(m.settings_reading_uncertain_title());
    await userEvent.click(view.getByRole('link', { name: m.nav_home() }));
    await page.findByRole('alertdialog');
  },
};

export const SingleDiscardDecisionPhone: Story = {
  ...SingleDiscardDecision,
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
