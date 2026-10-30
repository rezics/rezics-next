import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, libraryEntriesReady, pageReady, pagePaths } from './page';
import entries from '../kernel/recorded/library-entries.json';

const meta = { title: 'Pages/Library/Personal Library', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
};
export const StatusTab: Story = {
  name: 'Status Tab',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?state=in_progress`} />,
};
export const ListLayout: Story = {
  name: 'List Layout',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?layout=list`} />,
};
export const TableLayout: Story = {
  name: 'Table Layout',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?layout=table`} />,
};
export const SmallGrid: Story = {
  name: 'Small Grid',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?size=s`} />,
};
export const MediumGrid: Story = {
  name: 'Medium Grid',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?size=m`} />,
};
export const LargeGrid: Story = {
  name: 'Large Grid',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?size=l`} />,
};

async function removeFromShelf(
  context: { canvasElement: HTMLElement },
  title = entries.libraryEntries[0]!.subject.label,
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
  name: 'Undo after shelf removal',
  play: (context) => removeFromShelf(context),
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
};

export const RestoreOccupied: Story = {
  name: 'Restore refused / entry already exists',
  play: removalStory('I Am a Cat', 'occupied'),
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?state=dropped&layout=list`} />,
};

export const RestoreStale: Story = {
  name: 'Restore refused / stale removal',
  play: removalStory('The Tale of Genji', 'stale'),
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?state=paused&layout=list`} />,
};

export const RestoreExpired: Story = {
  name: 'Restore refused / expired removal',
  play: removalStory('Norwegian Wood', 'expired'),
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?state=planned&layout=list`} />,
};

export const UndoRestored: Story = {
  name: 'Undo / restored entry',
  play: async (context) => {
    await removeFromShelf(context);
    await userEvent.click(await within(document.body).findByRole('button', { name: m.editor_undo() }));
    await expect(await within(context.canvasElement).findByRole('link', { name: 'Kokoro' })).toBeVisible();
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
};
