import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { withSurface } from '../stories/support.tsx';
import { ListRow, ListRowControl, ListRowLink } from './list-row.tsx';

const meta = { title: 'Rezics UI/List Row', component: ListRow, decorators: [withSurface] } satisfies Meta<
  typeof ListRow
>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SelectionAndControls: Story = {
  args: { children: null },
  render: () => <Example />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('link', { name: 'A long title that wraps across the available row width' }));
    await expect(canvas.getByText('Selected')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Increase count' }));
    await expect(canvas.getByText('Count 1')).toBeVisible();
    await userEvent.click(canvas.getByRole('link', { name: 'Secondary reference' }));
    await expect(canvas.getByText('Secondary link opened')).toBeVisible();
  },
};

function Example() {
  const [selected, setSelected] = useState(false);
  const [count, setCount] = useState(0);
  const [secondary, setSecondary] = useState(false);
  return (
    <ul>
      <ListRow forceOverlay className="flex items-center gap-4 py-4">
        <ListRowLink
          href="#primary"
          onClick={(event) => {
            event.preventDefault();
            setSelected((value) => !value);
          }}
        >
          A long title that wraps across the available row width
        </ListRowLink>
        <div className="min-w-0 flex-1">
          <h2 aria-hidden="true" className="max-w-md font-semibold">
            A long title that wraps across the available row width
          </h2>
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {selected ? 'Selected' : 'Not selected'}
          </p>
          {secondary && <p aria-live="polite">Secondary link opened</p>}
        </div>
        <ListRowControl className="flex items-center gap-3">
          <button type="button" aria-label="Increase count" onClick={() => setCount((value) => value + 1)}>
            +
          </button>
          <span aria-live="polite">Count {count}</span>
          <a
            href="#reference"
            onClick={(event) => {
              event.preventDefault();
              setSecondary(true);
            }}
          >
            Secondary reference
          </a>
        </ListRowControl>
      </ListRow>
    </ul>
  );
}
