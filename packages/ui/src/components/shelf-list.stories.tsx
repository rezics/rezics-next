import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, within } from 'storybook/test';
import { settled, withSurface } from '../stories/support.tsx';
import { ShelfList, ShelfListRow } from './shelf-list.tsx';
import { RelativeTime } from './relative-time.tsx';

const subject = { id: 'book', title: 'A long journey through the city of stars', types: ['schema:Book'] };
const meta = { title: 'Rezics UI/Shelf List', component: ShelfList, decorators: [withSurface] } satisfies Meta<
  typeof ShelfList
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Entries: Story = {
  args: { children: null },
  render: () => <Example />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('link', { name: subject.title }));
    await expect(canvas.getByRole('checkbox', { name: 'Select book' })).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: 'Reading' }));
    await expect(
      within(await settled(await screen.findByRole('menu'))).getByRole('menuitem', { name: 'Completed' }),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
  },
};
export const MenusOpenPhone: Story = {
  render: () => <Example />,
  parameters: { viewport: { defaultViewport: 'phone' } },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Reading' }));
    await expect(await screen.findByRole('dialog')).toBeVisible();
    await expect(screen.getByRole('radio', { name: 'Completed' })).toBeVisible();
  },
};
function Example() {
  const [selected, setSelected] = useState(false);
  const [count, setCount] = useState(3);
  return (
    <ShelfList>
      <ShelfListRow
        href="/book"
        cover={{ subject, cover: null, src: () => '' }}
        title={subject.title}
        meta="A. Author · Book"
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
        progress={{ value: count / 12, label: `Ep ${count}/12` }}
        stepper={{
          onStep: (delta) => setCount((n) => Math.max(0, Math.min(12, n + delta))),
          decreaseLabel: 'Decrease progress',
          increaseLabel: 'Increase progress',
        }}
        date={<RelativeTime value="2026-10-26T12:00:00Z" now={new Date('2026-10-27T12:00:00Z')} locale="en" />}
        menuEntries={[{ type: 'destructive', label: 'Remove', onSelect: () => {} }]}
        labels={{ select: 'Select book', menu: 'More actions' }}
        selectable
        selected={selected}
        onSelectedChange={setSelected}
      />
    </ShelfList>
  );
}
