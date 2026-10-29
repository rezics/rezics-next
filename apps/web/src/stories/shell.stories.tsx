import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pagePaths, pageReady } from './page';

const meta = { title: 'Pages/Shell', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
async function accountMenu(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const canvas = within(context.canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.account_menu() }));
  const content =
    window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches
      ? await within(document.body).findByRole('dialog', { name: m.account_menu() })
      : await within(document.body).findByRole('menu');
  await waitFor(() => expect(content).toBeVisible());
  return content;
}
export const SignedIn: Story = {
  name: 'Signed In',
  play: async (context) => {
    const menu = await accountMenu(context);
    await within(menu).findByRole('link', { name: m.account_security_settings() });
    await within(menu).findByRole('button', { name: m.account_sign_out() });
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.shell} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: async (context) => {
    const menu = await accountMenu(context);
    await within(menu).findByRole('link', { name: m.account_sign_in() });
    const canvas = within(context.canvasElement);
    // Interface links are plain at rest, whether the underline sits on the link or on text inside it.
    const links = [...context.canvasElement.querySelectorAll('main a')];
    await expect(links.length).toBeGreaterThan(0);
    for (const link of links)
      for (const element of [link, ...link.querySelectorAll('*')])
        await expect(getComputedStyle(element).textDecorationLine).not.toContain('underline');
  },
  render: () => <PageStory visitor="Signed Out" path={pagePaths.shell} />,
};
// On a phone the navigation opens as a sheet from the header button; on a desktop it is the column beside the page.
export const Navigation: Story = {
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    if (window.matchMedia('(max-width: 767px)').matches) {
      await userEvent.click(await canvas.findByRole('button', { name: m.shell_open_navigation() }));
      await expect(await within(document.body).findByRole('dialog', { name: m.shell_navigation() })).toBeVisible();
    } else {
      await expect(await canvas.findByRole('navigation', { name: m.shell_navigation() })).toBeVisible();
    }
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.shell} />,
};
