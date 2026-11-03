import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQuery } from '@tanstack/react-query';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { completePendingCollectionCreate, setCollectionStoryMode } from '../kernel/fake/collection-page-stories';
import { setLibraryNavigationStoryState } from '../kernel/fake/library-pins';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, PatternStory, libraryHeadingReady, pagePaths, pageReady } from './page';
import { MineCollectionsPageView } from '../library/mine-collections-page';
import { readMineCollectionsPage } from '../library/mine-collections-route';
import { readLibraryPinsPage } from '../library/pins-read';
import collectionRecording from '../kernel/recorded/library-collection.json';
import collectionsRecording from '../kernel/recorded/library-collections.json';

const meta = { title: 'Pages/Library/Collections', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function render(
  mode: Parameters<typeof setCollectionStoryMode>[0],
  path: string = pagePaths['library-collections'],
  pins: Parameters<typeof setLibraryNavigationStoryState>[0] = {
    pinCount: 0,
    builtins: 'none',
    collectionCount: mode === 'none' ? 0 : mode === 'one' ? 1 : 3,
  },
) {
  setCollectionStoryMode(mode);
  setLibraryNavigationStoryState(pins);
  return <PageStory visitor="Signed In" path={path} credentialMode="session" />;
}

async function collectionsReady(context: { canvasElement: HTMLElement }) {
  await libraryHeadingReady(context, m.library_collections_heading);
  await openPinManager(context.canvasElement);
}

async function openPinManager(canvasElement: HTMLElement) {
  const manager = canvasElement.querySelector<HTMLDetailsElement>('[data-library-pin-manager]');
  if (manager && !manager.open) await userEvent.click(manager.querySelector('summary')!);
}

async function selectResponsiveMenuAction(label: string) {
  const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
  const menu = await within(document.body).findByRole(
    sheet ? 'dialog' : 'menu',
    sheet ? { name: m.library_pin_actions() } : undefined,
  );
  await userEvent.click(await within(menu).findByRole(sheet ? 'button' : 'menuitem', { name: label }));
}

function collectionCard(main: HTMLElement, title: string, preview = false): HTMLElement {
  const heading = within(main).getByRole('heading', { level: 2, name: title });
  const card = heading.closest<HTMLElement>(preview ? '[data-collection-preview]' : '[data-collection-row]');
  if (!card) throw new globalThis.Error(`Missing Collection row: ${title}`);
  return card;
}

export const NoCollections: Story = {
  name: 'None',
  render: () => render('none'),
  play: async (context) => {
    await collectionsReady(context);
    await expect(within(context.canvasElement).getByText(m.library_collections_empty())).toBeVisible();
    await expect(await within(context.canvasElement).findByText(m.library_collections_start())).toBeVisible();
    await expect(
      await within(context.canvasElement).findByRole('link', { name: m.library_collection_new() }),
    ).toHaveAttribute('href', `/${getLocale()}/collections/new`);
  },
};

export const OneCollection: Story = {
  name: 'One collection',
  render: () => render('one'),
  play: async (context) => {
    await collectionsReady(context);
    const main = within(context.canvasElement).getByRole('main');
    await expect(within(collectionCard(main, 'To read this winter')).getByRole('heading', { level: 2 })).toBeVisible();
  },
};

export const ManyCollections: Story = {
  name: 'Many collections',
  render: () => render('many'),
  play: async (context) => {
    await collectionsReady(context);
    const main = within(context.canvasElement).getByRole('main');
    await expect(within(collectionCard(main, 'Books I come back to')).getByRole('heading', { level: 2 })).toBeVisible();
    await expect(within(collectionCard(main, 'To read this winter')).getByRole('heading', { level: 2 })).toBeVisible();
  },
};

export const PreviewMembers: Story = {
  render: () =>
    render('many', `${pagePaths['library-collections']}?layout=previews`, {
      pinCount: 1,
      builtins: 'none',
      collectionCount: 2,
      previews: 'recorded',
    }),
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByRole('link', { name: 'Snow Country' });
    const main = canvas.getByRole('main');
    const preview = collectionCard(main, collectionRecording.collection.title, true);
    expect(preview.querySelectorAll('[data-slot="cover-card"]')).toHaveLength(3);
    expect(within(preview).queryByRole('link', { name: 'Kokoro' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.library_layout_list() }));
    await waitFor(async () =>
      expect(
        await within(collectionCard(main, collectionRecording.collection.title)).findByRole('link', {
          name: m.library_collection_open(),
        }),
      ).toBeVisible(),
    );
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_previews() }));
    await expect(await canvas.findByRole('link', { name: 'Snow Country' })).toBeVisible();
  },
};

