import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { BottomNav } from './bottom-nav.tsx';
import { messages, type ShellMessages } from './messages.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';
import { navigation } from './navigation.ts';
import { ShellProvider } from './shell-provider.tsx';
import { setUnread } from './unread.ts';

const catalogs: Record<UiLocale, ShellMessages> = {
  en: messages, 'zh-Hant': { ...messages, ...zhHant }, 'zh-Hans': { ...messages, ...zhHans },
  ja: { ...messages, ...ja }, ko: { ...messages, ...ko }, de: { ...messages, ...de },
  fr: { ...messages, ...fr }, es: { ...messages, ...es },
};

function PhoneNavigation({ locale }: { locale: UiLocale }) {
  const [signedIn, setSignedIn] = useState(true);
  return <ShellProvider locale={locale} messages={catalogs[locale]} initialTheme="light" initialCollapsed={false} signedIn={signedIn}>
    <main className="p-4">
      <button className="rounded-lg border px-3 py-2" onClick={() => setSignedIn(value => !value)}>
        {signedIn ? 'Sign out' : 'Sign in'}
      </button>
    </main>
    <BottomNav />
  </ShellProvider>;
}

const meta = {
  title: 'Shell/Phone navigation', component: PhoneNavigation,
  args: { locale: 'en' }, globals: { viewport: { value: 'phone' } },
  parameters: { route: { pathname: '/en/notifications' } },
  beforeEach() {
    setUnread({ count: 3, overflow: false });
    return () => setUnread(null);
  },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const t = materializeData(catalogs[args.locale], { locale: args.locale });
    const nav = within(canvas.getByRole('navigation', { name: t.navigation }));
    const check = async (count: string | null) => {
      for (const item of navigation.filter(item => item.bottom)) {
        const caption = item.bottomLabel?.[args.locale] ?? item.label[args.locale];
        const name = item.href === '/notifications' && count ? `${caption} · ${t.unreadCount({ count })}` : caption;
        const link = nav.getByText(caption, { exact: true }).closest('a')!;
        await expect(link).toHaveAccessibleName(name);
        await expect(link).toHaveAttribute('href', localizedPath(item.href, args.locale));
        if (item.href === '/notifications') await expect(link).toHaveAttribute('aria-current', 'page');
      }
    };
    await waitFor(() => check('3'));
    setUnread({ count: 0, overflow: false });
    await waitFor(() => check(null));
    await userEvent.click(canvas.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => check(null));
    setUnread({ count: 120, overflow: true });
    await userEvent.click(canvas.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => check('99+'));
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
} satisfies Meta<typeof PhoneNavigation>;
export default meta;
type Story = StoryObj<typeof meta>;

export const English: Story = {};
export const TraditionalChinese: Story = { args: { locale: 'zh-Hant' }, globals: { locale: 'zh-Hant' } };
export const SimplifiedChinese: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' } };
export const Japanese: Story = { args: { locale: 'ja' }, globals: { locale: 'ja' } };
export const Korean: Story = { args: { locale: 'ko' }, globals: { locale: 'ko' } };
export const German: Story = { args: { locale: 'de' }, globals: { locale: 'de' } };
export const French: Story = { args: { locale: 'fr' }, globals: { locale: 'fr' } };
export const Spanish: Story = { args: { locale: 'es' }, globals: { locale: 'es' } };
export const Dark: Story = { globals: { theme: 'dark' } };
