import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, screen, userEvent, within } from 'storybook/test';
import { useSelection } from '../hooks/use-selection.tsx';
import { Button } from '../shadcn/button.tsx';
import { SelectionBar } from './selection-bar.tsx';

function Example() {
  const selection = useSelection({ ids: ['One', 'Two', 'Three'] });
  return (
    <div>
      <Button onClick={() => selection.enter()}>Select</Button>
      {['One', 'Two', 'Three'].map((id) => (
        <div key={id}>
          <a href="#item" {...selection.bind(id)}>
            {id}
          </a>
          <button aria-label={`Select ${id}`} onClick={() => selection.toggle(id)}>
            □
          </button>
          {selection.isSelected(id) && ' selected'}
        </div>
      ))}
      {selection.active && (
        <SelectionBar
          count={selection.selected.size}
          label={(count) => `${count} selected`}
          actions={<Button onClick={selection.selectAll}>All</Button>}
          onCancel={selection.exit}
          cancelLabel="Cancel"
          moreLabel="More"
        />
      )}
    </div>
  );
}
const meta = { title: 'Actions/Shelf Selection', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
function enterSelection(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  return userEvent.click(canvas.getByRole('button', { name: 'Select' }));
}
export const Selection: Story = {
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await enterSelection(canvasElement);
    await userEvent.click(canvas.getByRole('link', { name: 'One' }));
    await fireEvent.click(canvas.getByRole('link', { name: 'Three' }), { shiftKey: true });
    await expect(canvas.getByText('3 selected')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByText('3 selected')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Select Two' }));
    await expect(canvas.getByText('1 selected')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    await enterSelection(canvasElement);
    const all = canvas.getByRole('button', { name: 'All' });
    all.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByText('3 selected')).toBeInTheDocument();
  },
};
export const CompactSelection: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = canvas.getByRole('link', { name: 'One' });
    await fireEvent.pointerDown(link, { pointerType: 'touch', clientX: 10, clientY: 10 });
    await new Promise((resolve) => setTimeout(resolve, 550));
    await fireEvent.pointerUp(link, { pointerType: 'touch' });
    await fireEvent.contextMenu(link);
    await fireEvent.click(link);
    await expect(canvas.getByText('1 selected')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await enterSelection(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'More' }));
    const more = await screen.findByRole('dialog', { name: 'More' });
    await userEvent.click(within(more).getByRole('button', { name: 'All' }));
    await expect(canvas.getByText('3 selected')).toBeInTheDocument();
  },
};
