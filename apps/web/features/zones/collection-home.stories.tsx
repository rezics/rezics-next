import { spaceHref } from '../address/path.ts';
import { direction } from '@rezics/main/language';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { seriesWorks, zoneFor } from '../official-zone-stories/release-fixtures.ts';
import { RealmPageStory } from '../realm/story-page.tsx';
import type { PlacedModule } from './zone-home.tsx';

const notice = 'Series and volumes from the shared catalogue.';

/** Collection previews still render when no official package is active, as on the local seeded homes. */
function Home({
  slug,
  state,
  locale,
}: {
  slug: 'light-novels' | 'visual-novels';
  state: 'ready' | 'empty' | 'failed';
  locale: UiLocale;
}) {
  const zone = zoneFor(slug, locale);
  const modules: PlacedModule[] = [
    {
      module: {
        id: 'notice',
        type: 'announcement',
        title: 'Series and volumes from the shared catalogue.',
        layout: 'covers',
        rail: false,
        shuffle: false,
        more: null,
      },
      state: {
        state: 'ready',
        data: { text: { value: notice, lang: 'en', dir: direction('en', notice) }, href: null },
      },
    },
    {
      module: {
        id: 'catalogue',
        type: 'shelf',
        title: zone.name.value,
        layout: 'covers',
        rail: false,
        shuffle: false,
        more: spaceHref(slug, 'site', ['catalogue']),
      },
      state:
        state === 'ready'
          ? {
              state,
              data: { tabs: [{ id: 'catalogue', label: zone.name.value, items: seriesWorks }] },
            }
          : { state },
    },
  ];
  return (
    <RealmPageStory
      site
      zone={zone}
      modules={modules}
      locale={locale}
      navigation={[{ label: 'Catalogue', href: spaceHref(slug, 'site', ['catalogue']) }]}
    />
  );
}

const meta = {
  title: 'Zones/Collection Home',
  component: Home,
  args: { slug: 'light-novels', state: 'ready', locale: 'en' },
  parameters: { route: { pathname: '/en/z/light-novels' } },
} satisfies Meta<typeof Home>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LightNovels: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Sword Art Online' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: /^More$/ })).toHaveAttribute(
      'href',
      '/en/z/light-novels/catalogue',
    );
    await expect(canvas.queryByText('Nothing here yet')).toBeNull();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('heading', { name: 'Sword Art Online' }),
    ).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const EmptyWithAnnouncement: Story = {
  args: { state: 'empty' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Nothing here yet')).toBeVisible();
    await expect(canvas.getByText('Series and volumes from the shared catalogue.')).toBeVisible();
  },
};

export const Failed: Story = {
  args: { state: 'failed' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(within(canvasElement).queryByText('Nothing here yet')).toBeNull();
  },
};
