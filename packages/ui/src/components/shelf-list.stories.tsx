import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, within } from 'storybook/test';
import { settled, withSurface } from '../stories/support.tsx';
import { ShelfList, ShelfListRow } from './shelf-list.tsx';
import { RelativeTime } from './relative-time.tsx';

const subject = {
  id: 'book',
  title: 'A long journey through the city of stars and the people who changed its history',
  types: ['schema:Book'],
};
const examples = [
  { id: 'book', title: subject.title, ratio: '2:3' as const, types: ['schema:Book'] },
  { id: 'game', title: '星を越えて — 彼方の記憶をたどる旅', ratio: '16:9' as const, types: ['schema:VideoGame'] },
];
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
  args: { children: null },
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
{examples.map((entry, index) => {
        const rowSubject = { id: entry.id, title: entry.title, types: entry.types };
        return (
          <ShelfListRow
            key={entry.id}
            href={`/${entry.id}`}
            cover={{ subject: rowSubject, cover: null, src: () => '', ratio: entry.ratio }}
            title={entry.title}
            titleLang={index === 0 ? 'en' : 'ja'}
            meta={index === 0 ? 'A. Author · Book' : 'Studio · Video game'}
            status={index === 0 ? 'Reading' : 'Playing'}
            statusMenuEntries={[
              {
                type: 'radio',
                label: 'Status',
                value: index === 0 ? 'reading' : 'playing',
                options: [
                  { value: index === 0 ? 'reading' : 'playing', label: index === 0 ? 'Reading' : 'Playing' },
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
            labels={{ select: `Select ${entry.id}`, menu: 'More actions' }}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            forceOverlay={index === 0}
          />
        );
      })}
    </ShelfList>
  );
}
