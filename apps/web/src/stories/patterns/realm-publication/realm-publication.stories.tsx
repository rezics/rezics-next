import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RealmPublicationExample } from './realm-publication';
import { m } from '../../../paraglide/messages.js';
import { entityPickerMessages } from '../../../../../../packages/ui/src/components/entity-picker-messages';
import { getLocale } from '../../../paraglide/runtime.js';
import { uiCopyLocale } from '../../../../../../packages/ui/src/i18n/copy';
import { pickText } from '@rezics/composition';
import search from '../../../kernel/recorded/search.json';

const meta = {
  title: 'Patterns/Community/Realm Publication',
  component: RealmPublicationExample,
  excludeStories: ['openPicker', 'chooseSubject'],
  parameters: { layout: 'padded' },
} satisfies Meta<typeof RealmPublicationExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export async function openPicker({ canvasElement }: { canvasElement: HTMLElement }) {
  const view = within(canvasElement);
  await userEvent.click(await view.findByRole('button', { name: m.realm_publication_curate() }));
  await expect(view.getByRole('button', { name: m.realm_publication_publish() })).toBeDisabled();
}

export async function chooseSubject(context: { canvasElement: HTMLElement }) {
  await openPicker(context);
  const view = within(context.canvasElement);
  const title = pickText(search.subjects[0]!.labels, getLocale()).text;
  await userEvent.type(view.getByRole('combobox', { name: m.realm_publication_choose() }), title);
  await userEvent.click(await within(document.body).findByRole('option', { name: new RegExp(title) }));
  await expect(view.getByLabelText(m.realm_publication_selected())).toHaveTextContent(title);
  await expect(view.getByRole('button', { name: m.realm_publication_publish() })).toBeEnabled();
  await expect(view.queryByText(m.realm_publication_saved())).toBeNull();
}

export const Selection: Story = { play: openPicker };
export const Chosen: Story = { play: chooseSubject };
export const ClearSelection: Story = {
  play: async (context) => {
    await chooseSubject(context);
    const view = within(context.canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.realm_publication_clear() }));
    await expect(view.getByRole('combobox', { name: m.realm_publication_choose() })).toHaveValue('');
    await expect(view.getByRole('button', { name: m.realm_publication_publish() })).toBeDisabled();
    await expect(view.queryByText(m.realm_publication_saved())).toBeNull();
  },
};
export const SearchUnavailable: Story = {
  args: { unavailable: true },
  play: async (context) => {
    await openPicker(context);
    const view = within(context.canvasElement);
    await userEvent.type(view.getByRole('combobox', { name: m.realm_publication_choose() }), 'The');
    const copy = entityPickerMessages[uiCopyLocale(getLocale())];
    await within(document.body).findByText(copy.failed);
    await expect(within(document.body).queryByText(copy.empty.replace('{query}', 'The'))).toBeNull();
    await expect(view.getByRole('button', { name: m.realm_publication_publish() })).toBeDisabled();
  },
};
export const Frozen: Story = {
  args: { frozen: true },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { name: m.realm_published_heading() });
    await expect(view.queryByRole('button', { name: m.realm_publication_curate() })).toBeNull();
    await expect(view.queryByRole('combobox', { name: m.realm_publication_choose() })).toBeNull();
  },
};

export const SelectionHierarchy: Story = {
  play: async (context) => {
    await chooseSubject(context);
    const view = within(context.canvasElement);
    await expect(view.getByRole('heading', { level: 2, name: m.realm_published_heading() })).toBeVisible();
    await expect(view.getByRole('heading', { level: 3, name: m.realm_publication_curate() })).toBeVisible();
    const selected = view.getByRole('group', { name: m.realm_publication_selected() });
    await expect(within(selected).getByRole('heading', { level: 4 })).toHaveTextContent(
      pickText(search.subjects[0]!.labels, getLocale()).text,
    );
    await expect(view.getByText(m.realm_publication_scope())).toBeVisible();
    await expect(view.getByText(m.realm_publication_confirm())).toBeVisible();
    await expect(selected.querySelector('a')).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.realm_publication_curate() }));
    await expect(view.queryByRole('group', { name: m.realm_publication_selected() })).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.realm_publication_curate() }));
    await expect(view.getByRole('group', { name: m.realm_publication_selected() })).toHaveTextContent(
      pickText(search.subjects[0]!.labels, getLocale()).text,
    );
  },
};
