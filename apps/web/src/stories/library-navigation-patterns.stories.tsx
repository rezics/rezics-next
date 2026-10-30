import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { LibraryNavigation } from '../library/library-nav';
import { PatternStory } from './page';

const meta = { title: 'Patterns/Library/Navigation', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const destinations = [
  {
    id: 'story-everything',
    membershipKind: 'dynamic' as const,
    builtinKind: 'everything',
    title: null,
  },
  {
    id: 'story-liked',
    membershipKind: 'dynamic' as const,
    builtinKind: 'liked',
    title: null,
  },
];

const pins = {
  state: 'loaded' as const,
  revision: 4,
  next: null,
  pins: [
    {
      collectionId: 'story-pinned-1',
      target: { id: 'story-pinned-1', title: 'Pinned collection one', membershipKind: 'curated' as const },
    },
    {
      collectionId: 'story-pinned-2',
      target: { id: 'story-pinned-2', title: 'Pinned collection two', membershipKind: 'curated' as const },
    },
    {
      collectionId: 'story-pinned-3',
      target: { id: 'story-pinned-3', title: 'Pinned collection three', membershipKind: 'curated' as const },
    },
  ],
};

export const PhoneSelectorOpen: Story = {
  name: 'Phone selector open',
  parameters: {
    viewport: {
      viewports: { phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } } },
      defaultViewport: 'phone390',
    },
  },
  render: () => (
    <PatternStory>
      <LibraryNavigation current="tracked" pins={pins} collections={destinations} />
    </PatternStory>
  ),
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.library_nav_selector() }));
    const sheet = document.querySelector('[data-slot="drawer-content"]');
    await expect(sheet).toBeVisible();
    const menu = within(sheet as HTMLElement);
    await expect(menu.getByRole('link', { name: m.library_dynamic_everything() })).toBeVisible();
    await expect(menu.getByRole('link', { name: m.library_dynamic_liked() })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Pinned collection one' })).toBeVisible();
    await expect(menu.getByRole('link', { name: m.library_nav_all_collections() })).toBeVisible();
    await expect(
      within(context.canvasElement.querySelector('[data-library-navigation-phone]') as HTMLElement).getAllByRole(
        'link',
        {
          name: /Pinned collection/,
        },
      ),
    ).toHaveLength(3);
  },
};