export const PreviewPending: Story = {
  render: () =>
    render('many', `${pagePaths['library-collections']}?layout=previews`, {
      pinCount: 0,
      builtins: 'none',
      collectionCount: 2,
      previews: 'pending',
    }),
  play: async (context) => {
    await pageReady(context);
    const heading = await within(context.canvasElement).findByRole('heading', {
      level: 2,
      name: collectionRecording.collection.title,
    });
    const preview = heading.closest<HTMLElement>('[data-collection-preview]')!;
    await expect(preview.querySelector('[data-preview-state="preparing"]')).toHaveTextContent(
      m.library_collection_preview_preparing(),
    );
    expect(preview.querySelector('[data-slot="cover-card"]')).toBeNull();
    expect(within(preview).queryByText(m.library_collection_empty())).toBeNull();
  },
};

export const PreviewUnavailable: Story = {
  render: () =>
    render('many', `${pagePaths['library-collections']}?layout=previews`, {
      pinCount: 0,
      builtins: 'none',
      collectionCount: 2,
      previews: 'unavailable',
    }),
  play: async (context) => {
    await pageReady(context);
    const heading = await within(context.canvasElement).findByRole('heading', {
      level: 2,
      name: collectionRecording.collection.title,
    });
    const preview = heading.closest<HTMLElement>('[data-collection-preview]')!;
    await expect(preview.querySelector('[data-preview-state="unavailable"]')).toHaveTextContent(
      m.library_collection_preview_unavailable(),
    );
    expect(within(preview).queryByText(m.library_collection_empty())).toBeNull();
  },
};

const longTitles = [
  'Books to read through the long winter evenings and return to with friends',
  'Places, films and stories to explore together on our next journey',
] as const;

export const LongCollectionTitles: Story = {
  render: () =>
    render('many', pagePaths['library-collections'], {
      pinCount: 1,
      builtins: 'everything-liked',
      collectionCount: 2,
      collectionTitles: longTitles,
    }),
  play: async (context) => {
    await collectionsReady(context);
    const canvas = within(context.canvasElement);
    const title = window.matchMedia('(min-width: 1024px)').matches ? m.library_more() : m.library_nav_all_collections();
    await userEvent.click(canvas.getByRole('button', { name: `${title} ${m.library_nav_selector()}` }));
    const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
    const menu = await within(document.body).findByRole(sheet ? 'dialog' : 'menu');
    await waitFor(() =>
      expect(within(menu).getByRole(sheet ? 'link' : 'menuitem', { name: longTitles[1] })).toBeVisible(),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(within(document.body).queryByRole(sheet ? 'dialog' : 'menu')).toBeNull());
  },
};

export const Unavailable: Story = {
  render: () =>
    render('many', pagePaths['library-collections'], {
      pinCount: 0,
      builtins: 'none',
      collectionCount: 3,
      collectionsUnavailable: true,
    }),
  play: async (context) => {
    await pageReady(context);
    await expect(
      await within(context.canvasElement).findByRole('heading', { level: 1, name: m.library_collections_heading() }),
    ).toBeVisible();
    await expect(
      await within(context.canvasElement).findAllByText(m.library_collections_unavailable(), { exact: true }),
    ).toHaveLength(1);
  },
};

export const Error: Story = {
  render: () =>
    render('many', pagePaths['library-collections'], {
      pinCount: 0,
      builtins: 'none',
      collectionCount: 3,
      collectionsError: true,
    }),
  play: async (context) => {
    await pageReady(context);
    await expect(
      await within(context.canvasElement).findByRole('heading', { level: 1, name: m.library_collections_heading() }),
    ).toBeVisible();
    await expect(await within(context.canvasElement).findByRole('alert')).toHaveTextContent(
      m.library_collections_read_failed(),
    );
  },
};

