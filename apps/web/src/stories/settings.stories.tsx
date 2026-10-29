import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import settingsPreferencesRecording from '../kernel/recorded/settings-preferences.json';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Settings', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const levelTitles = [m.settings_spoiler_0_title, m.settings_spoiler_1_title, m.settings_spoiler_2_title] as const;

/** The page shows the recorded level as chosen and the other controls ready to change. */
async function settingsReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = within(within(context.canvasElement).getByRole('main'));
  await view.findByRole('heading', { level: 1, name: m.settings_heading() });
  const chosen = levelTitles[settingsPreferencesRecording.spoilerLevel]!();
  await expect(await view.findByRole('radio', { name: chosen })).toBeChecked();
  await expect(await view.findByRole('switch', { name: m.settings_suitability_title() })).toHaveAttribute(
    'aria-checked',
    settingsPreferencesRecording.suitability === 'show' ? 'true' : 'false',
  );
  await view.findByRole('button', { name: m.account_sign_out() });
}

export const SignedIn: Story = {
  name: 'Signed In',
  play: settingsReady,
  render: () => <PageStory visitor="Signed In" path="/settings" />,
};
