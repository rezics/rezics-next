import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, within } from 'storybook/test';
import { Button } from '../shadcn/button.tsx';
import { settled, withSurface } from '../stories/support.tsx';
import { ContentItem } from './content-item.tsx';
import { ShelfList, ShelfListRow } from './shelf-list.tsx';

const title = 'A long journey through the city of stars and the people who changed its history';
const bookTitle = 'A selected shelf entry with unknown progress';
const meta = {
  title: 'Components/Content Item',
  component: ContentItem,
  decorators: [withSurface],
} satisfies Meta<typeof ContentItem>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Composed: Story = {
  args: { title },
  render: () => <Example />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const heading = canvas.getByRole('heading', { name: title });
    const primaryLink = canvas.getByRole('link', { name: title });
    await expect(primaryLink).toHaveAttribute('aria-labelledby', heading.id);
    await expect(canvas.getAllByRole('link', { name: title })).toHaveLength(1);
    await expect(canvas.getByRole('heading', { name: 'A heading without a destination' })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'A heading without a destination' })).toBeNull();

    await userEvent.tab();
    await expect(primaryLink).toHaveFocus();

    const coverLink = canvas.getByRole('link', { name: 'Open cover artwork' });
    await userEvent.tab();
    await expect(coverLink).toHaveFocus();
    await userEvent.click(coverLink);
    await expect(canvas.getByRole('status')).toHaveTextContent('Cover link activated');

    const coverButton = canvas.getByRole('button', { name: 'Rotate cover' });
    await userEvent.tab();
    await expect(coverButton).toHaveFocus();
    await userEvent.click(coverButton);
    await expect(canvas.getByRole('status')).toHaveTextContent('Cover action activated');

    const followButton = canvas.getByRole('button', { name: 'Follow author' });
    await userEvent.tab();
    await expect(followButton).toHaveFocus();
    await userEvent.click(followButton);
    await expect(canvas.getByRole('status')).toHaveTextContent('Author followed');

    const authorLink = canvas.getByRole('link', { name: 'A. Author' });
    await userEvent.tab();
    await expect(authorLink).toHaveFocus();
    await userEvent.click(authorLink);
    await expect(canvas.getByRole('status')).toHaveTextContent('Author link activated');

    const noteSummary = canvas.getByText('Read the complete note');
    await userEvent.tab();
    await expect(noteSummary).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByText('The complete note remains visible after the disclosure opens.')).toBeVisible();

    const privateCheckbox = canvas.getByRole('checkbox', { name: 'Keep note private' });
    await userEvent.tab();
    await expect(privateCheckbox).toHaveFocus();
    await userEvent.click(privateCheckbox);
    await expect(privateCheckbox).toBeChecked();

    const noteVisibility = canvas.getByRole('combobox', { name: 'Note visibility' });
    await userEvent.tab();
    await expect(noteVisibility).toHaveFocus();
    await userEvent.selectOptions(noteVisibility, 'shared');
    await expect(noteVisibility).toHaveValue('shared');

    const personalNote = canvas.getByRole('textbox', { name: 'Personal note' });
    await userEvent.tab();
    await expect(personalNote).toHaveFocus();
    await userEvent.type(personalNote, 'Keep this detail.');

    const saveNoteButton = canvas.getByRole('button', { name: 'Save personal note' });
    await userEvent.tab();
    await expect(saveNoteButton).toHaveFocus();
    await userEvent.click(saveNoteButton);
    await expect(canvas.getByRole('status')).toHaveTextContent('Personal note saved');

    const sourceLink = canvas.getByRole('link', { name: 'Open note source' });
    await userEvent.tab();
    await expect(sourceLink).toHaveFocus();
    await userEvent.click(sourceLink);
    await expect(canvas.getByRole('status')).toHaveTextContent('Note source activated');

    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('Saved');

    await userEvent.click(canvas.getByRole('link', { name: bookTitle }));
    await expect(canvas.getByRole('checkbox', { name: 'Select book' })).toBeChecked();
    await expect(canvas.getByText('Selection callbacks: 1')).toBeVisible();
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select book' }));
    await expect(canvas.getByRole('checkbox', { name: 'Select book' })).not.toBeChecked();
    await expect(canvas.getByText('Selection callbacks: 2')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Reading' }));
    await expect(
      within(await settled(await screen.findByRole('menu'))).getByRole('menuitemradio', {
        name: 'Completed',
      }),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
  },
};

