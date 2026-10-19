import type { Meta, StoryObj } from '@storybook/react-vite';
import { direction } from '@rezics/main/language';
import { expect, userEvent, within } from 'storybook/test';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { fixturePage } from '../discover/browse-fixtures.ts';
import { emptyBrowse } from '../discover/browse-state.ts';
import { DiscoverView } from '../discover/discover-view.tsx';
import { comfortReads, libraryState, memoryLibraryApi, storyNow, storyOverview, storyReaderActions, storyView }
  from '../library/fixtures.ts';
import { LibraryPage } from '../library/library-page.tsx';
import { messages as libraryMessages } from '../library/messages.ts';
import { agents, curated, now, serial } from '../studio/fixtures.ts';
import { messages as studioMessages } from '../studio/messages.ts';
import { StudioFrame } from '../studio/studio-frame.tsx';
import { StudioHome } from '../studio/studio-home.tsx';
import { StudioWorkFrame } from '../studio/studio-work.tsx';
import { ZoneSiteNavigation } from '../zones/site-navigation.tsx';
import { expectNavigationFocus, expectRevealedSelection, expectUnclippedFocus } from './navigation-focus.test-utils.ts';
import { Providers } from './providers.tsx';

type Surface = 'discover' | 'studio-home' | 'studio-work' | 'site' | 'custom-shelf' | 'loans';
const site = 'harbor-library';
const siteLinks = Array.from({ length: 52 }, (_, index) => ({
  href: localizedPath(spaceHref(site, 'site', index ? [`guide-${index}`] : []), 'en'),
  label: { value: index ? `Guide ${index}` : 'Home', lang: 'en', dir: direction('en', 'Guide') },
}));

/** Actual row owners, with the same fixture reads as their feature stories. No route activation is simulated. */
function NavigationFocus({ surface }: { surface: Surface }) {
  if (surface === 'discover') return <Providers><DiscoverView locale="en" state={{ ...emptyBrowse, tab: 'topics' }}
    signedIn={false} topics={[]} sections={null} results={{ ok: true, data: fixturePage([]) }} /></Providers>;
  if (surface === 'site') return <ZoneSiteNavigation label="Harbor library" links={siteLinks} />;
  if (surface === 'studio-home' || surface === 'studio-work') return <StudioFrame agent={agents[0]!}
    agents={agents} session={agents[0]!} path="" locale="en" messages={studioMessages}>
    {surface === 'studio-home' ? <StudioHome agent={agents[0]!} content={{ view: 'curated', works: { ok: true, data: curated } }}
      moreHref={null} now={now} locale="en" messages={studioMessages} />
      : <StudioWorkFrame agent={agents[0]!} work={serial} languages={['zh-Hans']} tab="realms"
        locale="en" messages={studioMessages}><h2>Realms</h2></StudioWorkFrame>}
  </StudioFrame>;
  const state = libraryState(surface === 'custom-shelf' ? { shelf: comfortReads.id.slice(-36) } : {});
  return <LibraryPage state={state} overview={{ ok: true, data: storyOverview() }} view={{ ok: true, data: storyView(state) }}
    api={memoryLibraryApi()} readerActions={storyReaderActions()} reading={[]} now={storyNow} locale="en"
    messages={libraryMessages} loansView={surface === 'loans' ? <h2>Loans</h2> : undefined} />;
}

