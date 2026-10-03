import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { messages } from './messages.ts';
import { NotificationSettings } from './notification-settings.tsx';

function Preferences({ locale }: { locale: UiLocale }) {
  return <main className="mx-auto w-full max-w-3xl p-4"><NotificationSettings
    t={messages[locale]} preview /></main>;
}

const meta = { title: 'Settings/Subscription notifications', component: Preferences,
  args: { locale: 'en' }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const t = messages[args.locale];
    for (const label of [t.notificationNewWork, t.notificationNewRelease, t.notificationCollectionChange]) {
      await expect(canvas.getByText(label)).toBeVisible();
      await expect(canvas.getByRole('switch', { name: `${label} · ${t.notificationInbox}` })).toBeVisible();
      await expect(canvas.getByRole('switch', { name: `${label} · ${t.notificationEmail}` })).toBeVisible();
    }
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
  async afterEach(context) {
    if (import.meta.env.VITE_G944_CAPTURE !== '1') return;
    const { page } = await import('vitest/browser');
    await document.fonts.ready;
    await page.screenshot({ path: `../../../../.temp/g-944/screenshots/${context.id}.png` });
  },
} satisfies Meta<typeof Preferences>;
export default meta;
type Story = StoryObj<typeof meta>;
const localized = (locale: UiLocale): Story => ({ args: { locale }, globals: { locale } });

export const English: Story = localized('en');
export const TraditionalChinese: Story = localized('zh-Hant');
export const SimplifiedChinese: Story = localized('zh-Hans');
export const Japanese: Story = localized('ja');
export const Korean: Story = localized('ko');
export const German: Story = localized('de');
export const French: Story = localized('fr');
export const Spanish: Story = localized('es');
export const Desktop: Story = { ...localized('en'), globals: { locale: 'en', viewport: { value: 'desktop' } } };