export const PinsUnavailable: Story = {
  render: () =>
    render('many', pagePaths['library-collections'], {
      pinCount: 3,
      failPins: true,
      builtins: 'none',
      collectionCount: 3,
    }),
  play: async (context) => {
    await collectionsReady(context);
    const main = within(context.canvasElement).getByRole('main');
    await expect(within(main).getByText(m.library_pin_read_failed(), { exact: true })).toBeVisible();
    expect(within(main).getAllByText(m.library_pin_read_failed(), { exact: true })).toHaveLength(1);
    await expect(within(main).queryByRole('heading', { name: m.library_pin_pinned_section() })).toBeNull();
    await expect(within(main).queryByRole('button', { name: m.library_pin_actions() })).toBeNull();
  },
};

export const LibraryNoPins: Story = {
  render: () => render('one', pagePaths['library-entries'], { pinCount: 0, builtins: 'none', collectionCount: 1 }),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).queryByText(m.library_pin_pinned_section(), { exact: true })).toBeNull();
  },
};

export const LibraryThreePins: Story = {
  render: () =>
    render('one', pagePaths['library-entries'], { pinCount: 3, builtins: 'everything', collectionCount: 1 }),
  play: async (context) => {
    await pageReady(context);
    const navigation = context.canvasElement.querySelector('[data-library-navigation-phone]');
    if (!navigation) throw new globalThis.Error('Missing Library navigation');
    await expect(navigation.querySelectorAll('a[data-library-pin]')).toHaveLength(3);
  },
};

export const LibraryNinePins: Story = {
  render: () =>
    render('one', pagePaths['library-entries'], { pinCount: 9, builtins: 'everything', collectionCount: 1 }),
  play: async (context) => {
    await pageReady(context);
    const navigation = context.canvasElement.querySelector('[data-library-navigation-desktop]');
    await expect(navigation).toBeTruthy();
    await expect(navigation?.querySelectorAll('a[data-library-pin]')).toHaveLength(8);
    await expect(
      within(navigation as HTMLElement).getAllByRole('link', { name: m.library_nav_all_collections() }),
    ).toHaveLength(1);
  },
};

export const LibraryUnavailablePin: Story = {
  render: () =>
    render('one', pagePaths['library-entries'], {
      pinCount: 3,
      unavailableTarget: true,
      builtins: 'none',
      collectionCount: 1,
    }),
  play: async (context) => {
    await pageReady(context);
    const navigation = context.canvasElement.querySelector('[data-library-navigation]');
    if (!navigation) throw new globalThis.Error('Missing Library navigation');
    await expect(navigation.querySelector('span[data-library-pin]')).toHaveTextContent(m.library_pin_unavailable());
  },
};

export const CollectionsThreePins: Story = {
  render: () =>
    render('many', pagePaths['library-collections'], { pinCount: 3, builtins: 'everything-liked', collectionCount: 3 }),
  play: async (context) => {
    await collectionsReady(context);
    await expect(
      within(context.canvasElement).getByRole('heading', { name: m.library_pin_pinned_section() }),
    ).toBeVisible();
  },
};

export const CollectionsNinePins: Story = {
  render: () =>
    render('many', pagePaths['library-collections'], { pinCount: 9, builtins: 'everything-liked', collectionCount: 9 }),
  play: async (context) => {
    await collectionsReady(context);
    const manager = context.canvasElement.querySelector<HTMLElement>('[data-library-pin-manager]');
    if (!manager) throw new globalThis.Error('Missing pin manager');
    await expect(manager).toBeVisible();
    const rows = within(manager).getAllByRole('listitem');
    expect(rows).toHaveLength(9);
    await expect(within(rows[8]!).getByRole('link', { name: 'Reading list 9' })).toBeVisible();
    await expect(within(rows[8]!).getByRole('button', { name: m.library_pin_actions() })).toBeEnabled();

    const navigation = context.canvasElement.querySelector<HTMLElement>('[data-library-navigation-desktop]');
    await expect(navigation).toBeTruthy();
    await expect(navigation?.querySelectorAll('a[data-library-pin]')).toHaveLength(8);
    if (!navigation) throw new globalThis.Error('Missing Library navigation');
    if (window.getComputedStyle(navigation).display !== 'none') {
      const links = within(navigation).getAllByRole('link', { name: m.library_nav_all_collections() });
      await expect(links).toHaveLength(1);
      await expect(links[0]!).toBeVisible();
      return;
    }

    // The phone destination is in the visible Collection selector, opened explicitly by the reader.
    const phone = context.canvasElement.querySelector<HTMLElement>('[data-library-navigation-phone]');
    if (!phone) throw new globalThis.Error('Missing phone Library navigation');
    await expect(phone).toBeVisible();
    expect(phone.querySelectorAll('a[data-library-pin]')).toHaveLength(3);
    const selector = within(phone).getByRole('button', {
      name: `${m.library_nav_all_collections()} ${m.library_nav_selector()}`,
    });
    await expect(selector).toBeVisible();
    await expect(selector).toHaveTextContent(m.library_nav_all_collections());
    await userEvent.click(selector);

    const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
    const menu = sheet
      ? await within(document.body).findByRole('dialog', { name: m.library_nav_selector() })
      : await within(document.body).findByRole('menu');
    const destination = within(menu).getByRole(sheet ? 'link' : 'menuitem', {
      name: m.library_nav_all_collections(),
    });
    destination.scrollIntoView({ block: 'nearest' });
    await expect(destination).toBeVisible();
    await expect(destination).toHaveAttribute('href', `/${getLocale()}${pagePaths['library-collections']}`);
    await expect(destination).toHaveAttribute('aria-current', 'page');
  },
};

