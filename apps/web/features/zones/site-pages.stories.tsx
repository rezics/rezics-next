import { direction } from '@rezics/main/language';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { messages } from '../realm/messages.ts';
import { metadataOnlyWork, text } from '../work-page/fixtures.ts';
import { messages as workMessages } from '../work-page/messages.ts';
import { fictionZone, works, zoneMessagesFor } from './fixtures.ts';
import { DocumentPage, IndexPage, PageNotAvailable } from './site-pages.tsx';
import { ZoneBreadcrumbs, ZoneSiteNavigation } from './site-navigation.tsx';
import { cardRenderer } from './zone-home.tsx';

// The pages a Zone's mounts give it, and the navigation and breadcrumbs that lead to them.

const name = (value: string) => ({ value, lang: 'en', dir: direction('en', value) });
const links = [{ href: '/r/books/guide', label: name('Guide') }, { href: '/r/books/picks', label: name('Picks') }];
const zone = fictionZone('en');
const card = cardRenderer(zone, null, 'en', zoneMessagesFor('en'));

const items = works.slice(0, 6).map(work => ({ id: work.id, revision: work.id, mainVersion: work.id,
  title: { value: work.title?.value ?? '', language: 'en', direction: direction('en', work.title?.value ?? ''), basis: 'requested' as const },
  cover: { kind: 'fallback' as const, policy: 'zone', key: work.id, resourceType: 'work' }, types: [],
  tagline: null, completionStatus: null, chapterCount: null, wordCount: null, lastUpdatedAt: null, inZone: true }));
const route = { name: 'Books', language: 'en', direction: direction('en', 'Books'), profile: 'zone-route-v1' as const, zone: 'z', path: '/picks', realm: null, revision: 'r',
  sourcePosition: { dataEpoch: 'e', sequence: '1' }, cost: {} as never, kind: 'index' as const,
  mount: { occurrence: 'o', segment: 'picks', target: 't' }, collection: 'c', items, nextCursor: 'next' };

const meta = {
  title: 'Zones/Site pages',
  parameters: { route: { pathname: '/en/r/books/guide' } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Home → mounted page → the page itself, under the navigation that marks where the reader is. */
export const Navigation: Story = {
  render: () => <div className="bg-(--zone-page)">
    <ZoneSiteNavigation links={links} label="Pages in this community" />
    <ZoneBreadcrumbs label="Breadcrumb" crumbs={[{ label: name('Books'), href: '/r/books' },
      { label: name('Guide'), href: null }]} />
  </div>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Guide' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('link', { name: 'Picks' })).not.toHaveAttribute('aria-current');
    const crumbs = within(canvas.getByRole('navigation', { name: 'Breadcrumb' }));
    await expect(crumbs.getByRole('link', { name: 'Books' })).toHaveAttribute('href', '/en/r/books');
    await expect(crumbs.getByText('Guide')).toHaveAttribute('aria-current', 'page');
  },
};

/** A mounted document: its published text under its title, with none of the reader's chrome. */
export const Document: Story = {
  render: () => <DocumentPage work={{ ...metadataOnlyWork, title: { ...metadataOnlyWork.title, value: 'A reader’s guide' } }}
    text={{ ...text, body: 'Start here\nOpen a work and read it.\nPicks\nFollow the list a page at a time.' }}
    messages={workMessages.en} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'A reader’s guide' })).toBeVisible();
    await expect(canvas.getByText('Open a work and read it.')).toBeVisible();
  },
};

/** A mounted Collection: each member opens under the mount, and the next page is a link. */
export const Index: Story = {
  render: () => <IndexPage route={route} title="Picks" cursor={undefined}
    context={{ locale: 'en', ref: 'books', realm: 'r', mounts: new Map() }} card={card} locale="en"
    messages={messages} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Picks' })).toBeVisible();
    const hrefs = canvas.getAllByRole('link').map(link => link.getAttribute('href') ?? '');
    await expect(hrefs.filter(href => href.includes('/w/') || href.includes('/picks/')).every(href =>
      href.startsWith('/en/r/books/picks/'))).toBe(true);
    await expect(canvas.getByRole('link', { name: /Next page/ })).toHaveAttribute('href', '/en/r/books/picks?cursor=next');
  },
};

/** A page this host cannot show yet keeps the Zone's frame and says so once. */
export const NotAvailable: Story = {
  render: () => <PageNotAvailable messages={messages} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { level: 1, name: messages.pageNotYetTitle })).toBeVisible();
  },
};
