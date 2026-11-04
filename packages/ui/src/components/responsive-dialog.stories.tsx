import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '../shadcn/button';
import { ResponsiveDialog } from './responsive-dialog';

const meta = {
  title: 'Components/Responsive dialog',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function FilterReview() {
  const [open, setOpen] = useState(true);
  const [minimum, setMinimum] = useState('100');
  const launcher = useRef<HTMLButtonElement>(null);

  return (
    <main className="min-h-dvh p-6">
      <Button ref={launcher} onClick={() => setOpen(true)}>
        Open filter review
      </Button>
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title="Collection filters"
        description="Edit the current choices, then apply or cancel to return to the Collection."
        closeLabel="Cancel"
        finalFocus={() => launcher.current ?? false}
      >
        <form onSubmit={(event) => event.preventDefault()} className="grid gap-4">
          <label className="grid gap-2">
            Minimum word count
            <input
              className="min-h-11 rounded-md border bg-background px-3"
              name="range.from.schema:wordCount"
              type="number"
              value={minimum}
              onChange={(event) => setMinimum(event.currentTarget.value)}
            />
          </label>
          <Button type="submit">Apply filters</Button>
        </form>
      </ResponsiveDialog>
    </main>
  );
}

async function ready(context: { canvasElement: HTMLElement }) {
  const dialog = await within(document.body).findByRole('dialog', { name: 'Collection filters' });
  const input = within(dialog).getByRole('spinbutton', { name: 'Minimum word count' });
  await expect(input).toHaveValue(100);
  await userEvent.clear(input);
  await userEvent.type(input, '250');
  await expect(input).toHaveValue(250);
  await expect(within(context.canvasElement).getByRole('button', { name: 'Open filter review' })).toBeVisible();
}

export const PhoneDraft: Story = {
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
  render: () => <FilterReview />,
  play: ready,
};

export const DesktopDraft: Story = {
  globals: { viewport: { value: 'desktop1440' }, theme: 'dark' },
  render: () => <FilterReview />,
  play: ready,
};
