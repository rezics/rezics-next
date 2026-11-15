import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '../shadcn/button';
import { Field, FieldLabel } from '../shadcn/field';
import { Input } from '../shadcn/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../shadcn/select';
import { Textarea } from '../shadcn/textarea';
import { ResponsiveDialog } from './responsive-dialog';

const kindItems = [{ value: 'print', label: 'Print' }];
const statusItems = [{ value: 'owned', label: 'Owned' }];

function ChoiceField({
  id,
  label,
  items,
  defaultValue,
}: {
  id: string;
  label: string;
  items: { value: string; label: string }[];
  defaultValue: string;
}) {
  return (
    <Field className="min-w-0">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select<string, false> items={items} defaultValue={defaultValue}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

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
          <Field>
            <FieldLabel htmlFor="filter-minimum">Minimum word count</FieldLabel>
            <Input
              id="filter-minimum"
              name="range.from.schema:wordCount"
              type="number"
              value={minimum}
              onChange={(event) => setMinimum(event.currentTarget.value)}
            />
          </Field>
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

export const Draft: Story = { render: () => <FilterReview />, play: ready };

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
          <ChoiceField id="copy-kind" label="Kind" items={kindItems} defaultValue="print" />
          <ChoiceField id="copy-status" label="Status" items={statusItems} defaultValue="owned" />
          <fieldset className="min-w-0 space-y-4">
            <legend className="font-medium">Optional Copy details</legend>
            <Field className="min-w-0">
              <FieldLabel htmlFor="copy-location">Location</FieldLabel>
              <Input
                id="copy-location"
                value={location}
                onChange={(event) => setLocation(event.currentTarget.value)}
              />
            </Field>
            <Field className="min-w-0">
              <FieldLabel htmlFor="copy-source">Source</FieldLabel>
              <Input id="copy-source" defaultValue="" />
            </Field>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Field className="min-w-0">
                <FieldLabel htmlFor="copy-acquired">Acquired on</FieldLabel>
                <Input id="copy-acquired" type="date" />
              </Field>
              <Field className="min-w-0">
                <FieldLabel htmlFor="copy-disposed">Disposed on</FieldLabel>
                <Input id="copy-disposed" type="date" />
              </Field>
            </div>
            <Field className="min-w-0">
              <FieldLabel htmlFor="copy-note">Note</FieldLabel>
              <Textarea
                id="copy-note"
                rows={12}
                className="min-h-48 min-w-0 resize-y"
                value={note}
                onChange={(event) => setNote(event.currentTarget.value)}
              />
            </Field>
          </fieldset>
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t bg-background pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Button type="submit">Save changes</Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </ResponsiveDialog>
    </main>
  );
}

export const LongCopyForm: Story = {
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
