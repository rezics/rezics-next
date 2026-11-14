import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { LibraryNavigation } from '../library/library-nav';
import type { LibraryPinsRead } from '../library/pins-read';
import { PatternStory } from './page';
import collectionRecording from '../kernel/recorded/library-collection.json';

const meta = {
  title: 'Library/Navigation',
  id: 'patterns-library-navigation',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const destinations = [
  { id: 'story-everything', membershipKind: 'dynamic' as const, builtinKind: 'everything', title: null },
  { id: 'story-liked', membershipKind: 'dynamic' as const, builtinKind: 'liked', title: null },
];
const prefix = 'Collected journeys through the illustrated archive — annotated international reading edition — ';
const unbrokenTitle = 'UnbrokenCollectionTitle'.repeat(16);
const selectedCollection = { ...collectionRecording.collection, title: `${prefix}Volume nine: ${collectionRecording.collection.title}` };
const pins: Extract<LibraryPinsRead, { state: 'loaded' }> = {
  state: 'loaded',
  revision: 4,
  next: null,
  pins: [
    ...Array.from({ length: 8 }, (_, index) => ({
      collectionId: `story-pinned-${index + 1}`,
      target: index === 5 ? null : {
        id: `story-pinned-${index + 1}`,
        title: index === 2 ? unbrokenTitle : `${prefix}Volume ${index + 1}`,
        membershipKind: 'curated' as const,
      },
    })),
    { collectionId: selectedCollection.id, target: selectedCollection },
  ],
};

export const SelectorOpen: Story = {
  render: () => (
    <PatternStory>
      <LibraryNavigation current="tracked" pins={pins} collections={destinations} />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', {
      name: `${m.library_nav_tracked_entries()} ${m.library_nav_selector()}`,
    }));
    const surface = await within(document.body).findByRole('dialog', { name: m.library_nav_selector() });
    const menu = within(surface);
    for (const pin of pins.pins) {
      if (!pin.target) continue;
      const link = menu.getByRole('link', { name: pin.target.title! });
      link.scrollIntoView({ block: 'nearest' });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', `/${getLocale()}/collections/${encodeURIComponent(pin.collectionId)}`);
      await expect(menu.getByText(pin.target.title!, { exact: true, selector: 'span:not(.sr-only)' })).toBeVisible();
    }
    for (const label of [m.library_dynamic_everything(), m.library_dynamic_liked(), m.library_nav_all_collections()]) {
      const link = menu.getByRole('link', { name: label });
      link.scrollIntoView({ block: 'nearest' });
      await expect(link).toBeVisible();
    }
    const unavailable = surface.querySelector('[data-library-destination="story-pinned-6"]')!;
    await expect(unavailable).toHaveTextContent(m.library_pin_unavailable());
    await expect(unavailable.querySelector('a, button, [tabindex]')).toBeNull();
    await expect(menu.getByRole('link', { name: m.library_nav_tracked_entries() })).toHaveAttribute('aria-current', 'page');
    await expect(canvasElement.querySelector('[data-library-navigation-phone]')?.querySelectorAll('[data-library-pin]')).toHaveLength(3);
    await expect(canvasElement.querySelector('[data-library-navigation-desktop]')?.querySelectorAll('[data-library-pin]')).toHaveLength(8);
  },
};

export const SelectedCollectionSelector: Story = {
  name: 'Current ninth pin, complete title and keyboard focus',
  render: () => (
    <PatternStory>
      <LibraryNavigation current={{ collectionId: selectedCollection.id }} pins={pins} collections={destinations} />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const selector = within(canvasElement).getByRole('button', {
      name: `${selectedCollection.title} ${m.library_nav_selector()}`,
    });
    await expect(selector).toBeVisible();
    await expect(selector).toHaveTextContent(selectedCollection.title);
    selector.focus();
    await userEvent.keyboard('{Enter}');
    const surface = await within(document.body).findByRole('dialog', { name: m.library_nav_selector() });
    const destination = within(surface).getByRole('link', { name: selectedCollection.title });
    destination.scrollIntoView({ block: 'nearest' });
    await expect(destination).toBeVisible();
    await expect(destination).toHaveAttribute('href', `/${getLocale()}/collections/${encodeURIComponent(selectedCollection.id)}`);
    await expect(destination).toHaveAttribute('aria-current', 'page');
    await expect(destination.closest('[data-library-destination]')?.querySelector('svg')).toBeVisible();
    destination.focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(selector).toHaveFocus());
    await expect(selector).toHaveAccessibleName(`${selectedCollection.title} ${m.library_nav_selector()}`);
    await expect(within(document.body).queryByRole('dialog', { name: m.library_nav_selector() })).toBeNull();
  },
};

export const UnavailableCurrentDestination: Story = {
  render: () => (
    <PatternStory>
      <LibraryNavigation current={{ collectionId: 'story-pinned-6' }} pins={pins} collections={destinations} />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const selector = within(canvasElement).getByRole('button', {
      name: `${m.library_pin_unavailable()} ${m.library_nav_selector()}`,
    });
    await userEvent.click(selector);
    const surface = await within(document.body).findByRole('dialog', { name: m.library_nav_selector() });
    const row = surface.querySelector('[data-library-destination="story-pinned-6"]')!;
    row.scrollIntoView({ block: 'nearest' });
    await expect(within(row as HTMLElement).getByText(m.library_pin_unavailable(), { exact: true })).toBeVisible();
    await expect(within(row as HTMLElement).getByText('story-pinned-6', { exact: true })).toBeVisible();
    await expect(row).toHaveAttribute('aria-current', 'page');
    await expect(row.querySelector('svg')).toBeVisible();
    await expect(row.querySelector('a, button, [tabindex]')).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(selector).toHaveFocus());
  },
};

export const DestinationReadStates: Story = {
  name: 'Empty, preparing and unavailable destination reads',
  render: () => (
    <PatternStory>
      <section aria-label="Empty pins">
        <LibraryNavigation current="tracked" pins={{ state: 'loaded', revision: 0, next: null, pins: [] }} collections={[]} />
      </section>
      <section aria-label="Preparing destinations">
        <LibraryNavigation current="tracked" pins={{ state: 'preparing' }} collections={[]} collectionsState="preparing" />
      </section>
      <section aria-label="Unavailable destinations">
        <LibraryNavigation current="tracked" pins={{ state: 'unavailable' }} collections={[]} collectionsState="denied" />
      </section>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(within(canvas.getByRole('region', { name: 'Empty pins' })).queryByRole('status')).toBeNull();
    await expect(within(canvas.getByRole('region', { name: 'Preparing destinations' })).getByRole('status'))
      .toHaveTextContent(m.library_navigation_loading());
    const unavailable = within(canvas.getByRole('region', { name: 'Unavailable destinations' }));
    await expect(unavailable.getByRole('status')).toHaveTextContent(m.library_pin_read_failed());
    await userEvent.click(unavailable.getByRole('button', {
      name: `${m.library_nav_tracked_entries()} ${m.library_nav_selector()}`,
    }));
    const surface = await within(document.body).findByRole('dialog', { name: m.library_nav_selector() });
    await expect(within(surface).getByRole('status')).toHaveTextContent(m.library_pin_read_failed());
    await expect(within(surface).getByRole('link', { name: m.library_nav_all_collections() }))
      .toHaveAttribute('href', `/${getLocale()}/library/collections`);
  },
};
