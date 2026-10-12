import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { fictionZone, zoneMessagesFor } from '../zones/fixtures.ts';
import { ZoneHome } from '../zones/zone-home.tsx';
import { zoneTheme } from '../zones/theme.ts';
import { collectionPreview, previewCollection, previewReaders } from './home-modules.fixtures.ts';
import { loadPublishedHomeModules, localizedHomePresentation } from './home-modules.ts';

function PublishedModules({ unavailable = false }: { unavailable?: boolean }) {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof loadPublishedHomeModules>> | null>(null);
  useEffect(() => {
    const selected = collectionPreview(unavailable ? 'partial' : 'complete');
    const shelf = selected.presentation.modules[0]!;
    const query = { kind: 'query-block' as const, block: 'selected-query' };
    selected.presentation.modules = [{ ...shelf, source: query },
      { ...shelf, id: 'selected-hero', type: 'hero-carousel', title: 'Collection highlight' }];
    selected.moduleData = [{ id: shelf.id, sources: [{ ...selected.moduleData[0].sources[0], source: query }] },
      { id: 'selected-hero', sources: selected.moduleData[0].sources }];
    void loadPublishedHomeModules(selected, localizedHomePresentation(selected.presentation, 'en'),
      { locale: 'en', ref: 'harbor', realm: previewCollection, mounts: new Map([[previewCollection, 'reading']]) },
      previewReaders()).then(setLoaded);
  }, [unavailable]);
  const zone = fictionZone('en');
  const theme = zoneTheme(zone.tokens, { reader: 'light', enabled: true });
  return loaded ? <div className={`${theme.className} min-h-dvh bg-(--zone-page)`} style={theme.style}>
    <ZoneHome modules={loaded.modules} zone={zone} pkg={null}
      locale="en" messages={zoneMessagesFor('en')} empty={null} />
  </div> : null;
}

const meta = { title: 'Zone/Site/Resolved home content', component: PublishedModules,
  parameters: { layout: 'fullscreen' } } satisfies Meta<typeof PublishedModules>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PublishedSelectedSources: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selected = await canvas.findAllByText('The saved Collection member');
    await expect(new Set(selected.map(element => element.closest('.showcase-slide') ? 'hero-carousel'
      : element.closest('[data-zone-module]')?.getAttribute('data-zone-module'))))
      .toEqual(new Set(['hero-carousel', 'shelf']));
    await expect(canvas.getByRole('heading', { name: 'Saved reading list' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const IncompletePublishedSources: Story = {
  args: { unavailable: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findAllByRole('status')).toHaveLength(2);
    await expect(canvas.queryByText('The saved Collection member')).not.toBeInTheDocument();
  },
};
