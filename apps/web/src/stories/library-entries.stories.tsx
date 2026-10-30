import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { userEvent, within, waitFor } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { displayLibraryTitle } from '../library/title';
import { PageStory, exposureStory, libraryEntriesReady, pageReady, pagePaths } from './page';
import entries from '../kernel/recorded/library-entries.json';

const meta = { title: 'Pages/Library/Entries', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function filteredEntriesPath(title: string): string {
  const row = entries.libraryEntries.find(
    (entry) => displayLibraryTitle(entry.subject.label, getLocale()).text === title,
  );
  if (!row) throw new Error(`No recorded entry exists for ${title}.`);
  return `${pagePaths['library-entries']}?state=${encodeURIComponent(row.state)}&layout=list`;
}
export const SignedIn: Story = {
  name: 'Owner',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
};
export const ExposureOpen: Story = exposureStory(pagePaths['library-entries']);
export const ExposureClosed: Story = exposureStory(pagePaths['library-entries'], true);

async function removeFromShelf(
  context: { canvasElement: HTMLElement },
  title = displayLibraryTitle(entries.libraryEntries[0]!.subject.label, getLocale()).text,
) {
  await pageReady(context);
  const canvas = within(context.canvasElement);
  const actions = await canvas.findByRole('button', { name: m.library_entry_actions({ title }) });
  await waitFor(() => expect(actions).toBeEnabled());
  await userEvent.click(actions);
  const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
  await userEvent.click(
    await within(document.body).findByRole(sheet ? 'button' : 'menuitem', {
      name: m.library_remove_from_library(),
    }),
  );
  await userEvent.click(await within(document.body).findByRole('button', { name: m.library_remove_submit() }));
  await expect(await within(document.body).findByRole('button', { name: m.editor_undo() })).toBeVisible();
  await waitFor(() => expect(canvas.queryByRole('button', { name: m.library_entry_actions({ title }) })).toBeNull());
  window.scrollTo({ top: 0, behavior: 'instant' });
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function removalStory(title: string, refusal: 'occupied' | 'stale' | 'expired') {
  return async (context: { canvasElement: HTMLElement }) => {
    await removeFromShelf(context, title);
    const canvas = within(context.canvasElement);
    await userEvent.click(await within(document.body).findByRole('button', { name: m.editor_undo() }));
    await expect(await canvas.findByText(m[`library_restore_${refusal}`]())).toBeVisible();
    if (refusal === 'occupied') await canvas.findByText('I Am a Cat');
  };
}

export const UndoAfterShelfRemoval: Story = {
  tags: ['!dev'],
  name: 'Owner, entry removed',
  play: (context) => removeFromShelf(context),
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
};

export const RestoreOccupied: Story = {
  tags: ['!dev'],
  name: 'Restore blocked by existing entry',
  play: removalStory('I Am a Cat', 'occupied'),
  render: () => <PageStory visitor="Signed In" path={filteredEntriesPath('I Am a Cat')} />,
};

export const RestoreStale: Story = {
  tags: ['!dev'],
  name: 'Restore blocked by changed entry',
  play: removalStory('The Tale of Genji', 'stale'),
  render: () => <PageStory visitor="Signed In" path={filteredEntriesPath('The Tale of Genji')} />,
};

export const RestoreExpired: Story = {
  tags: ['!dev'],
  name: 'Restore window expired',
  play: removalStory('Norwegian Wood', 'expired'),
  render: () => <PageStory visitor="Signed In" path={filteredEntriesPath('Norwegian Wood')} />,
};

export const UndoRestored: Story = {
  tags: ['!dev'],
  name: 'Owner, entry restored',
  play: async (context) => {
    await removeFromShelf(context);
    await userEvent.click(await within(document.body).findByRole('button', { name: m.editor_undo() }));
    await expect(await within(context.canvasElement).findByRole('link', { name: 'Kokoro' })).toBeVisible();
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
};
