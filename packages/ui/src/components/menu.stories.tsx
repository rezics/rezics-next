import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '../shadcn/button.tsx';
import { Menu, type MenuEntry } from './menu.tsx';
import { ShelfToolbar } from './shelf-toolbar.tsx';

// Phone stories are reviewed at 390px; desktop stories are reviewed at 1280px in both themes.

function Example({ entries, title = 'Actions' }: { entries: MenuEntry[]; title?: string }) {
  return <Menu title={title} backLabel="Back" entries={entries} trigger={<Button>Open menu</Button>} />;
}
function RadioExample() {
  const [value, setValue] = useState('planned');
  return (
    <Example
      title="Status"
      entries={[
        {
          type: 'radio',
          label: 'Status',
          value,
          onValueChange: setValue,
          options: [
            { value: 'planned', label: 'Planned' },
            { value: 'reading', label: 'Reading' },
            { value: 'completed', label: 'Completed' },
          ],
        },
      ]}
    />
  );
}
const meta = { title: 'Components/Menu', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
const open: Story['play'] = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
  await waitFor(() => expect(screen.queryByRole('menu') ?? screen.queryByRole('dialog')).not.toBeNull());
};
const phone = { viewport: { value: 'phone' } };
const plain: MenuEntry[] = [
  { type: 'item', label: 'Open', onSelect: () => {} },
  { type: 'link', label: 'Visit subject', href: '/subjects/example' },
  { type: 'separator' },
  { type: 'item', label: 'Copy link', onSelect: () => {} },
];
export const PlainEntries: Story = {
  args: { entries: plain },
  globals: phone,
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    const panel = await screen.findByRole('dialog');
    const labels = [...panel.querySelectorAll('button, a')].map((row) => row.textContent?.trim()).filter(Boolean);
    await expect(labels).toEqual(['Open', 'Visit subject', 'Copy link']);
  },
};
export const PlainEntriesDark: Story = { ...PlainEntries, globals: { theme: 'dark' } };
export const SubmenuPage: Story = {
  args: {
    entries: [
      { type: 'submenu', label: 'Status', entries: [{ type: 'item', label: 'Completed', onSelect: () => {} }] },
    ],
  },
  globals: phone,
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Status' }));
    await expect(await screen.findByRole('button', { name: 'Back' })).toBeVisible();
    await expect(await screen.findByText('Completed')).toBeVisible();
  },
};
export const BrowserBack: Story = {
  args: {
    entries: [
      { type: 'submenu', label: 'Status', entries: [{ type: 'item', label: 'Completed', onSelect: () => {} }] },
    ],
  },
  globals: phone,
  play: async () => {
    const trigger = await screen.findByRole('button', { name: 'Open menu' });
    const route = window.location.href;
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('button', { name: 'Status' }));
    window.history.back();
    await waitFor(() => expect(screen.queryByText('Completed')).not.toBeInTheDocument());
    await expect(screen.getByRole('button', { name: 'Back' })).toBeVisible();
    window.history.back();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(window.location.href).toBe(route);
    await expect(trigger).toHaveFocus();
  },
};
export const RadioEntries: Story = {
  args: { entries: [] },
  render: () => <RadioExample />,
  globals: phone,
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    const planned = await screen.findByRole('radio', { name: 'Planned' });
    await expect(planned).toBeChecked();
    await userEvent.click(await screen.findByRole('radio', { name: 'Reading' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeVisible());
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    await expect(await screen.findByRole('radio', { name: 'Reading' })).toBeChecked();
  },
};
export const RadioDropdown: Story = {
  args: { entries: [] },
  render: () => <RadioExample />,
  globals: { viewport: { value: 'desktop' } },
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    await expect(await screen.findByRole('menuitemradio', { name: 'Planned' })).toBeChecked();
    const menu = screen.getByRole('menu');
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Reading' }));
    await waitFor(() => expect(menu).not.toBeVisible());
  },
};
export const DestructiveEntry: Story = {
  args: { entries: [{ type: 'destructive', label: 'Remove', onSelect: () => {} }] },
  globals: phone,
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    const remove = await screen.findByRole('button', { name: 'Remove' });
    await expect(remove).toHaveClass(/text-destructive/);
  },
};
export const DesktopDropdown: Story = {
  args: { entries: plain },
  globals: { viewport: { value: 'desktop' } },
  play: open,
};
export const DesktopDropdownDark: Story = { ...DesktopDropdown, globals: { theme: 'dark' } };