const selected: Record<Surface, { name: string; count: number }> = {
  discover: { name: 'Topics', count: 7 }, 'studio-home': { name: 'Imported & curated', count: 5 },
  'studio-work': { name: 'Realms', count: 4 }, site: { name: 'Guide 51', count: 52 },
  'custom-shelf': { name: 'Comfort reads Only you can see this shelf', count: 7 }, loans: { name: 'Loans', count: 7 },
};
const meta = {
  title: 'Shell/Navigation focus', component: NavigationFocus, args: { surface: 'discover' },
  parameters: { route: { pathname: '/en/discover' } },
  async play({ canvasElement, args }) {
    const expected = selected[args.surface];
    const current = within(canvasElement).getByRole('link', { name: expected.name });
    const navigation = current.closest('nav')!;
    // These remain separate from the painted-focus assertions below.
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(current).toHaveAccessibleName(expected.name);
    await expect(within(navigation).getAllByRole('link')).toHaveLength(expected.count);
    await expectRevealedSelection(current);
    await expectNavigationFocus(navigation);
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  },
} satisfies Meta<typeof NavigationFocus>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' }, theme: 'light' };
const desktop = { viewport: { value: 'desktop1440' }, theme: 'light' };
export const DiscoverPhoneLight: Story = { globals: phone };
export const DiscoverPhoneDark: Story = { globals: { ...phone, theme: 'dark' } };
export const DiscoverDesktopLight: Story = { globals: desktop };
export const DiscoverDesktopDark: Story = { globals: { ...desktop, theme: 'dark' } };
export const DiscoverFocusDuringResize: Story = {
  globals: phone,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const first = canvas.getByRole('link', { name: 'All' });
    const navigation = first.closest('nav')!;
    within(navigation).getAllByRole('link')[1]!.focus();
    await userEvent.tab({ shift: true });
    await expectUnclippedFocus(first);
    navigation.style.width = '280px';
    // Let native resize delivery finish before checking that it did not reveal the offscreen selection instead.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await expectUnclippedFocus(first);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await expectUnclippedFocus(first);
    await expect(canvas.getByRole('link', { name: 'Topics' })).toHaveAttribute('aria-current', 'page');
  },
};
const studioHome: Story = { args: { surface: 'studio-home' } };
export const StudioViewsPhoneLight: Story = { ...studioHome, globals: phone };
export const StudioViewsPhoneDark: Story = { ...studioHome, globals: { ...phone, theme: 'dark' } };
export const StudioViewsDesktopLight: Story = { ...studioHome, globals: desktop };
export const StudioViewsDesktopDark: Story = { ...studioHome, globals: { ...desktop, theme: 'dark' } };
const studioWork: Story = { args: { surface: 'studio-work' } };
export const StudioTabsPhoneLight: Story = { ...studioWork, globals: phone };
export const StudioTabsPhoneDark: Story = { ...studioWork, globals: { ...phone, theme: 'dark' } };
export const StudioTabsDesktopLight: Story = { ...studioWork, globals: desktop };
export const StudioTabsDesktopDark: Story = { ...studioWork, globals: { ...desktop, theme: 'dark' } };
const publicSite: Story = { args: { surface: 'site' },
  parameters: { route: { pathname: siteLinks.at(-1)!.href } } };
export const PublicSitePhoneLight: Story = { ...publicSite, globals: phone };
export const PublicSitePhoneDark: Story = { ...publicSite, globals: { ...phone, theme: 'dark' } };
export const PublicSiteDesktopLight: Story = { ...publicSite, globals: desktop };
export const PublicSiteDesktopDark: Story = { ...publicSite, globals: { ...desktop, theme: 'dark' } };
const shelf: Story = { args: { surface: 'custom-shelf' }, parameters: { route: { pathname: '/en/library' } } };
export const CustomShelvesPhoneLight: Story = { ...shelf, globals: phone };
export const CustomShelvesPhoneDark: Story = { ...shelf, globals: { ...phone, theme: 'dark' } };
export const CustomShelvesDesktopLight: Story = { ...shelf, globals: desktop };
export const CustomShelvesDesktopDark: Story = { ...shelf, globals: { ...desktop, theme: 'dark' } };
const loans: Story = { args: { surface: 'loans' }, parameters: { route: { pathname: '/en/library/loans' } } };
export const LoansPhoneLight: Story = { ...loans, globals: phone };
export const LoansPhoneDark: Story = { ...loans, globals: { ...phone, theme: 'dark' } };
export const LoansDesktopLight: Story = { ...loans, globals: desktop };
export const LoansDesktopDark: Story = { ...loans, globals: { ...desktop, theme: 'dark' } };
