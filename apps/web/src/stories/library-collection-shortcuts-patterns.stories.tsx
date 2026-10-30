import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { LibraryNavigation } from '../library/library-nav';
import type { LibraryPinsRead } from '../library/pins-read';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = { title: 'Patterns/Library/Collection destinations', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Shortcuts({ count }: { count: number }) {
  const pins: LibraryPinsRead = {
    state: 'loaded',
    revision: 1,
    next: count > 8 ? 'next-page' : null,
    pins: Array.from({ length: Math.min(count, 8) }, (_, index) => {
      const id = `story-pin-${index + 1}`;
      return {
        collectionId: id,
        target: { id, title: `Reading list ${index + 1}`, membershipKind: 'curated' as const },
      };
    }),
  };
  return (
    <PatternStory>
      <LibraryNavigation current="tracked" pins={pins} collections={[]} locale="en" />
    </PatternStory>
  );
}

async function checkShortcuts(canvasElement: HTMLElement, count: number) {
  const canvas = within(canvasElement);
  const phone = canvasElement.ownerDocument.defaultView?.matchMedia('(max-width: 1023px)').matches ?? false;
  if (phone) {
    const navigation = canvasElement.querySelector('[data-library-navigation-phone]');
    if (!navigation) throw new Error('Missing phone Collection navigation.');
    await userEvent.click(canvas.getByRole('button', { name: m.library_nav_selector() }));
    const sheet = document.querySelector('[data-slot="drawer-content"]');
    await expect(sheet).toBeVisible();
    const links = within(sheet as HTMLElement).getAllByRole('link', { name: /Reading list/ });
    await expect(links).toHaveLength(Math.min(count, 8));
    if (count) await expect(links[0]).toHaveAttribute('href', '/en/collections/story-pin-1');
    await expect(within(navigation as HTMLElement).getAllByRole('link', { name: /Reading list/ })).toHaveLength(
      Math.min(count, 3),
    );
  } else {
    const navigation = canvasElement.querySelector('[data-library-navigation-desktop]');
    await expect(navigation).toBeVisible();
    const links = within(navigation as HTMLElement).getAllByRole('link', { name: /Reading list/ });
    await expect(links).toHaveLength(Math.min(count, 8));
    if (count) await expect(links[0]).toHaveAttribute('href', '/en/collections/story-pin-1');
    await expect(
      within(navigation as HTMLElement).getAllByRole('link', { name: m.library_nav_all_collections() }),
    ).toHaveLength(1);
  }
}

export const None: Story = {
  render: () => <Shortcuts count={0} />,
  play: async ({ canvasElement }) => {
    const phone = canvasElement.ownerDocument.defaultView?.matchMedia('(max-width: 1023px)').matches ?? false;
    await checkShortcuts(canvasElement, 0);
    if (phone) {
      const sheet = document.querySelector('[data-slot="drawer-content"]');
      await expect(
        within(sheet as HTMLElement).getByRole('link', { name: m.library_nav_tracked_entries() }),
      ).toBeVisible();
    } else {
      await expect(within(canvasElement).getByRole('link', { name: m.library_nav_tracked_entries() })).toBeVisible();
    }
  },
};

export const Some: Story = {
  render: () => <Shortcuts count={3} />,
  play: async ({ canvasElement }) => {
    await checkShortcuts(canvasElement, 3);
  },
};

export const Many: Story = {
  render: () => <Shortcuts count={9} />,
  play: async ({ canvasElement }) => {
    await checkShortcuts(canvasElement, 9);
  },
};
