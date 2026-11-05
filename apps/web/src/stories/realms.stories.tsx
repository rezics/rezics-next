import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import myRealmsRecording from '../kernel/recorded/my-realms.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Community/Realms', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function mainView(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = within(within(context.canvasElement).getByRole('main'));
  await view.findByRole('heading', { level: 1 });
  return view;
}

type MainView = Awaited<ReturnType<typeof mainView>>;

async function firstRealmLink(view: MainView) {
  const realm = myRealmsRecording.items[0];
  if (!realm) throw new Error('The recorded Realms page has no Realm.');
  const name = new RegExp(`^${realm.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u');
  const heading = await view.findByRole('heading', { level: 2, name });
  await expect(heading).toBeVisible();
  const links = await view.findAllByRole('link', { name });
  await expect(links).toHaveLength(1);
  const link = links[0];
  if (!link) throw new Error('The recorded Realm should have one primary link.');
  await expect(link).toHaveAttribute('href', `/${getLocale()}/realms/${encodeURIComponent(realm.realmId)}`);
  return link;
}

/** The signed-in person's first Realm is listed with a link. */
async function listed(context: { canvasElement: HTMLElement }) {
  const view = await mainView(context);
  const link = await firstRealmLink(view);
  await userEvent.hover(link);
  link.closest('[data-slot="list-row"]')?.setAttribute('data-overlay', 'visible');
}

async function shellNavigation(context: { canvasElement: HTMLElement }) {
  const phone = window.matchMedia('(max-width: 767px)').matches;
  const label = phone ? m.shell_phone_tabs() : m.shell_navigation();
  const navigation = await within(context.canvasElement).findByRole('navigation', { name: label });
  const home = await within(navigation).findByRole('link', { name: m.nav_home() });
  await expect(home).toHaveAttribute('href', `/${getLocale()}`);
  await expect(home).toHaveAttribute('aria-current', 'page');
}

export const SignedIn: Story = {
  name: 'Signed In',
  play: listed,
  render: () => <PageStory visitor="Signed In" path="/realms" />,
};

/** A keyboard user opens Account and follows the private membership link to their recorded Realm list. */
export const AccountMenuNavigation: Story = {
  name: 'Account menu to My Realms',
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await shellNavigation(context);
    const phone = window.matchMedia('(max-width: 767px)').matches;
    const menuName = phone ? m.shell_you() : m.account_menu();
    const trigger = await canvas.findByRole('button', { name: menuName });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const menu = await within(document.body).findByRole('dialog', { name: menuName });
    const link = await within(menu).findByRole('link', { name: m.realms_heading() });
    await expect(link).toBeVisible();
    link.focus();
    await expect(link).toHaveAttribute('href', `/${getLocale()}/realms`);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(menu).not.toBeVisible());
    await waitFor(() => expect(canvas.getByRole('heading', { level: 1, name: m.realms_heading() })).toBeVisible());
    await waitFor(() => expect(trigger).toHaveFocus());
    await firstRealmLink(within(await canvas.findByRole('main')));
  },
  render: () => <PageStory visitor="Signed In" path="/" />,
};
