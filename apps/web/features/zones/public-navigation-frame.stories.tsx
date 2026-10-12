import type { Meta, StoryObj } from '@storybook/react-vite';
import { direction } from '@rezics/main/language';
import { expect, within } from 'storybook/test';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { surfaceText } from '../address/messages.ts';
import { RealmMembership } from '../realm/membership.tsx';
import { messages } from '../realm/messages.ts';
import { realmHref, siteHref } from '../realm/route.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { fictionZone } from './fixtures.ts';
import { savedSiteCuts } from './site-cuts.ts';
import { zoneTheme } from './theme.ts';
import { ZoneFrame, ZoneMasthead } from './zone-frame.tsx';

const ref = 'harbor-library';
const mounts = Array.from({ length: 51 }, (_, index) => ({
  segment: `guide-${String(index + 1).padStart(2, '0')}`,
  name: { value: `Guide ${index + 1}`, lang: 'en', dir: direction('en', `Guide ${index + 1}`) },
}));

/** The server frames share this renderer and the same complete navigation cut.
 * Their boundary tests cover server composition; this story exercises its links. */
function PublicNavigationFrame({ realm }: { realm: boolean }) {
  const base = fictionZone('en');
  const zone = { ...base, slug: null, realm: realm ? base.realm : null,
    name: { value: 'Harbor library', lang: 'en', dir: direction('en', 'Harbor library') },
    icon: null, hero: null, links: { ...base.links, home: siteHref('en', ref, []) } };
  const cuts = savedSiteCuts({ tokens: zone.tokens, navigation: [] }, mounts, ref, 'en', messages.home);
  const actions = realm ? <>
    <RealmMembership realm={zone.realm!} realmName={zone.name.value} initial={null} signedIn={false}
      signInHref="/auth/start" rulesHref={realmHref('en', ref, 'about')} locale="en" messages={messages} />
    <LocalizedLink href={realmHref('en', ref)} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
      {surfaceText.community.en}
    </LocalizedLink>
  </> : null;
  return <ZoneFrame zone={zone} dataZone={ref} theme={zoneTheme(cuts.tokens, { reader: 'light', enabled: true })}
    pkg={null} actions={actions} members={null} masthead={<ZoneMasthead zone={zone} members={null} actions={actions} />}
    tabs={null} site={{ label: realm ? surfaceText.site.en : zone.name.value, links: cuts.navigation }}>
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-10">
      <h2 className="text-xl font-semibold">Guide 51</h2>
      <p className="mt-3 text-muted-foreground">Walking routes, reading lists and local references for the harbor.</p>
    </main>
  </ZoneFrame>;
}

const meta = {
  title: 'Zones/Public navigation continuation',
  component: PublicNavigationFrame,
  args: { realm: true },
  parameters: { route: { pathname: localizedPath(spaceHref(ref, 'site', ['guide-51']), 'en') } },
} satisfies Meta<typeof PublicNavigationFrame>;
export default meta;
type Story = StoryObj<typeof meta>;

const completeNavigation: Story['play'] = async ({ canvasElement, args }) => {
  const navigation = within(canvasElement).getByRole('navigation', { name: args.realm ? surfaceText.site.en : 'Harbor library' });
  const links = within(navigation).getAllByRole('link');
  await expect(links.map(link => link.textContent)).toEqual([messages.home, ...mounts.map(mount => mount.name.value)]);
  const last = within(navigation).getByRole('link', { name: /^Guide 51$/ });
  await expect(last).toHaveAttribute('href', localizedPath(spaceHref(ref, 'site', ['guide-51']), 'en'));
  await expect(last).toHaveAttribute('aria-current', 'page');
  last.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  await expect(last).toBeVisible();
  await expect(last.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
  await expect(last.getBoundingClientRect().right).toBeLessThanOrEqual(innerWidth);
};

export const RealmSite: Story = { args: { realm: true }, play: completeNavigation };
export const StandaloneSite: Story = { args: { realm: false }, play: completeNavigation };