const toolbarLabels = {
  sort: 'Sort by the most recently updated items in your personal collection',
  direction: 'Choose the direction for ordering the complete collection',
  ascending: 'Oldest or alphabetically first items before everything else',
  descending: 'Newest or alphabetically last items before everything else',
  filter: 'Filter by an especially long list of translated statuses and categories',
  clearFilters: 'Clear every selected filter from this collection',
  removeFilter: 'Remove this selected filter from the current collection',
  layout: 'Choose the presentation layout for the collection',
  grid: 'Cover grid presentation',
  list: 'Detailed list presentation',
  table: 'Tabular collection presentation',
  display: 'Display density and presentation preferences',
  density: 'Choose the amount of information shown for each item',
  small: 'Small amount of detail',
  medium: 'Medium amount of detail',
  large: 'Large amount of detail',
  select: 'Select items in this collection',
  view: 'View sorting, filtering, and display controls',
  items: 'items in this collection',
};

const extraCriteria =
  'Include items with a long translated status description and a category label that wraps across multiple lines';

function FilterFields({
  expanded,
  onExpandedChange,
  onUnmount,
}: {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onUnmount: () => void;
}) {
  return (
    <div className="grid min-w-0 gap-3">
      <label className="grid min-w-0 gap-1 break-words text-sm">
        <span>Filter by language and translated publication status</span>
        <select aria-label="Filter by language and translated publication status" className="w-full min-w-0 max-w-full">
          <option>All languages and statuses</option>
          <option>Localized status with a very long translated name</option>
        </select>
      </label>
      <label className="grid min-w-0 gap-1 break-words text-sm">
        <span>Notes for this filter</span>
        <textarea
          aria-label="Notes for this filter"
          rows={2}
          className="w-full min-w-0 max-w-full rounded-md border bg-background p-2"
        />
      </label>
      <Button variant="outline" onClick={() => onExpandedChange(!expanded)}>
        {expanded ? 'Hide additional filter criteria' : 'Load additional filter criteria'}
      </Button>
      {expanded && (
        <fieldset className="grid min-w-0 gap-2">
          <legend className="break-words font-medium">Additional translated filter criteria</legend>
          {Array.from({ length: 48 }, (_, index) => (
            <label key={index} className="flex min-w-0 items-start gap-2 break-words text-sm">
              <input type="checkbox" />
              <span>
                {index + 1}. {extraCriteria}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <Button variant="ghost" onClick={onUnmount}>
        Unmount ShelfToolbar
      </Button>
    </div>
  );
}

function ShelfToolbarFormStory() {
  const [mounted, setMounted] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [sort, setSort] = useState('recent');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [layout, setLayout] = useState<'grid' | 'list' | 'table'>('grid');
  const [density, setDensity] = useState<'small' | 'medium' | 'large'>('medium');
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <Button variant="outline">Outside control</Button>
      <nav aria-label="Primary navigation">
        <a href="#menu-primary-navigation">Primary navigation destination</a>
      </nav>
      {mounted ? (
        <ShelfToolbar
          labels={toolbarLabels}
          sorts={[
            { value: 'recent', label: 'Most recently updated item in the full collection' },
            { value: 'title', label: 'Alphabetical title order for every collection item' },
          ]}
          sort={sort}
          direction={direction}
          onSortChange={(nextSort, nextDirection) => {
            setSort(nextSort);
            setDirection(nextDirection);
          }}
          filters={
            <FilterFields expanded={expanded} onExpandedChange={setExpanded} onUnmount={() => setMounted(false)} />
          }
          active={[{ key: 'status', label: 'A long translated selected status filter that wraps across the panel' }]}
          onRemoveFilter={() => {}}
          onClearFilters={() => {}}
          layout={layout}
          onLayoutChange={setLayout}
          density={density}
          onDensityChange={setDensity}
          onSelect={() => {}}
          count={128}
        />
      ) : (
        <Button onClick={() => setMounted(true)}>Mount ShelfToolbar</Button>
      )}
    </div>
  );
}

type TriggerRect = { left: number; top: number; width: number; height: number };

function setTriggerRect(
  button: HTMLElement,
  rect: TriggerRect,
  original: Map<HTMLElement, PropertyDescriptor | undefined>,
) {
  if (!original.has(button)) original.set(button, Object.getOwnPropertyDescriptor(button, 'getBoundingClientRect'));
  Object.defineProperty(button, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(rect.left, rect.top, rect.width, rect.height),
  });
}

async function expectPanelInViewport(panel: HTMLElement) {
  await waitFor(() => {
    const rect = panel.getBoundingClientRect();
    const viewport = panel.ownerDocument.defaultView!;
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    expect(rect.left).toBeGreaterThanOrEqual(-1);
    expect(rect.top).toBeGreaterThanOrEqual(-1);
    expect(rect.right).toBeLessThanOrEqual(viewport.innerWidth + 1);
    expect(rect.bottom).toBeLessThanOrEqual(viewport.innerHeight + 1);
  });
}

const customFormRegression: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const document = canvasElement.ownerDocument;
  const browser = document.defaultView!;
  const originalHref = browser.location.href;
  const matchMediaDescriptor = Object.getOwnPropertyDescriptor(browser, 'matchMedia');
  const triggerRects = new Map<HTMLElement, PropertyDescriptor | undefined>();
  const originalMatchMedia = browser.matchMedia.bind(browser);
  const restoreMatchMedia = () => {
    if (matchMediaDescriptor) Object.defineProperty(browser, 'matchMedia', matchMediaDescriptor);
    else Reflect.deleteProperty(browser, 'matchMedia');
  };

  try {
    expect(originalMatchMedia('(max-width: 767px)').matches).toBe(false);
    expect(originalMatchMedia('(pointer: coarse)').matches).toBe(false);

    const sortTrigger = canvas.getByRole('button', { name: new RegExp(toolbarLabels.sort) });
    setTriggerRect(
      sortTrigger,
      { left: browser.innerWidth - 120, top: browser.innerHeight - 52, width: 104, height: 36 },
      triggerRects,
    );
    await userEvent.click(sortTrigger);
    const sortPanel = await screen.findByRole('dialog', { name: toolbarLabels.sort });
    const sortControl = within(sortPanel).getByRole('combobox', { name: toolbarLabels.sort });
    await expect(sortControl).toHaveFocus();
    await expectPanelInViewport(sortPanel);
    await userEvent.selectOptions(sortControl, 'title');
    await expect(sortControl).toHaveValue('title');
    await userEvent.tab();
    await expect(within(sortPanel).getByRole('combobox', { name: toolbarLabels.direction })).toHaveFocus();

    const initialSortRect = sortPanel.getBoundingClientRect();
    setTriggerRect(sortTrigger, { left: 36, top: 52, width: 104, height: 36 }, triggerRects);
    browser.dispatchEvent(new Event('resize'));
    browser.dispatchEvent(new Event('scroll'));
    await waitFor(() => {
      const next = sortPanel.getBoundingClientRect();
      expect(Math.abs(next.left - initialSortRect.left) + Math.abs(next.top - initialSortRect.top)).toBeGreaterThan(12);
    });
    await expectPanelInViewport(sortPanel);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: toolbarLabels.sort })).not.toBeInTheDocument());
    await expect(sortTrigger).toHaveFocus();

    const filterTrigger = canvas.getByRole('button', { name: new RegExp(toolbarLabels.filter) });
    setTriggerRect(
      filterTrigger,
      { left: browser.innerWidth - 120, top: browser.innerHeight - 52, width: 104, height: 36 },
      triggerRects,
    );
    await userEvent.click(filterTrigger);
    const filterPanel = await screen.findByRole('dialog', { name: toolbarLabels.filter });
    const filterSelect = within(filterPanel).getByRole('combobox', {
      name: 'Filter by language and translated publication status',
    });
    const notes = within(filterPanel).getByRole('textbox', { name: 'Notes for this filter' });
    await expect(filterSelect).toHaveFocus();
    await userEvent.tab();
    await expect(notes).toHaveFocus();
    await userEvent.type(notes, 'Keep this native textarea focused during layout changes.');
    const loadCriteria = within(filterPanel).getByRole('button', { name: 'Load additional filter criteria' });
    await userEvent.click(loadCriteria);
    await waitFor(() => expect(filterPanel.scrollHeight).toBeGreaterThan(filterPanel.clientHeight));
    await expect(getComputedStyle(filterPanel).overflowY).toBe('auto');
    const nestedScrollOwners = [...filterPanel.querySelectorAll<HTMLElement>('*')].filter((node) => {
      if (node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement) return false;
      const style = getComputedStyle(node);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight;
    });
    await expect(nestedScrollOwners).toEqual([]);
    await expectPanelInViewport(filterPanel);
    await expect(loadCriteria).toHaveFocus();

    const initialFilterRect = filterPanel.getBoundingClientRect();
    setTriggerRect(filterTrigger, { left: 28, top: 88, width: 104, height: 36 }, triggerRects);
    browser.dispatchEvent(new Event('resize'));
    browser.dispatchEvent(new Event('scroll'));
    await waitFor(() => {
      const next = filterPanel.getBoundingClientRect();
      expect(Math.abs(next.left - initialFilterRect.left) + Math.abs(next.top - initialFilterRect.top)).toBeGreaterThan(
        12,
      );
    });
    await expectPanelInViewport(filterPanel);
    await expect(loadCriteria).toHaveFocus();

    const initialHash = browser.location.hash;
    await userEvent.click(canvas.getByRole('link', { name: 'Primary navigation destination' }));
    await expect(browser.location.hash).not.toBe(initialHash);
    await expect(screen.getByRole('dialog', { name: toolbarLabels.filter })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: toolbarLabels.filter })).not.toBeInTheDocument());
    await expect(filterTrigger).toHaveFocus();

    await userEvent.click(filterTrigger);
    const reopenedFilter = await screen.findByRole('dialog', { name: toolbarLabels.filter });
    const outsideControl = canvas.getByRole('button', { name: 'Outside control' });
    await userEvent.click(outsideControl);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: toolbarLabels.filter })).not.toBeInTheDocument());
    await expect(outsideControl).toHaveFocus();
    expect(reopenedFilter).not.toBeInTheDocument();

    const displayTrigger = canvas.getByRole('button', { name: new RegExp(toolbarLabels.display) });
    await userEvent.click(displayTrigger);
    const displayPanel = await screen.findByRole('dialog', { name: toolbarLabels.display });
    const largeDensity = within(displayPanel).getByRole('button', { name: toolbarLabels.large });
    await userEvent.click(largeDensity);
    await expect(largeDensity).toHaveAttribute('aria-pressed', 'true');
    await expect(displayPanel).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: toolbarLabels.display })).not.toBeInTheDocument());
    await expect(displayTrigger).toHaveFocus();

    const coarseMatchMedia = (query: string) => {
      if (query === '(pointer: coarse)') {
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return true;
          },
        } as MediaQueryList;
      }
      return originalMatchMedia(query);
    };
    Object.defineProperty(browser, 'matchMedia', { configurable: true, writable: true, value: coarseMatchMedia });
    await userEvent.click(sortTrigger);
    const phoneSheet = await screen.findByRole('dialog', { name: toolbarLabels.sort });
    await expect(within(phoneSheet).getByRole('combobox', { name: toolbarLabels.sort })).toBeVisible();
    await userEvent.click(within(phoneSheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: toolbarLabels.sort })).not.toBeInTheDocument());
    restoreMatchMedia();

    await userEvent.click(filterTrigger);
    const beforeUnmount = await screen.findByRole('dialog', { name: toolbarLabels.filter });
    await userEvent.click(within(beforeUnmount).getByRole('button', { name: 'Unmount ShelfToolbar' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: toolbarLabels.filter })).not.toBeInTheDocument());
    const escapeAfterUnmount = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escapeAfterUnmount);
    await expect(escapeAfterUnmount.defaultPrevented).toBe(false);

    await userEvent.click(canvas.getByRole('button', { name: 'Mount ShelfToolbar' }));
    const freshSortTrigger = canvas.getByRole('button', { name: new RegExp(toolbarLabels.sort) });
    await userEvent.click(freshSortTrigger);
    const freshPanel = await screen.findByRole('dialog', { name: toolbarLabels.sort });
    await expect(within(freshPanel).getByRole('combobox', { name: toolbarLabels.sort })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: toolbarLabels.sort })).not.toBeInTheDocument());
  } finally {
    for (const [button, descriptor] of triggerRects) {
      if (descriptor) Object.defineProperty(button, 'getBoundingClientRect', descriptor);
      else Reflect.deleteProperty(button, 'getBoundingClientRect');
    }
    restoreMatchMedia();
    browser.history.replaceState(browser.history.state, '', originalHref);
  }
};

