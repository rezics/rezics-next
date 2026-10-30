import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { AccountMenu, NavigationToggle } from '../shell/shell';
import { PatternStory, pagePaths, pageReady } from './page';

const meta = {
  title: 'Patterns/Account/Shell',
  parameters: {
    viewport: {
      options: {
        phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
        desktop: { name: 'Desktop', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function ShellPattern({ visitor }: { visitor: 'Signed In' | 'Signed Out' }) {
  const session = visitor === 'Signed In' ? 'signed-in' : 'signed-out';
  return (
    <PatternStory visitor={visitor} path={pagePaths.shell}>
      <main className="flex w-full max-w-4xl items-center gap-3 p-4" aria-label="Shell controls">
        <NavigationToggle collapsed={false} onToggle={() => undefined} pathname="/" session={session} />
        <AccountMenu session={session} csrfToken={visitor === 'Signed In' ? 'story-csrf-token' : null} />
      </main>
    </PatternStory>
  );
}

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
  name: 'Member',
  play: pageReady,
  render: () => <ShellPattern visitor="Signed In" />,
};

export const SignedOut: Story = {
  name: 'Signed out, account menu open',
  play: async (context) => {
    const menu = await accountMenu(context);
    const signIn = await within(menu).findByRole('link', { name: m.account_sign_in() });
    await expect(signIn).toBeVisible();
    const phoneMenu = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
    const focusedWhenOpened = signIn === document.activeElement;
    if (!phoneMenu) await expect(focusedWhenOpened).toBe(true);
    const underlinedWhenOpened = signIn.matches(':hover, :focus-visible');
    if (underlinedWhenOpened) await expect(getComputedStyle(signIn).textDecorationLine).toContain('underline');
    else await expect(getComputedStyle(signIn).textDecorationLine).not.toContain('underline');

    signIn.blur();
    await expect(document.activeElement).not.toBe(signIn);
    await expect(signIn.matches(':hover, :focus-visible')).toBe(false);
    await expect(getComputedStyle(signIn).textDecorationLine).not.toContain('underline');
  },
  render: () => <ShellPattern visitor="Signed Out" />,
};

export const MemberAccountMenuOpen: Story = {
  name: 'Member, account menu open',
  play: async (context) => {
    const menu = await accountMenu(context);
    await within(menu).findByRole('link', { name: m.account_security_settings() });
    await within(menu).findByRole('button', { name: m.account_sign_out() });
  },
  render: () => <ShellPattern visitor="Signed In" />,
};

// The navigation control is phone-only here and opens its menu as a sheet.
export const Navigation: Story = {
  name: 'Navigation available',
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
  globals: { viewport: { value: 'phone' } },
  render: () => <ShellPattern visitor="Signed In" />,
};
