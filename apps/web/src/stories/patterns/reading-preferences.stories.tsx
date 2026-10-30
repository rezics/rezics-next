import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { readingFixture, type ReadingScenario } from '../../kernel/fake/settings-preferences-reading';
import { ReadingCard } from '../../settings/reading-card';
import { DisplayPreferences } from '../../settings/display-preferences';
import { getLocale, locales } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

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
    await view.findByText(m.settings_reading_uncertain_title());
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
    await view.findByText(m.settings_closed_title());
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
  render: () => <DisplayPreferences />,
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
    await userEvent.click(currentLanguage);
    await waitFor(() => expect(language).toHaveFocus());
    await expect(getLocale()).toBe(locale);
    await expect(document.cookie.match(/(?:^|;\s*)rezics_locale=([^;]+)/)?.[1]).toBe(localeCookie);

    const theme = view.getByRole('button', { name: m.shell_theme(), exact: true });
    const labels = { system: m.shell_theme_system(), dark: m.shell_theme_dark(), light: m.shell_theme_light() };
    const initialTheme = globals.theme === 'dark' ? 'dark' : 'light';
    let currentTheme: keyof typeof labels = initialTheme;
    for (const value of ['system', 'dark', 'light', initialTheme] as const) {
      await userEvent.click(theme);
      await expect(await menu.findAllByRole(choiceRole)).toHaveLength(3);
      await expect(menu.getByRole(choiceRole, { name: labels[currentTheme], exact: true })).toBeChecked();
      await userEvent.click(menu.getByRole(choiceRole, { name: labels[value], exact: true }));
      await waitFor(() => expect(theme).toHaveFocus());
      await expect(document.cookie).toContain(`rezics_theme=${value}`);
      const dark =
        value === 'dark' || (value === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      await waitFor(() => expect(document.documentElement).toHaveClass(dark ? 'dark' : 'light'));
      currentTheme = value;
    }
  },
};
