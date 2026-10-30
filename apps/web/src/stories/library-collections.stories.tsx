import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { completePendingCollectionCreate, setCollectionStoryMode } from '../kernel/fake/collection-page-stories';
import { setLibraryNavigationStoryState } from '../kernel/fake/library-pins';
import { m } from '../paraglide/messages.js';
import { PageStory, pagePaths, pageReady } from './page';

const meta = { title: 'Pages/Library/Collections', parameters: { layout: 'fullscreen' } } satisfies Meta;
const phone390 = {
  phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' as const },
};
export default meta;
type Story = StoryObj<typeof meta>;

function render(
  mode: Parameters<typeof setCollectionStoryMode>[0],
  path: string = pagePaths['library-collections'],
  pins: Parameters<typeof setLibraryNavigationStoryState>[0] = { pinCount: 0, builtins: 'none', collectionCount: 0 },
) {
  setCollectionStoryMode(mode);
  setLibraryNavigationStoryState(pins);
  return <PageStory visitor="Signed In" path={path} />;
}

async function collectionsReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  await within(within(context.canvasElement).getByRole('main')).findByRole('heading', {
    level: 1,
    name: m.library_collections_heading(),
  });
}

async function selectResponsiveMenuAction(label: string) {
  const sheet = document.querySelector('[data-slot="drawer-content"]');
  if (sheet) await userEvent.click(within(sheet as HTMLElement).getByRole('button', { name: label }));
  else await userEvent.click(within(document.body).getByRole('menuitem', { name: label }));
}

function collectionCard(main: HTMLElement, title: string): HTMLElement {
  const card = [...main.querySelectorAll<HTMLElement>('[data-slot="cover-card"]')].find((element) =>
    element.textContent?.includes(title),
  );
  if (!card) throw new globalThis.Error(`Missing Collection card: ${title}`);
  return card;
}

export const NoCollections: Story = {
  name: 'None',
  render: () => render('none'),
  play: async (context) => {
    await collectionsReady(context);
    await expect(within(context.canvasElement).getByText(m.library_collections_empty())).toBeVisible();
  },
};

export const OneCollection: Story = {
  name: 'One collection',
  render: () => render('one'),
  play: async (context) => {
    await collectionsReady(context);
    await expect(within(context.canvasElement).getByText('To read this winter')).toBeVisible();
  },
};

export const ManyCollections: Story = {
  name: 'Many collections',
  render: () => render('many'),
  play: async (context) => {
    await collectionsReady(context);
    await expect(within(context.canvasElement).getByText('Books I come back to')).toBeVisible();
    await expect(within(context.canvasElement).getByText('To read this winter')).toBeVisible();
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
    await expect(within(context.canvasElement).getByRole('heading', { name: m.error_heading() })).toBeVisible();
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
    await expect(within(context.canvasElement).getByRole('heading', { name: m.error_heading() })).toBeVisible();
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
    await expect(
      within(context.canvasElement).getByText(m.library_pin_pinned_section(), { exact: true }),
    ).toBeVisible();
  },
};

export const LibraryNinePins: Story = {
  render: () =>
    render('one', pagePaths['library-entries'], { pinCount: 9, builtins: 'everything', collectionCount: 1 }),
  play: async (context) => {
    await pageReady(context);
    const navigation = context.canvasElement.querySelector('[data-library-navigation-desktop]');
    await expect(navigation).toBeTruthy();
    await expect(within(navigation as HTMLElement).getAllByRole('link', { name: /Pinned collection/ })).toHaveLength(8);
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
    await expect(within(context.canvasElement).getByText(m.library_pin_unavailable(), { exact: true })).toBeVisible();
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
    const navigation = context.canvasElement.querySelector('[data-library-navigation-desktop]');
    await expect(navigation).toBeTruthy();
    await expect(within(navigation as HTMLElement).getAllByRole('link', { name: /Pinned collection/ })).toHaveLength(8);
    await expect(
      within(navigation as HTMLElement).getAllByRole('link', { name: m.library_nav_all_collections() }),
    ).toHaveLength(1);
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
    const title = within(main).getByText(m.library_pin_unavailable(), { exact: true });
    await expect(title).toBeVisible();
    const row = title.closest('li');
    if (!row) throw new globalThis.Error('The unavailable pin has no list row.');
    expect(within(row).queryByRole('link')).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: m.library_pin_actions() }));
    await selectResponsiveMenuAction(m.library_pin_unpin());
    await expect(within(main).queryByRole('heading', { name: m.library_pin_pinned_section() })).toBeNull();
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
  parameters: { viewport: { viewports: phone390, defaultViewport: 'phone390' } },
  render: () => render('one', pagePaths['library-collections'], { pinCount: 0, builtins: 'none', collectionCount: 1 }),
  play: async (context) => {
    await collectionsReady(context);
    const main = within(context.canvasElement).getByRole('main');
    const card = collectionCard(main, 'To read this winter');
    await userEvent.click(within(card).getByRole('button', { name: m.library_pin_actions() }));
    await selectResponsiveMenuAction(m.library_pin_pin());
    await expect(within(main).getByRole('heading', { name: m.library_pin_pinned_section() })).toBeVisible();
    const pin = within(main).getByText('Pinned collection 1').closest('li');
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
    await expect(rows()[0]!).toHaveTextContent('Pinned collection 1');
    await userEvent.click(within(rows()[1]!).getByRole('button', { name: m.library_pin_actions() }));
    await selectResponsiveMenuAction(m.library_pin_move_up());
    await expect(rows()[0]!).toHaveTextContent('Pinned collection 2');
    await userEvent.click(within(rows()[0]!).getByRole('button', { name: m.library_pin_actions() }));
    await selectResponsiveMenuAction(m.library_pin_move_down());
    await expect(rows()[1]!).toHaveTextContent('Pinned collection 2');
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
  parameters: { viewport: { viewports: phone390, defaultViewport: 'phone390' } },
  render: () =>
    render('many', pagePaths['library-entries'], { pinCount: 3, builtins: 'everything-liked', collectionCount: 3 }),
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.library_nav_selector() }));
    const sheet = context.canvasElement.querySelector('[data-slot="drawer-content"]');
    await expect(sheet).toBeVisible();
    await expect(
      within(sheet as HTMLElement).getByRole('link', { name: m.library_dynamic_everything() }),
    ).toBeVisible();
    await expect(within(sheet as HTMLElement).getByRole('link', { name: m.library_dynamic_liked() })).toBeVisible();
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
