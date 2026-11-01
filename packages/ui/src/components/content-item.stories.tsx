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
    await expect(
      canvas.getByRole('heading', { name: 'A heading without a destination' }),
    ).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'A heading without a destination' })).toBeNull();

    await userEvent.tab();
    await expect(primaryLink).toHaveFocus();
    const authorLink = canvas.getByRole('link', { name: 'A. Author' });
    await userEvent.tab();
    await expect(authorLink).toHaveFocus();
    await userEvent.click(authorLink);
    await expect(canvas.getByRole('status')).toHaveTextContent('Author link activated');
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
            <div className="flex aspect-[5/7] w-[72px] items-end rounded bg-primary/10 p-2 text-xs text-primary sm:w-24">
              Cover
            </div>
          }
          context="Continue reading"
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
          preview="A short description supplied by the owning page, shown beneath the title."
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
