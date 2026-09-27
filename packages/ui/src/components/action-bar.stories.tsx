import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { EyeOffIcon, ShieldCheckIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import {
  ActionBar,
  ActionBarBody,
  ActionBarClose,
  ActionBarContent,
  ActionBarSeparator,
  ActionBarTrigger,
  ActionBarValue,
} from './action-bar.tsx';
import { Button, buttonVariants } from './button.tsx';

// Renders on the theme page color; `parameters.dark` switches to dark mode
// until Storybook has a global theme toolbar. The bar is portalled to the
// body, so dark mode also marks the document root while the story is shown.
const surface: Decorator = (Story, { parameters }) => {
  useEffect(() => {
    if (!parameters.dark) {
      return;
    }
    document.documentElement.classList.add('dark');
    return () => document.documentElement.classList.remove('dark');
  }, [parameters.dark]);

  return (
    <div
      className={cn(
        parameters.dark && 'dark',
        'min-h-96 max-w-xl bg-background p-6 pb-24 font-sans text-foreground',
      )}
    >
      <Story />
    </div>
  );
};

const reports = [
  { id: 'r1', summary: "Spoilers for the ending of Death's End", count: 4 },
  { id: 'r2', summary: 'Off-topic promotion of another Realm', count: 2 },
  { id: 'r3', summary: 'Harassment of the reviewer', count: 7 },
  { id: 'r4', summary: '《三体》书评中未标记的剧透', count: 3 },
];

const onHide = fn();
const onDismiss = fn();

const ModerationQueue = ({ initialSelection = [] }: { initialSelection?: string[] }) => {
  const [selected, setSelected] = useState<string[]>(initialSelection);
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  return (
    <>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-semibold">Reported reviews</legend>
        {reports.map((report) => (
          <label
            className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-3 text-sm has-checked:bg-accent/60"
            key={report.id}
          >
            <input
              checked={selected.includes(report.id)}
              className="size-4 accent-primary"
              onChange={() => toggle(report.id)}
              type="checkbox"
            />
            <span className="flex-1">{report.summary}</span>
            <span className="text-muted-foreground tabular-nums">{report.count} reports</span>
          </label>
        ))}
      </fieldset>

      <ActionBar
        onOpenChange={(open) => {
          if (!open) {
            setSelected([]);
          }
        }}
        open={selected.length > 0}
      >
        <ActionBarContent aria-label="Bulk moderation actions">
          <ActionBarBody>
            <ActionBarValue count={selected.length}>{selected.length} selected</ActionBarValue>
            <ActionBarSeparator />
            <Button onClick={() => onDismiss(selected)} size="sm" variant="ghost">
              <ShieldCheckIcon aria-hidden />
              Dismiss reports
            </Button>
            <Button onClick={() => onHide(selected)} size="sm" variant="destructive">
              <EyeOffIcon aria-hidden />
              Hide reviews
            </Button>
            <ActionBarSeparator />
            <ActionBarClose
              aria-label="Clear selection"
              className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
            >
              <XIcon aria-hidden />
            </ActionBarClose>
          </ActionBarBody>
        </ActionBarContent>
      </ActionBar>
    </>
  );
};

const meta = {
  title: 'Rezics UI/Feedback/Action Bar',
  component: ActionBar,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'A floating toolbar pinned to the bottom of the viewport for actions on a selection: bulk moderation of reported reviews, moving several Works between shelves or removing members from a Realm. Control `open` from the selection, show the count with `ActionBarValue`, and clear the selection in `onOpenChange(false)`; `Escape` and `ActionBarClose` close it. Name the toolbar with `aria-label`. Use a Menu for actions on a single item.',
      },
    },
  },
} satisfies Meta<typeof ActionBar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Selection: Story = {
  render: () => <ModerationQueue />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(document.body);
    await expect(page.queryByRole('toolbar')).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole('checkbox', { name: /Harassment/ }));
    await userEvent.click(canvas.getByRole('checkbox', { name: /Off-topic/ }));
    const toolbar = await page.findByRole('toolbar', { name: 'Bulk moderation actions' });
    // The bar slides in; wait for the animation before asserting visibility.
    await waitFor(() => expect(within(toolbar).getByText('2 selected')).toBeVisible());

    await userEvent.click(within(toolbar).getByRole('button', { name: 'Hide reviews' }));
    await expect(onHide).toHaveBeenCalledWith(['r3', 'r2']);

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('toolbar')).not.toBeInTheDocument());
    await expect(canvas.getByRole('checkbox', { name: /Harassment/ })).not.toBeChecked();
  },
};

export const CloseButton: Story = {
  render: () => <ModerationQueue initialSelection={['r1']} />,
  async play({ canvasElement }) {
    const page = within(document.body);
    const toolbar = await page.findByRole('toolbar');
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Clear selection' }));
    await waitFor(() => expect(page.queryByRole('toolbar')).not.toBeInTheDocument());
    await expect(
      within(canvasElement).getByRole('checkbox', { name: /Spoilers/ }),
    ).not.toBeChecked();
  },
};

export const WithTrigger: Story = {
  name: 'Uncontrolled with trigger',
  render: () => (
    <ActionBar>
      <ActionBarTrigger className={buttonVariants({ variant: 'outline' })}>
        Edit shelf
      </ActionBarTrigger>
      <ActionBarContent aria-label="Shelf actions">
        <ActionBarBody>
          <Button size="sm" variant="ghost">
            Move to Read
          </Button>
          <Button size="sm" variant="ghost">
            Remove from shelf
          </Button>
          <ActionBarSeparator />
          <ActionBarClose className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}>
            <XIcon aria-hidden />
          </ActionBarClose>
        </ActionBarBody>
      </ActionBarContent>
    </ActionBar>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Edit shelf' });
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const toolbar = await within(document.body).findByRole('toolbar', { name: 'Shelf actions' });
    await waitFor(() => expect(toolbar).toBeVisible());
  },
};

export const Placement: Story = {
  name: 'Placement bottom-end',
  render: () => (
    <ActionBar defaultOpen positioning={{ placement: 'bottom-end', gutter: '24px' }}>
      <ActionBarContent aria-label="Shelf actions">
        <ActionBarBody>
          <ActionBarValue count={3}>3 Works</ActionBarValue>
          <Button size="sm" variant="ghost">
            Move
          </Button>
        </ActionBarBody>
      </ActionBarContent>
    </ActionBar>
  ),
};

export const Dark: Story = {
  parameters: { dark: true },
  render: () => <ModerationQueue initialSelection={['r1', 'r4']} />,
};
