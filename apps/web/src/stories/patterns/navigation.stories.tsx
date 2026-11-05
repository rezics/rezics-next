import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { NavigationLinks, NavigationProvider } from '../../shell/navigation-view';
import { createNavigation, type NavigationSession } from '../../shell/navigation';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { PatternStory } from '../page';
import { threadsNavigation } from '../../threads/navigation';
import { catalogueNavigation } from '../../features/catalogue/navigation';
import { importReviewNavigation } from '../../features/import-review/navigation';
import { communityNavigation } from '../../community/navigation';
import { libraryNavigation } from '../../library/navigation';
import { contextsNavigation } from '../../features/contexts/navigation';
import { zonesNavigation } from '../../features/zones/manage/navigation';

const meta = {
  title: 'Patterns/Navigation/Contributions',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const contributions = createNavigation([
  ...threadsNavigation,
  ...catalogueNavigation,
  ...importReviewNavigation,
  ...communityNavigation,
  ...libraryNavigation,
  ...contextsNavigation,
  ...zonesNavigation,
  {
    id: 'community.realms',
    kind: 'navigation',
    group: 'primary',
    order: 30,
    href: '/realms',
    match: 'prefix',
    label: ({ locale }) => m.realms_heading({}, { locale }),
  },
]);

function NavigationPattern({
  session = 'unknown',
  pathname = '/realms',
}: {
  session?: NavigationSession;
  pathname?: string;
}) {
  return (
    <PatternStory visitor={session === 'signed-in' ? 'Signed In' : 'Signed Out'} path={pathname}>
      <NavigationProvider contributions={contributions}>
        <NavigationLinks
          context={{ locale: getLocale(), pathname }}
          session={session}
          label={m.shell_navigation()}
          className="grid max-w-sm gap-1 p-4"
        />
      </NavigationProvider>
    </PatternStory>
  );
}

async function publicLeaf({ canvasElement }: { canvasElement: HTMLElement }) {
  const link = await within(canvasElement).findByRole('link', { name: m.realms_heading() });
  await expect(link).toHaveAttribute('href', `/${getLocale()}/realms`);
  await expect(link).toHaveAttribute('aria-current', 'page');
}
export const StaticPublicLeaf: Story = { render: () => <NavigationPattern />, play: publicLeaf };
export const PrivatePending: Story = {
  render: () => <NavigationPattern pathname="/library/collections" />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('link', { name: m.library_collection_new() })).toBeNull();
  },
};
export const CreationOffered: Story = {
  render: () => <NavigationPattern session="signed-in" pathname="/library/collections" />,
  play: async ({ canvasElement }) => {
    const link = await within(canvasElement).findByRole('link', { name: m.library_collection_new() });
    await expect(link).toHaveAttribute('href', `/${getLocale()}/collections/new`);
  },
};
export const CreationGated: Story = {
  parameters: { admitted: [] },
  render: () => <NavigationPattern session="signed-in" pathname="/library/collections" />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('link', { name: m.library_collection_new() })).toBeNull();
  },
};
export const LocaleAndPath: Story = {
  globals: { locale: 'ja' },
  render: () => <NavigationPattern pathname="/ja/realms/example" />,
  play: publicLeaf,
};