function Example() {
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState(false);
  const [selectionCallbacks, setSelectionCallbacks] = useState(0);
  const subject = { id: 'book', title: bookTitle, types: ['schema:Book'] };

  return (
    <div>
      <ShelfList>
        <ContentItem
          forceOverlay
          href="/works/stars"
          title={title}
          titleLang="en"
          visual={
            <div className="flex aspect-[5/7] w-[72px] flex-col items-start justify-between rounded bg-primary/10 p-2 text-xs text-primary sm:w-24">
              <a
                href="#cover"
                aria-label="Open cover artwork"
                onClick={(event) => {
                  event.preventDefault();
                  setMessage('Cover link activated');
                }}
              >
                Cover
              </a>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Rotate cover"
                onClick={() => setMessage('Cover action activated')}
              >
                ↻
              </Button>
            </div>
          }
          context={
            <span>
              Continue reading{' '}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Follow author"
                onClick={() => setMessage('Author followed')}
              >
                Follow
              </Button>
            </span>
          }
          metadata={
            <span>
              By{' '}
              <a
                href="#author"
                onClick={(event) => {
                  event.preventDefault();
                  setMessage('Author link activated');
                }}
              >
                A. Author
              </a>
            </span>
          }
          preview={
            <div className="space-y-2">
              <p>A short description supplied by the owning page, shown beneath the title.</p>
              <details>
                <summary className="min-h-11 cursor-pointer rounded py-2 text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  Read the complete note
                </summary>
                <p>The complete note remains visible after the disclosure opens.</p>
                <div className="mt-2 flex flex-col items-start gap-2">
                  <label>
                    <input type="checkbox" aria-label="Keep note private" /> Keep note private
                  </label>
                  <select aria-label="Note visibility" defaultValue="private">
                    <option value="private">Private</option>
                    <option value="shared">Shared</option>
                  </select>
                  <textarea aria-label="Personal note" defaultValue="A personal annotation" />
                  <Button
                    type="button"
                    aria-label="Save personal note"
                    onClick={() => setMessage('Personal note saved')}
                  >
                    Save note
                  </Button>
                  <a
                    href="#note-source"
                    onClick={(event) => {
                      event.preventDefault();
                      setMessage('Note source activated');
                    }}
                  >
                    Open note source
                  </a>
                </div>
              </details>
            </div>
          }
          state={<span>Episode 3 of 12</span>}
          actions={
            <Button variant="outline" size="sm" onClick={() => setMessage('Saved')}>
              Save
            </Button>
          }
          trailing={
            <Button variant="ghost" size="icon-sm" aria-label="More actions">
              <span aria-hidden>•••</span>
            </Button>
          }
        />
        <ShelfListRow
          href="/works/book"
          cover={{ subject, cover: null, src: () => '' }}
          title={bookTitle}
          meta="A supplied author and format"
          status="Reading"
          statusMenuEntries={[
            {
              type: 'radio',
              label: 'Status',
              value: 'reading',
              options: [
                { value: 'reading', label: 'Reading' },
                { value: 'completed', label: 'Completed' },
              ],
              onValueChange: () => {},
            },
          ]}
          progress={{ value: null, label: 'Progress unknown' }}
          labels={{ select: 'Select book', menu: 'More actions' }}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          onSelect={() => setSelectionCallbacks((count) => count + 1)}
        />
        <ContentItem title="A heading without a destination" headingLevel={3} context="Text-only item" />
      </ShelfList>
      <p role="status">{message}</p>
      <p>Selection callbacks: {selectionCallbacks}</p>
    </div>
  );
}
