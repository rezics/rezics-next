import { direction } from '@rezics/main/language';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import lightNovels from '../../zones/official/light-novels/index.tsx';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { messages as realmMessages } from '../realm/messages.ts';
import { RealmPageStory } from '../realm/story-page.tsx';
import * as tracking from '../tracking/fixtures.ts';
import { createMemoryMain, memoryReader } from '../tracking/memory.ts';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import { IndexPage } from '../zones/site-pages.tsx';
import { cardRenderer, type PlacedModule, workRenderers, ZoneHome } from '../zones/zone-home.tsx';
import { seriesWorks, zoneFor } from './release-fixtures.ts';

// The Light Novels Zone: series cards and "Continue your series" with the next volume Main reports. The hub's
// series progress and parts lead a series' page by the Zone's `hubOrder`; that is covered with the hub's stories.

const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

/** Main's progress for the first series, after volume 1: volume 2 is next and readable in the reader's language. */
function memory(locale: UiLocale) {
  const main = createMemoryMain({ summaries: { [locale]: { ...tracking.indexSummary, language: locale,
    counts: { completed: 1, required: 3, completedRequired: 1 }, completedParts: [tracking.indexSummary.completedParts[0]!],
    next: { part: { ...tracking.indexSummary.completedParts[1]!, displayLabel: 'Volume 2', available: true },
      reason: 'next_available_required_part' } } } });
  return memoryReader(main, { [seriesWorks[0]!.id]: 'reading' });
}

function Series({ locale, signedIn, surface }: { locale: UiLocale; signedIn: boolean; surface: 'shelf' | 'index' }) {
  const zone = zoneFor('light-novels', locale);
  const messages = zoneMessagesFor(locale);
  const [actions] = useState(() => memory(locale));
  const card = cardRenderer(zone, lightNovels, locale, messages);
  const shelf = { module: { id: 'shelf', type: 'shelf', title: 'Light Novels', rail: false, layout: 'covers', shuffle: false,
    more: null }, state: { state: 'ready', data: { tabs: [{ id: 'all', label: 'All', items: seriesWorks }] } } } as PlacedModule;
  const Slot = lightNovels.slots.index!;
  const items = seriesWorks.map(work => ({ id: work.id, revision: work.id, mainVersion: work.id,
    title: { value: work.title!.value, language: 'en', direction: direction('en', work.title!.value), basis: 'requested' as const },
    cover: { kind: 'fallback' as const, policy: 'zone', key: work.id, resourceType: 'work' }, types: [],
    tagline: null, completionStatus: null, chapterCount: null, wordCount: null, lastUpdatedAt: null, inZone: true }));
  const route = { name: 'Catalogue', language: 'en', direction: direction('en', 'Catalogue'), profile: 'zone-route-v1' as const, zone: 'z',
    path: '/catalogue', realm: null, revision: 'r', sourcePosition: { dataEpoch: 'e', sequence: '1' }, cost: {} as never,
    kind: 'index' as const, mount: { occurrence: 'o', segment: 'catalogue', target: 't' }, collection: 'c', items,
    nextCursor: null };
  const page = surface === 'shelf'
    ? <ZoneHome modules={[shelf]} zone={zone} pkg={lightNovels} locale={locale} messages={messages} empty={null} />
    : <main><IndexPage route={route} title="Catalogue" cursor={undefined}
      context={{ locale, ref: 'light-novels', realm: 'r', mounts: new Map() }} card={card} locale={locale}
      messages={realmMessages} arrange={(works, grid) => <Slot zone={zone} works={works} fallback={grid}
        Link={'a' as never} {...workRenderers(card, locale, messages)} />} /></main>;
  return <RealmPageStory zone={zone} pkg={lightNovels} execution={{ mode: 'package', slug: 'light-novels' }} locale={locale}>
    {signedIn ? <ReaderActionsProvider signedIn signInHref="/auth/start" actions={actions}>{page}</ReaderActionsProvider> : page}
  </RealmPageStory>;
}

const meta = {
  title: 'Zones/Light Novels',
  component: Series,
  args: { locale: 'en', signedIn: true, surface: 'index' },
  parameters: { route: { pathname: '/en/r/light-novels/catalogue' } },
  render: (args, { globals }) => <Series {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof Series>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The catalogue page: "Continue your series" leads, then the series with their next volume. */
export const Catalogue: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const shelf = await canvas.findByRole('region', { name: 'Continue your series' });
    await expect(within(shelf).getAllByRole('link', { name: 'Volume 2' })[0]).toBeVisible();
    await expect(canvas.getAllByText('Sword Art Online').length).toBeGreaterThan(1);
    await expect(canvas.getByRole('link', { name: 'Open the Visual Novels Zone' })).toHaveAttribute('href', '/en/r/visual-novels');
    await expect(canvas.getByText(/does not sell books, link to stores, show prices/)).toBeVisible();
    await fits();
  },
};

/** The same shelf on a Zone home that has a shelf module. */
export const Shelf: Story = {
  args: { surface: 'shelf' },
  async play({ canvasElement }) {
    const shelf = await within(canvasElement).findByRole('region', { name: 'Continue your series' });
    await expect(within(shelf).getAllByRole('link', { name: 'Volume 2' })[0]).toBeVisible();
  },
};

/** Signed out, no next-volume line or shelf is drawn; the cards are the platform's. */
export const SignedOut: Story = {
  args: { signedIn: false },
  async play({ canvasElement }) {
    await expect(canvasElement.querySelector('[data-next-volume-shelf]')).toBeNull();
    await expect(canvasElement.querySelector('[data-next-volume]')).toBeNull();
    await expect(within(canvasElement).getAllByText('Sword Art Online').length).toBeGreaterThan(0);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await within(canvasElement).findByRole('region', { name: 'Continue your series' });
    await fits();
  },
};
