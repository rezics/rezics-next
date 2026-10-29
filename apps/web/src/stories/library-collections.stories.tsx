import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { completePendingCollectionCreate, setCollectionStoryMode } from '../kernel/fake/collection-page-stories';
import { m } from '../paraglide/messages.js';
import { PageStory, pagePaths, pageReady } from './page';

const meta = { title: 'Pages/Library/Collections', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function render(mode: Parameters<typeof setCollectionStoryMode>[0], path: string = pagePaths['library-collections']) {
  setCollectionStoryMode(mode);
  return <PageStory visitor="Signed In" path={path} />;
}

async function collectionsReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  await within(within(context.canvasElement).getByRole('main')).findByRole('heading', {
    level: 1,
    name: m.library_collections_heading(),
  });
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