export const CollectionsUnavailablePin: Story = {
  render: () =>
    render('many', pagePaths['library-collections'], {
      pinCount: 1,
      unavailableTarget: true,
      builtins: 'everything-liked',
      collectionCount: 3,
    }),
  play: async (context) => {
    await collectionsReady(context);
    const main = within(context.canvasElement).getByRole('main');
    const manager = main.querySelector<HTMLElement>('[data-library-pin-manager]');
    if (!manager) throw new globalThis.Error('Missing pin manager');
    const title = within(manager).getByText(m.library_pin_unavailable(), { exact: true });
    await expect(title).toBeVisible();
    const row = title.closest('li');
    if (!row) throw new globalThis.Error('The unavailable pin has no list row.');
    expect(within(row).queryByRole('link')).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: m.library_pin_actions() }));
    await selectResponsiveMenuAction(m.library_pin_unpin());
    await waitFor(() =>
      expect(within(main).queryByRole('heading', { name: m.library_pin_pinned_section() })).toBeNull(),
    );
  },
};

export const CollectionsNoPins: Story = {
  render: () => render('many', pagePaths['library-collections'], { pinCount: 0, builtins: 'none', collectionCount: 3 }),
  play: async (context) => {
    await collectionsReady(context);
    await expect(
      within(context.canvasElement).queryByRole('heading', { name: m.library_pin_pinned_section() }),
    ).toBeNull();
  },
};

export const PinAndUnpin: Story = {
  render: () => render('one', pagePaths['library-collections'], { pinCount: 0, builtins: 'none', collectionCount: 1 }),
  play: async (context) => {
    await collectionsReady(context);
    const main = within(context.canvasElement).getByRole('main');
    const card = collectionCard(main, 'To read this winter');
    await userEvent.click(within(card).getByRole('button', { name: m.library_pin_actions() }));
    await selectResponsiveMenuAction(m.library_pin_pin());
    await openPinManager(context.canvasElement);
    await expect(within(main).getByRole('heading', { name: m.library_pin_pinned_section() })).toBeVisible();
    const manager = main.querySelector<HTMLElement>('[data-library-pin-manager]');
    if (!manager) throw new globalThis.Error('Missing pin manager');
    const pin = within(manager).getByText('To read this winter').closest('li');
    if (!pin) throw new globalThis.Error('The pinned Collection has no list row.');
    await userEvent.click(within(pin).getByRole('button', { name: m.library_pin_actions() }));
    await selectResponsiveMenuAction(m.library_pin_unpin());
    await expect(within(main).queryByRole('heading', { name: m.library_pin_pinned_section() })).toBeNull();
  },
};

export const MovePinnedCollection: Story = {
  render: () => render('many', pagePaths['library-collections'], { pinCount: 3, builtins: 'none', collectionCount: 3 }),
  play: async (context) => {
    await collectionsReady(context);
    const main = within(context.canvasElement).getByRole('main');
    const section = main.querySelector('#library-pinned-heading')?.closest('section');
    if (!section) throw new globalThis.Error('Missing pinned Collection section');
    const rows = () => [...section.querySelectorAll<HTMLElement>('li')];
    await expect(rows()[0]!).toHaveTextContent('To read this winter');
    await userEvent.click(within(rows()[1]!).getByRole('button', { name: m.library_pin_actions() }));
    await selectResponsiveMenuAction(m.library_pin_move_up());
    await expect(rows()[0]!).toHaveTextContent('Books I come back to');
    await userEvent.click(within(rows()[0]!).getByRole('button', { name: m.library_pin_actions() }));
    await selectResponsiveMenuAction(m.library_pin_move_down());
    await expect(rows()[1]!).toHaveTextContent('Books I come back to');
  },
};

