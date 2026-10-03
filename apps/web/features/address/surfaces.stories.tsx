import { direction } from '@rezics/main/language';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { realmMessagesFor } from '../realm/story-page.tsx';
import { RealmTabs } from '../realm/realm-tabs.tsx';
import { realmHref, siteHref } from '../realm/route.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { fictionZone } from '../zones/fixtures.ts';
import { presetTokens } from '../zones/presentation.ts';
import { zoneTheme } from '../zones/theme.ts';
import { ZoneFrame, ZoneMasthead } from '../zones/zone-frame.tsx';
import { surfaceText } from './messages.ts';

function Surface({ site, paired, locale }: { site: boolean; paired: boolean; locale: UiLocale }) {
  const zone = fictionZone(locale, presetTokens.serial);
  const messages = realmMessagesFor(locale);
  const actions = paired ? <LocalizedLink href={site ? realmHref(locale, 'fiction') : siteHref(locale, 'fiction', [])}
    className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
    {site ? surfaceText.community[locale] : surfaceText.site[locale]}</LocalizedLink> : null;
  return <ZoneFrame zone={zone} dataZone="fiction" theme={zoneTheme(zone.tokens, { reader: 'light', enabled: true })}
    pkg={null} members={null} actions={actions} masthead={<ZoneMasthead zone={zone} members={null} actions={actions} />}
    tabs={site ? null : <RealmTabs locale={locale} realmRef="fiction" label={messages.sections} navigation={[]}
      labels={{ home: messages.home, about: messages.about, discussions: messages.discussions,
        decisions: messages.decisions, browse: messages.browse, works: messages.works }} />}
    site={site ? { label: surfaceText.site[locale], links: [
      { href: siteHref(locale, 'fiction', []), label: { value: messages.home, lang: locale, dir: direction(locale, messages.home) } },
      // A site is free to mount the path that used to lose to the community's fixed tab.
      { href: siteHref(locale, 'fiction', ['about']), label: { value: messages.about, lang: locale, dir: direction(locale, messages.about) } },
    ] } : undefined}>
    <PageContainer><p lang={zone.description?.lang}>{zone.description?.value}</p></PageContainer>
  </ZoneFrame>;
}

const meta = { title: 'Address/Space surfaces', component: Surface,
  args: { site: true, paired: true, locale: 'en' },
  parameters: { route: { pathname: '/en/z/fiction/about' } },
  render: (args, { globals }) => <Surface {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof Surface>;
export default meta;
type Story = StoryObj<typeof meta>;

async function capture(name: string) {
  if (import.meta.env.VITE_G943_VISUAL === '1') {
    const { page } = await import('vitest/browser');
    await document.fonts.ready;
    await page.screenshot({ path: `../../../../.temp/g-943-${name}.png` });
  }
}
export const Site: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.queryByRole('navigation', { name: 'Community sections' })).toBeNull();
  await expect(canvas.getByRole('link', { name: 'About' })).toHaveAttribute('aria-current', 'page');
  await expect(canvas.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  await expect(canvas.getByRole('link', { name: 'Community' })).toHaveAttribute('href', '/en/r/fiction');
  await capture('site');
} };
export const Community: Story = { args: { site: false }, parameters: { route: { pathname: '/en/r/fiction' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('navigation', { name: 'Community sections' })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'Browse works' })).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Site' })).toHaveAttribute('href', '/en/z/fiction');
    await capture('community');
  } };
export const SiteWithoutRealm: Story = { args: { paired: false }, async play({ canvasElement }) {
  await expect(within(canvasElement).queryByRole('link', { name: 'Community' })).toBeNull();
} };
export const CommunityWithoutSite: Story = { args: { site: false, paired: false },
  parameters: { route: { pathname: '/en/r/fiction' } }, async play({ canvasElement }) {
    await expect(within(canvasElement).queryByRole('link', { name: 'Site' })).toBeNull();
  } };
export const SitePhoneChinese: Story = { globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  parameters: { route: { pathname: '/zh-Hans/z/fiction/about' } }, async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: '社区' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
    await capture('site-phone-chinese');
  } };
