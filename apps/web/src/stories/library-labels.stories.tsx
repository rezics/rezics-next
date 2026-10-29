import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PageStory, pagePaths, pageReady } from './page';
import { labelOperations } from '../kernel/fake/library-labels';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Pages/Library/Labels',
  parameters: { layout: 'fullscreen', admitted: labelOperations },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: pageReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="catalogue" />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['library-labels']} />,
};
export const Empty: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="empty" />,
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByText(m.library_labels_empty());
  },
};
export const NextPage: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="next" />,
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByRole('link', { name: m.library_label_more() });
  },
};
export const RenameConflict: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="conflict" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    const rename = (await view.findAllByRole('button', { name: m.library_label_rename() }))[0]!;
    const field = within(rename.closest('form')!).getByRole('textbox');
    await userEvent.clear(field);
    await userEvent.type(field, 'Outdated draft');
    await userEvent.click(rename);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.library_label_stale());
    await expect(view.getByDisplayValue('Winter reads')).toBeVisible();
  },
};
export const Undo: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-labels']} labelsFixture="undo" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    await userEvent.click((await view.findAllByRole('button', { name: m.library_label_delete() }))[0]!);
    await expect(await view.findByRole('status')).toHaveTextContent(m.library_label_deleted({ name: 'Winter reads' }));
    await expect(within(view.getByRole('status')).getByRole('button', { name: m.library_label_undo() })).toBeEnabled();
  },
};
