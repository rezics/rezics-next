import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { withSurface } from '../stories/support.tsx';
import {
  ShelfColumnPicker,
  ShelfTable,
  defaultShelfColumns,
  type ShelfColumn,
  type ShelfColumnId,
} from './shelf-table.tsx';
const subject = { id: 'book', title: 'A journey through the city of stars', types: ['schema:Book'] };
const labels: Record<ShelfColumnId, string> = {
  cover: 'Cover',
  title: 'Title',
  creator: 'Creator',
  type: 'Type',
  status: 'Status',
  progress: 'Progress',
  rating: 'Rating',
  added: 'Added',
  started: 'Started',
  finished: 'Finished',
  lastActivity: 'Last activity',
};
const meta = { title: 'Components/Shelf Table', component: ShelfTable, decorators: [withSurface] } satisfies Meta<
  typeof ShelfTable
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Editable: Story = {
  args: { rows: [], columns: [], onSort: () => {} },
  render: () => <Example />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Title' }));
    await expect(canvas.getByRole('columnheader', { name: 'Title' })).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(canvas.getByRole('link', { name: subject.title }));
    await expect(canvas.getByRole('checkbox', { name: 'Select book' })).toBeChecked();
    await userEvent.click(canvas.getAllByRole('button', { name: 'Show' })[0]!);
    await expect(canvas.getByRole('columnheader', { name: 'Creator' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Move down Creator' }));
  },
};
function Example() {
  const [columns, setColumns] = useState<ShelfColumn[]>(
    defaultShelfColumns.map((c) => ({ ...c, label: labels[c.id] })),
  );
  const [selected, setSelected] = useState(false);
  const [sort, setSort] = useState<{ field: ShelfColumnId; direction: 'asc' | 'desc' }>();
  return (
    <div className="space-y-6">
      <ShelfTable
        columns={columns}
        sort={sort}
        onSort={(field, direction) => setSort({ field, direction })}
        rows={[
          {
            id: 'book',
            href: '/book',
            title: subject.title,
            cover: { subject, cover: null, src: () => '' },
            creator: 'A. Author',
            type: 'Book',
            status: <button type="button">Reading</button>,
            progress: <button type="button">Ep 3/12</button>,
            rating: <button type="button">★★★★☆</button>,
            lastActivity: 'Yesterday',
            selectable: true,
            selected,
            onSelectedChange: setSelected,
            selectLabel: 'Select book',
          },
        ]}
      />
      <ShelfColumnPicker
        columns={columns}
        onColumnsChange={setColumns}
        labels={{
          visible: 'Visible columns',
          hidden: 'Hidden columns',
          show: 'Show',
          hide: 'Hide',
          moveUp: 'Move up',
          moveDown: 'Move down',
        }}
      />
    </div>
  );
}
