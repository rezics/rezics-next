import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Settings/Reading and display', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
export const ReadingAndDisplay: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?reading-state=default#reading" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByRole('heading', { name: m.settings_display_heading() });
    await userEvent.click(await view.findByRole('radio', { name: m.settings_spoiler_1_title() }));
    await view.findByText(m.settings_saved());
    const display = within(await view.findByRole('region', { name: m.shell_appearance() }));
    await expect(display.getByRole('button', { name: (name) => name.startsWith(m.shell_language()) })).toBeEnabled();
    await expect(display.getByRole('button', { name: m.shell_theme() })).toBeEnabled();
  },
};
export const LostResponse: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?reading-state=lost#reading" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await userEvent.click(await view.findByRole('radio', { name: m.settings_spoiler_1_title() }));
    await view.findByText(m.settings_reading_uncertain_title());
    await userEvent.click(view.getByRole('switch', { name: m.settings_suitability_title() }));
    await userEvent.click(view.getByRole('button', { name: m.settings_reading_retry_original() }));
    await view.findByText(m.settings_reading_review_title());
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).toBeChecked();
    await userEvent.click(view.getByRole('button', { name: m.settings_reading_save_draft() }));
    await view.findByText(m.settings_saved());
  },
};
export const ConflictAndReload: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?reading-state=conflict#reading" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await userEvent.click(await view.findByRole('radio', { name: m.settings_spoiler_1_title() }));
    await view.findByText(m.settings_conflict_title());
    await expect(view.getByRole('radio', { name: m.settings_spoiler_1_title() })).toBeChecked();
    await userEvent.click(view.getByRole('button', { name: m.settings_reload() }));
    await expect(view.getByRole('radio', { name: m.settings_spoiler_2_title() })).toBeChecked();
    await expect(view.queryByText(m.settings_conflict_title())).toBeNull();
    await userEvent.click(view.getByRole('radio', { name: m.settings_spoiler_0_title() }));
    await view.findByText(m.settings_saved());
  },
};
export const Unavailable: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?reading-state=unavailable#reading" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByText(m.settings_unavailable_title());
    await expect(view.queryByRole('radio')).toBeNull();
  },
};
export const Closed: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?reading-state=closed#reading" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByText(m.settings_closed_title());
    await expect(view.queryByRole('radio')).toBeNull();
  },
};
