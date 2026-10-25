import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady, pages } from './page';

const meta = { title: 'Pages/Shell', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.account_menu() }));
    const menu = await canvas.findByRole('group', { name: m.account_menu() });
    await expect(menu).toBeVisible();
    await canvas.findByRole('link', { name: m.account_security_settings() });
    await canvas.findByRole('button', { name: m.account_sign_out() });
  },
  render: () => <PageStory visitor="Signed In">{pages.shell}</PageStory>,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out">{pages.shell}</PageStory>,
};