export const PinConflict: Story = {
  render: () =>
    render('one', pagePaths['library-collections'], {
      pinCount: 0,
      builtins: 'none',
      collectionCount: 1,
      conflict: true,
    }),
  play: async (context) => {
    await collectionsReady(context);
    const main = within(context.canvasElement).getByRole('main');
    const card = collectionCard(main, 'To read this winter');
    await userEvent.click(within(card).getByRole('button', { name: m.library_pin_actions() }));
    await selectResponsiveMenuAction(m.library_pin_pin());
    await expect(within(main).getByRole('status')).toHaveTextContent(m.library_pin_conflict());
    await expect(within(main).queryByRole('heading', { name: m.library_pin_pinned_section() })).toBeNull();
  },
};

export const PinAtCapacity: Story = {
  name: 'Pin at capacity',
  render: () =>
    render('one', pagePaths['library-collections'], { pinCount: 100, builtins: 'none', collectionCount: 1 }),
  play: async (context) => {
    await collectionsReady(context);
    const main = within(context.canvasElement).getByRole('main');
    const card = collectionCard(main, 'To read this winter');
    await userEvent.click(within(card).getByRole('button', { name: m.library_pin_actions() }));
    await selectResponsiveMenuAction(m.library_pin_pin());
    await expect(within(main).getByRole('status')).toHaveTextContent(m.library_pin_limit());
    const section = main.querySelector('#library-pinned-heading')?.closest('section');
    if (!section) throw new globalThis.Error('Missing pinned Collection section');
    await expect([...section.querySelectorAll('li')]).toHaveLength(100);
  },
};

export const PhoneSelectorOpen: Story = {
  render: () =>
    render('many', pagePaths['library-entries'], { pinCount: 1, builtins: 'everything-liked', collectionCount: 2 }),
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const title = window.matchMedia('(min-width: 1024px)').matches ? m.library_more() : m.library_nav_tracked_entries();
    await userEvent.click(await canvas.findByRole('button', { name: `${title} ${m.library_nav_selector()}` }));
    const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
    if (sheet) {
      const menu = await within(document.body).findByRole('dialog', { name: m.library_nav_selector() });
      await expect(within(menu).getByRole('link', { name: m.library_dynamic_everything() })).toBeVisible();
      await expect(within(menu).getByRole('link', { name: m.library_dynamic_liked() })).toBeVisible();
    } else {
      await expect(await within(document.body).findByRole('menuitem', { name: 'Books I come back to' })).toBeVisible();
    }
  },
};

export const CreateValid: Story = {
  name: 'Create valid collection',
  render: () => render('one', '/collections/new'),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await userEvent.type(view.getByRole('textbox', { name: m.library_collection_title() }), 'A small reading list');
    await userEvent.click(view.getByRole('radio', { name: new RegExp(m.library_visibility_public()) }));
    await userEvent.click(view.getByRole('button', { name: m.library_collection_create() }));
    await expect(view.getByRole('heading', { level: 1, name: 'Books I come back to' })).toBeVisible();
  },
};

export const CreateInvalid: Story = {
  name: 'Create invalid collection',
  render: () => render('one', '/collections/new'),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    const submit = view.getByRole('button', { name: m.library_collection_create() });
    await expect(submit).toBeDisabled();
    await userEvent.click(view.getByRole('radio', { name: new RegExp(m.library_visibility_public()) }));
    await userEvent.click(submit);
    await expect(view.getByRole('textbox', { name: m.library_collection_title() })).toBeInvalid();
  },
};

export const CreatePending: Story = {
  name: 'Create pending',
  render: () => render('pending-create', '/collections/new'),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    const title = view.getByRole('textbox', { name: m.library_collection_title() });
    await userEvent.type(title, 'A small reading list');
    await userEvent.click(view.getByRole('radio', { name: new RegExp(m.library_visibility_public()) }));
    const submit = view.getByRole('button', { name: m.library_collection_create() });
    const submitted = userEvent.click(submit);
    await expect(submit).toBeDisabled();
    completePendingCollectionCreate();
    await submitted;
  },
};