export const ShelfToolbarCustomFormsDesktop: Story = {
  name: 'Shelf Toolbar Custom Forms Desktop',
  args: { entries: [] },
  render: () => <ShelfToolbarFormStory />,
  globals: { viewport: { value: 'desktop' } },
  play: customFormRegression,
};

export const ShelfToolbarCustomFormsPhone: Story = {
  name: 'Shelf Toolbar Custom Forms Phone',
  args: { entries: [] },
  render: () => <ShelfToolbarFormStory />,
  globals: phone,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: new RegExp(toolbarLabels.view) }));
    const viewPanel = await screen.findByRole('dialog', { name: toolbarLabels.view });
    await userEvent.click(within(viewPanel).getByRole('tab', { name: new RegExp(toolbarLabels.filter) }));
    await expect(
      within(viewPanel).getByRole('combobox', { name: 'Filter by language and translated publication status' }),
    ).toBeVisible();
    await expect(within(viewPanel).getByRole('textbox', { name: 'Notes for this filter' })).toBeVisible();
    await userEvent.click(within(viewPanel).getByRole('tab', { name: new RegExp(toolbarLabels.display) }));
    await expect(within(viewPanel).getByRole('group', { name: toolbarLabels.density })).toBeVisible();
    await userEvent.click(within(viewPanel).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: toolbarLabels.view })).not.toBeInTheDocument());
  },
};
