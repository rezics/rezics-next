import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import { m } from '../paraglide/messages.js';
import { StudioWorkbenchReview } from './studio-workbench-review';
import bookMeta from './hosted-book-reader.stories';
import knowledgeMeta, { NestedOutline } from './knowledge-workspace.stories';

const Book = bookMeta.component;
const Knowledge = knowledgeMeta.component;
const meta = {
  title: 'Walks/Navigation/Contextual selection',
  component: StudioWorkbenchReview,
  globals: { viewport: { value: 'phone390' }, visitor: 'Signed In' },
  parameters: { layout: 'fullscreen', viewport: knowledgeMeta.parameters.viewport },
} satisfies Meta<typeof StudioWorkbenchReview>;
export default meta;
type Story = StoryObj<typeof meta>;
const page = () => within(document.body);
const closed = () =>
  waitFor(() => expect(page().queryByRole('dialog', { name: m.shell_navigation() })).not.toBeInTheDocument());
async function open() {
  await userEvent.click(page().getByRole('button', { name: m.shell_open_navigation(), exact: true }));
  return within(await page().findByRole('dialog', { name: m.shell_navigation() }));
}
const studioSelection: Story['play'] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const title = await canvas.findByRole('textbox', { name: m.studio_workspace_title() });
  const before = (title as HTMLInputElement).value;
  const second = args.profile === 'book' ? 'A map drawn from memory' : 'The case for taking the slow ferry';
  const navigation = await open();
  const choice = await navigation.findByRole('button', { name: second, exact: true });
  choice.focus();
  await userEvent.keyboard('{Enter}');
  await closed();
  if (args.scenario === 'dirty') {
    const review = canvas.getByRole('region', { name: m.studio_workspace_switch_region() });
    await expect(review).toBeVisible();
    await waitFor(() => expect(review.contains(document.activeElement)).toBe(true));
    await userEvent.click(within(review).getByRole('button', { name: m.studio_workspace_keep_editing() }));
    await expect(title).toHaveValue(before);
    await waitFor(() => expect(canvasElement.querySelector('.studio-document-heading h2')).toHaveFocus());
  } else {
    await waitFor(() => expect(canvas.getByRole('heading', { name: second, exact: true })).toHaveFocus());
  }
  const selected =
    args.scenario === 'dirty'
      ? args.profile === 'book'
        ? 'The lighthouse before dawn'
        : 'What the harbour keeps'
      : second;
  await userEvent.click((await open()).getByRole('button', { name: selected, exact: true }));
  await closed();
  await waitFor(() => expect(canvasElement.querySelector('.studio-document-heading h2')).toHaveFocus());
};
export const BookStudio: Story = { args: { profile: 'book', scenario: 'populated' }, play: studioSelection };
export const ColumnStudio: Story = { args: { profile: 'column', scenario: 'populated' }, play: studioSelection };
export const BookDirtyReview: Story = { args: { profile: 'book', scenario: 'dirty' }, play: studioSelection };
export const ColumnDirtyReview: Story = { args: { profile: 'column', scenario: 'dirty' }, play: studioSelection };
export const BookChapter: Story = {
  render: () => <Book state="nested" />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('heading', { level: 1 });
    const navigation = await open();
    await userEvent.click(
      await navigation.findByRole('button', { name: `${m.book_reader_contents()} · Part I · The journey` }),
    );
    await userEvent.click(
      await navigation.findByRole('button', { name: `${m.book_reader_contents()} · The observatory` }),
    );
    await expect(page().getByRole('dialog', { name: m.shell_navigation() })).toBeVisible();
    (await navigation.findByRole('link', { name: `${m.book_reader_open_chapter()} · Dawn / 黎明` })).focus();
    await userEvent.keyboard('{Enter}');
    await closed();
    await waitFor(() =>
      expect(within(canvasElement).getByRole('heading', { level: 1, name: 'Dawn / 黎明' })).toHaveFocus(),
    );
  },
};
export const KnowledgePlacement: Story = {
  render: () => <Knowledge scenario="branches" locale="en" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByLabelText(m.knowledge_private_document_title(), { selector: 'input' });
    let navigation = await open();
    await userEvent.click(navigation.getByRole('button', { name: m.knowledge_workspace_navigation_open() }));
    const link = await navigation.findByRole('link', {
      name: `${m.knowledge_navigation_open_document()}: Inspiration: the offered cup`,
    });
    link.focus();
    await userEvent.keyboard('{Enter}');
    await closed();
    await waitFor(() =>
      expect(canvas.getByLabelText(m.knowledge_private_document_title(), { selector: 'input' })).toHaveValue(
        'Inspiration: the offered cup',
      ),
    );
    navigation = await open();
    await userEvent.click(navigation.getByRole('button', { name: m.knowledge_workspace_navigation_open() }));
    await userEvent.click(
      await navigation.findByRole('link', {
        name: `${m.knowledge_navigation_open_document()}: Inspiration: the offered cup`,
      }),
    );
    await closed();
    await waitFor(() => expect(canvasElement.querySelector('#main-content')).toHaveFocus());
  },
};
export const KnowledgeBranchMoreRetryRetention = {
  ...NestedOutline,
  args: { ...knowledgeMeta.args, ...NestedOutline.args },
  render: () => <Knowledge scenario="branches" locale="en" />,
};

function MenuLifecycle() {
  const [mounted, setMounted] = useState(true);
  return (
    <>
      <button onClick={() => setMounted(false)}>Unmount reader</button>
      {mounted && <Book state="nested" />}
    </>
  );
}
const frames = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
export const MenuDismissalFocus: Story = {
  render: () => <MenuLifecycle />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1 });
    const trigger = page().getByRole('button', { name: m.shell_open_navigation(), exact: true });
    await open();
    await frames();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
    await open();
    await frames();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    fireEvent.click(trigger);
    await frames();
    await expect(page().getByRole('dialog', { name: m.shell_navigation() })).toBeVisible();
    await expect(trigger).not.toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
    for (const name of ['Replace publication / target / viewer admission', 'Unmount reader']) {
      await open();
      await frames();
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      const destination = canvas.getByRole('button', { name, exact: true });
      fireEvent.click(destination);
      destination.focus();
      await frames();
      await expect(destination).toHaveFocus();
    }
  },
};
