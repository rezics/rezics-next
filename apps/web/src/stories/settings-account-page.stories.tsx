import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { SettingsPageView } from '../settings/settings-page';
import { AppShell } from '../shell/shell';
import { PageStory, pageReady, PatternStory } from './page';

const meta = {
  title: 'Pages/Account/Settings account journey',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(within(context.canvasElement).getByRole('main'));
    const nav = within(await canvas.findByRole('navigation', { name: m.settings_sections_label() }));
    const link = nav.getByRole('link', { name: m.settings_account_heading() });
    for (const anchor of nav.getAllByRole('link')) {
      await expect(context.canvasElement.querySelector(anchor.getAttribute('href')!)).not.toBeNull();
    }
    await userEvent.click(link);
    const account = within(canvas.getByRole('region', { name: m.settings_account_heading() }));
    await expect(account.getByRole('link', { name: m.account_security_settings() })).toHaveAttribute(
      'href',
      'https://auth.example.test/security',
    );
    await expect(account.getByRole('link', { name: m.settings_account_delete_continue() })).toHaveAttribute(
      'href',
      'https://auth.example.test/account/delete',
    );
    const form = account.getByRole('button', { name: m.account_sign_out() }).closest('form');
    await expect(form).toHaveAttribute('method', 'post');
    await expect(form).toHaveAttribute('action', '/auth/sign-out');
  },
};

export const SignedOut: Story = {
  // Review the fallback view in the ordinary shell; the production /settings route still requires sign-in.
  render: () => (
    <PatternStory visitor="Signed Out" path="/settings">
      <AppShell>
        <SettingsPageView page={{ signedIn: false }} csrfToken={null} />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(await within(canvasElement).findByRole('main'));
    await canvas.findByRole('link', { name: m.account_sign_in() });
    await expect(canvas.queryByRole('navigation')).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.account_sign_out() })).toBeNull();
  },
};
