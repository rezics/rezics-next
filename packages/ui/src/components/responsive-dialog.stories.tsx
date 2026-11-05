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

function LongCopyEditor() {
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useState('Reading room, upper shelf');
  const [note, setNote] = useState(
    'A note with several paragraphs.\n\nKeep this selection while changing the viewport.\n\n'.repeat(8),
  );
  const launcher = useRef<HTMLButtonElement>(null);
  return (
    <main className="min-h-dvh bg-background p-6 text-foreground">
      <Button ref={launcher} onClick={() => setOpen(true)}>
        Edit Copy
      </Button>
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title="Edit Copy"
        description="Edit the current Copy and return to the inventory when finished."
        closeLabel="Cancel"
        finalFocus={() => launcher.current ?? false}
      >
        <form onSubmit={(event) => event.preventDefault()} className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
          <p className="whitespace-pre-wrap font-medium">
            {'A long edition title with an extended subtitle and a second language title / 長い版のタイトルと副題。'.repeat(
              3,
            )}
          </p>
          <label className="grid min-w-0 gap-2">
            Kind
            <select className="min-h-11 min-w-0 rounded-md border bg-background px-3 text-base" defaultValue="print">
              <option value="print">Print</option>
            </select>
          </label>
          <label className="grid min-w-0 gap-2">
            Status
            <select className="min-h-11 min-w-0 rounded-md border bg-background px-3 text-base" defaultValue="owned">
              <option value="owned">Owned</option>
            </select>
          </label>
          <fieldset className="min-w-0 space-y-4">
            <legend className="font-medium">Optional Copy details</legend>
            <label className="grid min-w-0 gap-2">
              Location
              <input
                className="min-h-11 min-w-0 rounded-md border bg-background px-3 text-base"
                value={location}
                onChange={(event) => setLocation(event.currentTarget.value)}
              />
            </label>
            <label className="grid min-w-0 gap-2">
              Source
              <input className="min-h-11 min-w-0 rounded-md border bg-background px-3 text-base" defaultValue="" />
            </label>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <label className="grid min-w-0 gap-2">
                Acquired on
                <input type="date" className="min-h-11 min-w-0 rounded-md border bg-background px-3 text-base" />
              </label>
              <label className="grid min-w-0 gap-2">
                Disposed on
                <input type="date" className="min-h-11 min-w-0 rounded-md border bg-background px-3 text-base" />
              </label>
            </div>
            <label className="grid min-w-0 gap-2">
              Note
              <textarea
                rows={12}
                className="min-h-48 min-w-0 resize-y rounded-md border bg-background p-3 text-base"
                value={note}
                onChange={(event) => setNote(event.currentTarget.value)}
              />
            </label>
          </fieldset>
          <div className="sticky bottom-0 flex flex-wrap gap-3 border-t bg-background pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Button type="submit" className="min-h-11">
              Save changes
            </Button>
            <Button type="button" className="min-h-11" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </ResponsiveDialog>
    </main>
  );
}

export const LongCopyForm: Story = {
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
  parameters: {
    docs: {
      description: {
        story:
          'Presentation fixture for a long Copy draft. Resize while editing or selecting note text; native Copy commands and validation remain in the Web caller.',
      },
    },
  },
  render: () => <LongCopyEditor />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Edit Copy' }));
    const dialog = await within(document.body).findByRole('dialog', { name: 'Edit Copy' });
    const note = within(dialog).getByRole('textbox', { name: 'Note' });
    await userEvent.click(note);
    await expect(note).toHaveFocus();
    await expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeVisible();
  },
};