export const CreateFailed: Story = {
  name: 'Create failed',
  render: () => render('failed-create', '/collections/new'),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await userEvent.type(view.getByRole('textbox', { name: m.library_collection_title() }), 'A small reading list');
    await userEvent.click(view.getByRole('radio', { name: new RegExp(m.library_visibility_public()) }));
    await userEvent.click(view.getByRole('button', { name: m.library_collection_create() }));
    await expect(view.getByRole('alert')).toBeVisible();
  },
};

export const CollectionsAndPinsUnavailable: Story = {
  render: () =>
    render('many', pagePaths['library-collections'], {
      pinCount: 3,
      builtins: 'none',
      collectionCount: 3,
      collectionsUnavailable: true,
      failPins: true,
    }),
  play: async (context) => {
    await pageReady(context);
    const main = within(within(context.canvasElement).getByRole('main'));
    await expect(main.getAllByText(m.library_collections_unavailable(), { exact: true })).toHaveLength(1);
    await expect(main.getAllByText(m.library_pin_read_failed(), { exact: true })).toHaveLength(1);
    await expect(main.getByRole('link', { name: m.library_collections_retry() })).toBeVisible();
  },
};

export const HealthyPinsCollectionsRecovery: Story = {
  name: 'Healthy pins, retry Collections',
  render: () =>
    render('none', '/library/collections?layout=previews&cursor=requested-page', {
      pinCount: 1,
      builtins: 'none',
      collectionCount: 0,
      collectionsUnavailable: true,
    }),
  play: async (context) => {
    await collectionsReady(context);
    const main = within(within(context.canvasElement).getByRole('main'));
    await expect(main.getAllByText(m.library_collections_unavailable(), { exact: true })).toHaveLength(1);
    await expect(main.queryByText(m.library_pin_read_failed())).toBeNull();
    const retry = main.getByRole('link', { name: m.library_collections_retry() });
    await expect(retry).toHaveAttribute(
      'href',
      `/${getLocale()}/library/collections?layout=previews&cursor=requested-page`,
    );
    const pin = context.canvasElement.querySelector('[data-library-navigation-desktop] a[data-library-pin]');
    await expect(pin).toHaveAttribute('href', `/${getLocale()}/collections/${collectionsRecording.collections[0]!.id}`);
    setLibraryNavigationStoryState({ pinCount: 1, builtins: 'none', collectionCount: 0 });
    await userEvent.click(retry);
    await expect(await main.findByText(m.library_collections_page_empty())).toBeVisible();
    await expect(main.queryByText(m.library_collections_empty())).toBeNull();
    await userEvent.click(main.getByRole('link', { name: m.library_collections_first_page() }));
    await expect(await main.findByText(m.library_collections_empty())).toBeVisible();
    await expect(main.getByRole('link', { name: m.library_collection_new() })).toHaveAttribute(
      'href',
      `/${getLocale()}/collections/new`,
    );
  },
};

// The protected route keeps its sign-in redirect. This region previews the real signed-out adapter result,
// as can occur when the session ends after the route guard has completed.
function SignedOutCollectionsStep() {
  const { data } = useQuery({
    queryKey: ['collections-signed-out-step'],
    queryFn: async () => {
      const [page, pins] = await Promise.all([
        readMineCollectionsPage({ data: { layout: 'previews', cursor: 'requested-page' } }),
        readLibraryPinsPage({ data: 100 }),
      ]);
      return { page, pins };
    },
    retry: false,
  });
  return data ? <MineCollectionsPageView {...data} layout="previews" cursor="requested-page" /> : null;
}

export const SignedOutNextStep: Story = {
  name: 'Signed out, return to requested Collections view',
  render: () => (
    <PatternStory visitor="Signed Out" path="/library/collections?layout=previews&cursor=requested-page">
      <main>
        <SignedOutCollectionsStep />
      </main>
    </PatternStory>
  ),
  play: async (context) => {
    const view = within(context.canvasElement);
    const signIn = await view.findByRole('link', { name: m.account_sign_in() });
    await expect(signIn).toHaveAttribute(
      'href',
      `/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/library/collections?layout=previews&cursor=requested-page`)}`,
    );
    await expect(view.queryByRole('link', { name: m.library_collection_new() })).toBeNull();
    await expect(view.queryByRole('toolbar')).toBeNull();
  },
};
