import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fireEvent, screen, userEvent, waitFor, within } from 'storybook/test';
import { withSurface } from '../stories/support.tsx';
import { Button } from '../shadcn/button.tsx';
import { Field, FieldLabel } from '../shadcn/field.tsx';
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select.tsx';
import { Textarea } from '../shadcn/textarea.tsx';
import {
  ShelfColumnPicker,
  ShelfTable,
  defaultShelfColumns,
  type ShelfColumn,
  type ShelfColumnId,
  type ShelfTableRow,
} from './shelf-table.tsx';
import { ShelfTabs, ShelfToolbar, ShelfTypeChips } from './shelf-toolbar.tsx';
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

const workflowLabels = {
  sort: 'Sort by the most recently updated items in this personal collection',
  direction: 'Choose the direction for ordering the complete collection',
  ascending: 'Oldest or alphabetically first items before everything else',
  descending: 'Newest or alphabetically last items before everything else',
  filter: 'Filter by an especially long list of translated statuses and categories',
  clearFilters: 'Clear every selected filter from this collection',
  removeFilter: 'Remove this selected filter from the current collection',
  layout: 'Choose the presentation layout for this collection',
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

const workflowColumnLabels: Record<ShelfColumnId, string> = {
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

function createWorkflowColumns() {
  return defaultShelfColumns.map((column) => ({ ...column, label: workflowColumnLabels[column.id] }));
}

function WorkflowFilters() {
  return (
    <div className="grid min-w-0 gap-3">
      <Field className="min-w-0 gap-1">
        <FieldLabel htmlFor="workflow-filter-status" className="min-w-0 whitespace-normal break-words">
          Filter by language and translated publication status
        </FieldLabel>
        <NativeSelect
          id="workflow-filter-status"
          className="w-full min-w-0 max-w-full [&>select]:h-11 [&>select]:min-h-11 sm:[&>select]:h-8 sm:[&>select]:min-h-8"
        >
          <NativeSelectOption value="all">All languages and statuses</NativeSelectOption>
          <NativeSelectOption value="localized">Localized status with a very long translated name</NativeSelectOption>
        </NativeSelect>
      </Field>
      <Field className="min-w-0 gap-1">
        <FieldLabel htmlFor="workflow-filter-notes" className="min-w-0 whitespace-normal break-words">
          Notes for this filter
        </FieldLabel>
        <Textarea id="workflow-filter-notes" rows={2} className="min-w-0 max-w-full" />
      </Field>
    </div>
  );
}

function ConnectedShelfJourney() {
  const [columns, setColumns] = useState(createWorkflowColumns);
  const [peerColumns, setPeerColumns] = useState(createWorkflowColumns);
  const [pickerMounted, setPickerMounted] = useState(true);
  const [peerMounted, setPeerMounted] = useState(true);
  const [status, setStatus] = useState('all');
  const [type, setType] = useState('all');
  const [sort, setSort] = useState('recent');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [tableSort, setTableSort] = useState<{ field: ShelfColumnId; direction: 'asc' | 'desc' }>();
  const [activeFilters, setActiveFilters] = useState([
    { key: 'status', label: 'Reading' },
    { key: 'type', label: 'Books' },
  ]);
  const [layout, setLayout] = useState<'grid' | 'list' | 'table'>('grid');
  const [density, setDensity] = useState<'small' | 'medium' | 'large'>('medium');
  const [mainWrites, setMainWrites] = useState(0);
  const [peerWrites, setPeerWrites] = useState(0);
  const [writerEpoch, setWriterEpoch] = useState(0);
  const [lastWriter, setLastWriter] = useState(-1);
  const [inputPreserved, setInputPreserved] = useState(true);
  const [selected, setSelected] = useState(false);

  const inputSnapshot = JSON.stringify(columns);
  const onColumnsChange = (next: ShelfColumn[]) => {
    const nextIsIndependent = next !== columns;
    setInputPreserved((preserved) => preserved && nextIsIndependent && JSON.stringify(columns) === inputSnapshot);
    setColumns(next);
    setMainWrites((count) => count + 1);
    setLastWriter(writerEpoch);
  };
  const onPeerColumnsChange = (next: ShelfColumn[]) => {
    setPeerColumns(next);
    setPeerWrites((count) => count + 1);
  };
  const lifecycleControls = (
    <fieldset className="grid min-w-0 gap-2 rounded-md border p-2">
      <legend>Configuration visit controls</legend>
      <div className="flex min-w-0 flex-wrap gap-2">
        <Button size="sm" onClick={() => setColumns((current) => [...current].reverse())}>
          Replace schema B
        </Button>
        <Button size="sm" onClick={() => setColumns(createWorkflowColumns())}>
          Restore schema A
        </Button>
        <Button size="sm" onClick={() => setColumns((current) => current.filter((column) => column.id !== 'creator'))}>
          Remove Creator
        </Button>
        <Button
          size="sm"
          onClick={() =>
            setColumns((current) => current.map((column) => ({ ...column, label: `Revised ${column.label}` })))
          }
        >
          Refresh equal column labels
        </Button>
        <Button size="sm" onClick={() => setWriterEpoch((value) => value + 1)}>
          Reallocate callback
        </Button>
        <Button
          size="sm"
          onClick={() =>
            setPeerColumns((current) => current.map((column) => ({ ...column, label: `Independent ${column.label}` })))
          }
        >
          Rerender independent parent
        </Button>
        {pickerMounted ? (
          <Button size="sm" onClick={() => setPickerMounted(false)}>
            Unmount main picker
          </Button>
        ) : (
          <Button size="sm" onClick={() => setPickerMounted(true)}>
            Mount main picker
          </Button>
        )}
      </div>
    </fieldset>
  );
  const shelfRows: ShelfTableRow[] = [
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
  ];

  return (
    <main
      className="mx-auto min-w-0 max-w-7xl space-y-5 p-4"
      data-testid="connected-shelf-workflow"
      onClick={(event) => {
        const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
        if (anchor?.hash === '#cancelled-status') event.preventDefault();
      }}
    >
      <header>
        <p className="text-sm text-muted-foreground">Your collection</p>
        <h1 className="text-2xl font-semibold">Connected shelf workflow</h1>
      </header>
      <ShelfTabs
        tabs={[
          { value: 'all', label: 'All', count: 10, shown: 4, href: '#all-status' },
          { value: 'progress', label: 'In progress', count: 4, href: '#progress-status' },
          { value: 'planned', label: 'Planned', count: 6, href: '#planned-status' },
          { value: 'completed', label: 'Completed', count: 0, href: '#completed-status' },
          { value: 'cancelled', label: 'Cancelled', count: 0, href: '#cancelled-status' },
        ]}
        value={status}
        onValueChange={setStatus}
      />
      <output aria-label="Current shelf status" data-testid="shelf-status">
        {status}
      </output>
      <ShelfTypeChips
        label="Type"
        options={[
          { value: 'all', label: 'All types' },
          { value: 'books', label: 'Books' },
          { value: 'music', label: 'Music' },
        ]}
        value={type}
        onValueChange={setType}
      />
      <output aria-label="Current shelf type" data-testid="shelf-type">
        {type}
      </output>
      <ShelfToolbar
        labels={workflowLabels}
        sorts={[
          { value: 'recent', label: 'Most recently updated item in the complete collection' },
          { value: 'title', label: 'Alphabetical title order for every collection item' },
        ]}
        sort={sort}
        direction={direction}
        onSortChange={(nextSort, nextDirection) => {
          setSort(nextSort);
          setDirection(nextDirection);
        }}
        filters={<WorkflowFilters />}
        active={activeFilters}
        onRemoveFilter={(key) => setActiveFilters((current) => current.filter((filter) => filter.key !== key))}
        onClearFilters={() => setActiveFilters([])}
        layout={layout}
        onLayoutChange={setLayout}
        density={density}
        onDensityChange={setDensity}
        columns={
          <div className="grid min-w-0 gap-3">
            {pickerMounted && (
              <ShelfColumnPicker
                columns={columns}
                onColumnsChange={onColumnsChange}
                labels={{
                  visible: 'Visible columns',
                  hidden: 'Hidden columns',
                  show: 'Show',
                  hide: 'Hide',
                  moveUp: 'Move up',
                  moveDown: 'Move down',
                }}
              />
            )}
            {lifecycleControls}
          </div>
        }
        onSelect={() => setSelected((value) => !value)}
        count={4}
      />
      <div className="flex min-w-0 flex-wrap gap-3" aria-label="Controlled shelf state">
        <output data-testid="toolbar-sort">
          {sort}:{direction}
        </output>
        <output data-testid="toolbar-layout">{layout}</output>
        <output data-testid="toolbar-density">{density}</output>
        <output data-testid="main-column-order">{columns.map((column) => column.id).join(',')}</output>
        <output data-testid="peer-column-order">{peerColumns.map((column) => column.id).join(',')}</output>
        <output data-testid="main-column-writes">{mainWrites}</output>
        <output data-testid="peer-column-writes">{peerWrites}</output>
        <output data-testid="last-column-writer">{lastWriter}</output>
        <output data-testid="column-input-preserved">{String(inputPreserved)}</output>
      </div>
      {layout === 'table' && (
        <div className="min-w-0 overflow-x-auto">
          <ShelfTable
            rows={shelfRows}
            columns={columns}
            sort={tableSort}
            onSort={(field, nextDirection) => setTableSort({ field, direction: nextDirection })}
          />
        </div>
      )}
      <section className="min-w-0 space-y-2 rounded-md border p-3" aria-label="Independent controlled picker">
        <h2 className="font-semibold">Independent controlled picker</h2>
        <div className="flex min-w-0 flex-wrap gap-2">
          {peerMounted ? (
            <Button size="sm" onClick={() => setPeerMounted(false)}>
              Unmount independent picker
            </Button>
          ) : (
            <Button size="sm" onClick={() => setPeerMounted(true)}>
              Mount independent picker
            </Button>
          )}
          <Button size="sm" onClick={() => setPeerColumns((current) => current.map((column) => ({ ...column })))}>
            Refresh independent picker
          </Button>
        </div>
        {peerMounted && (
          <ShelfColumnPicker
            columns={peerColumns}
            onColumnsChange={onPeerColumnsChange}
            labels={{
              visible: 'Independent visible columns',
              hidden: 'Independent hidden columns',
              show: 'Show',
              hide: 'Hide',
              moveUp: 'Move up',
              moveDown: 'Move down',
            }}
          />
        )}
      </section>
    </main>
  );
}

export const ConnectedShelfConfigurationJourney: Story = {
  args: { rows: [], columns: [], onSort: () => {} },
  render: () => <ConnectedShelfJourney />,
  globals: { viewport: { value: 'desktop' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const document = canvasElement.ownerDocument;
    const browser = document.defaultView!;
    const workflow = canvas.getByTestId('connected-shelf-workflow');

    const allStatus = canvas.getByRole('link', { name: 'All 4 / 10' });
    await expect(allStatus).toHaveAttribute('href', '#all-status');
    await expect(allStatus).toHaveAttribute('aria-current', 'page');
    await userEvent.click(canvas.getByRole('link', { name: 'Planned 6' }));
    await waitFor(() => expect(canvas.getByTestId('shelf-status')).toHaveTextContent('planned'));
    await expect(browser.location.hash).toBe('#planned-status');

    const progress = canvas.getByRole('link', { name: 'In progress 4' });
    progress.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByTestId('shelf-status')).toHaveTextContent('progress'));
    await expect(browser.location.hash).toBe('#progress-status');
    await expect(progress).toHaveAttribute('aria-current', 'page');

    const completed = canvas.getByRole('link', { name: 'Completed 0' });
    const hashBeforeModified = browser.location.hash;
    await fireEvent.click(completed, { ctrlKey: true });
    await expect(canvas.getByTestId('shelf-status')).toHaveTextContent('progress');
    await fireEvent.click(completed, { metaKey: true });
    await expect(canvas.getByTestId('shelf-status')).toHaveTextContent('progress');
    await fireEvent.click(completed, { button: 1 });
    await expect(canvas.getByTestId('shelf-status')).toHaveTextContent('progress');
    await fireEvent.click(completed, { button: 2 });
    await expect(canvas.getByTestId('shelf-status')).toHaveTextContent('progress');
    await expect(browser.location.hash).toBe(hashBeforeModified);

    const hashBeforeCancelled = browser.location.hash;
    await userEvent.click(canvas.getByRole('link', { name: 'Cancelled 0' }));
    await expect(browser.location.hash).toBe(hashBeforeCancelled);
    await expect(canvas.getByTestId('shelf-status')).toHaveTextContent('progress');

    await userEvent.click(canvas.getByRole('button', { name: 'Books' }));
    await expect(canvas.getByTestId('shelf-type')).toHaveTextContent('books');
    await expect(canvas.getByRole('button', { name: 'Books' })).toHaveAttribute('aria-pressed', 'true');

    const filterTrigger = canvas.getByRole('button', { name: new RegExp(workflowLabels.filter) });
    await userEvent.click(filterTrigger);
    const filterPanel = await screen.findByRole('dialog', { name: workflowLabels.filter });
    const filterSelect = within(filterPanel).getByRole('combobox', {
      name: 'Filter by language and translated publication status',
    });
    const filterNotes = within(filterPanel).getByRole('textbox', { name: 'Notes for this filter' });
    await userEvent.selectOptions(filterSelect, 'localized');
    await userEvent.type(filterNotes, 'Keep this native textarea usable in the connected shelf form.');
    await userEvent.click(within(filterPanel).getByRole('button', { name: 'Remove filter: Reading' }));
    await expect(within(filterPanel).queryByRole('button', { name: 'Remove filter: Reading' })).not.toBeInTheDocument();
    await userEvent.click(within(filterPanel).getByRole('button', { name: workflowLabels.clearFilters }));
    await expect(within(filterPanel).queryByRole('button', { name: /Remove filter:/ })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: workflowLabels.filter })).not.toBeInTheDocument());
    await expect(filterTrigger).toHaveFocus();

    const sortTrigger = canvas.getByRole('button', { name: new RegExp(workflowLabels.sort) });
    await userEvent.click(sortTrigger);
    const sortPanel = await screen.findByRole('dialog', { name: workflowLabels.sort });
    const sortControl = within(sortPanel).getByRole('combobox', { name: workflowLabels.sort });
    await userEvent.selectOptions(sortControl, 'title');
    const directionControl = within(sortPanel).getByRole('combobox', { name: workflowLabels.direction });
    await userEvent.selectOptions(directionControl, 'asc');
    await expect(canvas.getByTestId('toolbar-sort')).toHaveTextContent('title:asc');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: workflowLabels.sort })).not.toBeInTheDocument());
    await expect(sortTrigger).toHaveFocus();

    await userEvent.click(canvas.getByRole('button', { name: workflowLabels.table }));
    await expect(canvas.getByTestId('toolbar-layout')).toHaveTextContent('table');
    const table = canvas.getByRole('table');
    await expect(within(table).getByRole('columnheader', { name: 'Title' })).toBeVisible();
    await userEvent.click(within(table).getByRole('button', { name: 'Title' }));
    await expect(within(table).getByRole('columnheader', { name: 'Title' })).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(canvas.getByRole('button', { name: workflowLabels.select }));
    await expect(canvas.getByRole('checkbox', { name: 'Select book' })).toBeChecked();

    const displayTrigger = canvas.getByRole('button', { name: new RegExp(workflowLabels.display) });
    await userEvent.click(displayTrigger);
    const displayPanel = await screen.findByRole('dialog', { name: workflowLabels.display });
    const densityGroup = within(displayPanel).getByRole('group', { name: workflowLabels.density });
    await userEvent.click(within(densityGroup).getByRole('button', { name: workflowLabels.large }));
    await expect(canvas.getByTestId('toolbar-density')).toHaveTextContent('large');

    const mainPicker = displayPanel.querySelector<HTMLElement>('[data-shelf-column-picker]');
    const peerPicker = canvasElement.querySelector<HTMLElement>('[data-shelf-column-picker]');
    if (!mainPicker || !peerPicker) throw new Error('Both controlled shelf column pickers must be mounted');
    const mainStartOrder = canvas.getByTestId('main-column-order').textContent;
    const peerStartOrder = canvas.getByTestId('peer-column-order').textContent;
    const writesBeforeCrossHits = canvas.getByTestId('main-column-writes').textContent;
    const peerWritesBeforeCrossHits = canvas.getByTestId('peer-column-writes').textContent;
    await userEvent.click(within(displayPanel).getByRole('button', { name: 'Rerender independent parent' }));
    await expect(canvas.getByTestId('main-column-order')).toHaveTextContent(mainStartOrder ?? '');
    await expect(canvas.getByTestId('peer-column-order')).toHaveTextContent(peerStartOrder ?? '');
    await expect(canvas.getByTestId('peer-column-writes')).toHaveTextContent(peerWritesBeforeCrossHits ?? '');
    const mainTitle = mainPicker.querySelector<HTMLElement>('[data-column-id="title"]');
    const mainTitleHandle = mainTitle?.querySelector<HTMLElement>('span');
    const peerTitle = peerPicker.querySelector<HTMLElement>('[data-column-id="title"]');
    const peerTitleHandle = peerTitle?.querySelector<HTMLElement>('span');
    const mainCover = mainPicker.querySelector<HTMLElement>('[data-column-id="cover"]');
    const mainCoverHandle = mainCover?.querySelector<HTMLElement>('span');
    const peerCover = peerPicker.querySelector<HTMLElement>('[data-column-id="cover"]');
    const peerCoverHandle = peerCover?.querySelector<HTMLElement>('span');
    if (
      !mainTitle ||
      !mainTitleHandle ||
      !peerTitle ||
      !peerTitleHandle ||
      !mainCover ||
      !mainCoverHandle ||
      !peerCover ||
      !peerCoverHandle
    )
      throw new Error('The same default column IDs must appear in both mounted pickers');

    const HTMLElementConstructor = browser.HTMLElement;
    const pointerPrototype = HTMLElementConstructor.prototype;
    const captureDescriptor = Object.getOwnPropertyDescriptor(pointerPrototype, 'setPointerCapture');
    const hasCaptureDescriptor = Object.getOwnPropertyDescriptor(pointerPrototype, 'hasPointerCapture');
    const pointDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    const captures = new WeakMap<HTMLElement, Set<number>>();
    Object.defineProperty(pointerPrototype, 'setPointerCapture', {
      configurable: true,
      value(this: HTMLElement, pointerId: number) {
        const current = captures.get(this) ?? new Set<number>();
        current.add(pointerId);
        captures.set(this, current);
      },
    });
    Object.defineProperty(pointerPrototype, 'hasPointerCapture', {
      configurable: true,
      value(this: HTMLElement, pointerId: number) {
        return captures.get(this)?.has(pointerId) ?? false;
      },
    });
    const pointAt = (target: HTMLElement) =>
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
    const pointerEventNames = {
      pointerDown: 'pointerdown',
      pointerUp: 'pointerup',
      pointerCancel: 'pointercancel',
      lostPointerCapture: 'lostpointercapture',
    } as const;
    const dispatchPointer = async (type: keyof typeof pointerEventNames, target: HTMLElement, pointerId: number) => {
      target.dispatchEvent(
        new browser.PointerEvent(pointerEventNames[type], {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          button: 0,
          clientX: 20,
          clientY: 20,
        }),
      );
    };
    const touch = async (source: HTMLElement, pointerId: number, destination: HTMLElement) => {
      pointAt(destination);
      await dispatchPointer('pointerDown', source, pointerId);
      await dispatchPointer('pointerUp', source, pointerId);
    };

    try {
      pointAt(peerTitle);
      await dispatchPointer('pointerDown', mainCoverHandle, 301);
      await dispatchPointer('pointerUp', mainCoverHandle, 301);
      pointAt(mainTitle);
      await dispatchPointer('pointerDown', peerCoverHandle, 302);
      await dispatchPointer('pointerUp', peerCoverHandle, 302);
      await expect(canvas.getByTestId('main-column-order')).toHaveTextContent(mainStartOrder ?? '');
      await expect(canvas.getByTestId('peer-column-order')).toHaveTextContent(peerStartOrder ?? '');
      await expect(canvas.getByTestId('main-column-writes')).toHaveTextContent(writesBeforeCrossHits ?? '');
      await expect(canvas.getByTestId('peer-column-writes')).toHaveTextContent(peerWritesBeforeCrossHits ?? '');

      const creatorItem = mainPicker.querySelector<HTMLElement>('[data-column-id="creator"]');
      if (!creatorItem) throw new Error('The default hidden Creator column must be available');
      await expect(within(displayPanel).getByRole('heading', { name: 'Hidden columns' })).toBeVisible();
      await expect(within(table).queryByRole('columnheader', { name: 'Creator' })).not.toBeInTheDocument();
      await expect(within(creatorItem).getByRole('button', { name: 'Move up Creator' })).toBeDisabled();
      const lastHidden = mainPicker.querySelector<HTMLElement>('[data-column-id="finished"]');
      if (!lastHidden) throw new Error('The final hidden column must remain in the picker');
      await expect(within(lastHidden).getByRole('button', { name: 'Move down Finished' })).toBeDisabled();
      await userEvent.click(within(creatorItem).getByRole('button', { name: 'Show' }));
      await expect(within(table).getByRole('columnheader', { name: 'Creator' })).toBeVisible();
      const visibleCover = mainPicker.querySelector<HTMLElement>('[data-column-id="cover"]');
      if (!visibleCover) throw new Error('The first visible column must remain in the picker');
      await expect(within(visibleCover).getByRole('button', { name: 'Move up Cover' })).toBeDisabled();
      const visibleTitle = mainPicker.querySelector<HTMLElement>('[data-column-id="title"]');
      if (!visibleTitle) throw new Error('Title must remain in the picker');
      const moveDownTitle = within(visibleTitle).getByRole('button', { name: 'Move down Title' });
      moveDownTitle.focus();
      await userEvent.keyboard('{Enter}');
      const keyboardOrder = within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent?.trim())
        .filter(Boolean);
      await expect(keyboardOrder.indexOf('Type')).toBeLessThan(keyboardOrder.indexOf('Title'));

      const addedCreator = mainPicker.querySelector<HTMLElement>('[data-column-id="creator"]');
      if (!addedCreator) throw new Error('Creator must remain available after showing');
      await userEvent.click(within(addedCreator).getByRole('button', { name: 'Hide' }));
      await expect(within(table).queryByRole('columnheader', { name: 'Creator' })).not.toBeInTheDocument();

      const dragSource = mainPicker.querySelector<HTMLElement>('[data-column-id="type"]');
      const dragTarget = mainPicker.querySelector<HTMLElement>('[data-column-id="status"]');
      const hiddenDragTarget = mainPicker.querySelector<HTMLElement>('[data-column-id="creator"]');
      if (!dragSource || !dragTarget || !hiddenDragTarget)
        throw new Error('Drag source and grouped targets must exist');
      const boundaryTransfer = new DataTransfer();
      const beforeDragWrites = Number(canvas.getByTestId('main-column-writes').textContent);
      await fireEvent.dragStart(dragSource, { dataTransfer: boundaryTransfer });
      await fireEvent.drop(hiddenDragTarget, { dataTransfer: boundaryTransfer });
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeDragWrites);

      const transfer = new DataTransfer();
      const newerTransfer = new DataTransfer();
      await fireEvent.dragStart(dragSource, { dataTransfer: transfer });
      await fireEvent.dragStart(dragSource, { dataTransfer: newerTransfer });
      await fireEvent.dragEnd(dragSource, { dataTransfer: transfer });
      await fireEvent.drop(dragTarget, { dataTransfer: transfer });
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeDragWrites);
      await fireEvent.dragOver(dragTarget, { dataTransfer: newerTransfer });
      await fireEvent.drop(dragTarget, { dataTransfer: newerTransfer });
      await fireEvent.dragEnd(dragSource, { dataTransfer: newerTransfer });
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeDragWrites + 1);
      await expect(
        within(table)
          .getAllByRole('columnheader')
          .filter((head) => head.textContent)
          .map((head) => head.textContent?.trim()),
      ).toContain('Status');

      const afterDragOrder = canvas.getByTestId('main-column-order').textContent;
      const beforeWrongPointer = Number(canvas.getByTestId('main-column-writes').textContent);
      const touchSourceItem = mainPicker.querySelector<HTMLElement>('[data-column-id="status"]');
      const touchTargetItem = mainPicker.querySelector<HTMLElement>('[data-column-id="type"]');
      const touchSource = touchSourceItem?.querySelector<HTMLElement>('span');
      if (!touchSourceItem || !touchTargetItem || !touchSource) throw new Error('Touch columns must remain available');
      pointAt(touchTargetItem);
      await dispatchPointer('pointerDown', touchSource, 401);
      await dispatchPointer('pointerUp', touchSource, 402);
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeWrongPointer);
      await dispatchPointer('pointerUp', touchSource, 401);
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeWrongPointer + 1);
      await expect(canvas.getByTestId('main-column-order').textContent).not.toBe(afterDragOrder);

      const beforeRetarget = Number(canvas.getByTestId('main-column-writes').textContent);
      const retargetSourceItem = mainPicker.querySelector<HTMLElement>('[data-column-id="cover"]');
      const retargetSource = retargetSourceItem?.querySelector<HTMLElement>('span');
      if (!retargetSource) throw new Error('Cover must remain available for replacement checks');
      await dispatchPointer('pointerDown', retargetSource, 501);
      await userEvent.click(within(displayPanel).getByRole('button', { name: 'Replace schema B' }));
      await userEvent.click(within(displayPanel).getByRole('button', { name: 'Restore schema A' }));
      pointAt(mainPicker.querySelector<HTMLElement>('[data-column-id="title"]')!);
      await dispatchPointer('pointerUp', retargetSource, 501);
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeRetarget);

      await dispatchPointer('pointerDown', retargetSource, 502);
      await userEvent.click(within(displayPanel).getByRole('button', { name: 'Remove Creator' }));
      await dispatchPointer('pointerUp', retargetSource, 502);
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeRetarget);
      await userEvent.click(within(displayPanel).getByRole('button', { name: 'Restore schema A' }));

      const beforeEqualAllocation = Number(canvas.getByTestId('main-column-writes').textContent);
      const equalSourceItem = mainPicker.querySelector<HTMLElement>('[data-column-id="cover"]');
      const equalSource = equalSourceItem?.querySelector<HTMLElement>('span');
      const equalTarget = mainPicker.querySelector<HTMLElement>('[data-column-id="title"]');
      if (!equalSource || !equalTarget) throw new Error('Equal allocation drag targets must be available');
      pointAt(equalTarget);
      await dispatchPointer('pointerDown', equalSource, 601);
      await userEvent.click(within(displayPanel).getByRole('button', { name: 'Refresh equal column labels' }));
      await dispatchPointer('pointerUp', equalSource, 601);
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeEqualAllocation + 1);
      await expect(canvas.getByTestId('main-column-order')).toHaveTextContent('title,cover');
      await expect(mainPicker).toHaveTextContent('Revised Title');
      await expect(canvas.getByTestId('column-input-preserved')).toHaveTextContent('true');

      const beforeCallbackChange = Number(canvas.getByTestId('main-column-writes').textContent);
      const callbackSourceItem = mainPicker.querySelector<HTMLElement>('[data-column-id="type"]');
      const callbackSource = callbackSourceItem?.querySelector<HTMLElement>('span');
      const callbackTarget = mainPicker.querySelector<HTMLElement>('[data-column-id="status"]');
      if (!callbackSource || !callbackTarget) throw new Error('Callback refresh targets must be available');
      pointAt(callbackTarget);
      await dispatchPointer('pointerDown', callbackSource, 602);
      await userEvent.click(within(displayPanel).getByRole('button', { name: 'Reallocate callback' }));
      await dispatchPointer('pointerUp', callbackSource, 602);
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeCallbackChange + 1);
      await expect(canvas.getByTestId('last-column-writer')).toHaveTextContent('1');

      const beforeOldCancel = Number(canvas.getByTestId('main-column-writes').textContent);
      const overlapItem = mainPicker.querySelector<HTMLElement>('[data-column-id="cover"]');
      const overlapSource = overlapItem?.querySelector<HTMLElement>('span');
      const overlapTarget = mainPicker.querySelector<HTMLElement>('[data-column-id="type"]');
      if (!overlapSource || !overlapTarget) throw new Error('Overlapping touch targets must be available');
      pointAt(overlapTarget);
      await dispatchPointer('pointerDown', overlapSource, 701);
      await dispatchPointer('pointerDown', overlapSource, 702);
      await dispatchPointer('pointerCancel', overlapSource, 701);
      await dispatchPointer('pointerUp', overlapSource, 701);
      await dispatchPointer('pointerUp', overlapSource, 702);
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeOldCancel + 1);

      const beforeLostCapture = Number(canvas.getByTestId('main-column-writes').textContent);
      const lostItem = mainPicker.querySelector<HTMLElement>('[data-column-id="title"]');
      const lostSource = lostItem?.querySelector<HTMLElement>('span');
      const lostTarget = mainPicker.querySelector<HTMLElement>('[data-column-id="status"]');
      if (!lostSource || !lostTarget) throw new Error('Lost capture targets must be available');
      pointAt(lostTarget);
      await dispatchPointer('pointerDown', lostSource, 801);
      captures.get(lostSource)?.delete(801);
      await dispatchPointer('lostPointerCapture', lostSource, 801);
      await dispatchPointer('pointerUp', lostSource, 801);
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeLostCapture);
      await touch(lostSource, 802, lostTarget);
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeLostCapture + 1);

      const beforeUnmount = Number(canvas.getByTestId('main-column-writes').textContent);
      const unmountItem = mainPicker.querySelector<HTMLElement>('[data-column-id="cover"]');
      const unmountSource = unmountItem?.querySelector<HTMLElement>('span');
      if (!unmountSource) throw new Error('A source handle must exist before unmount');
      await dispatchPointer('pointerDown', unmountSource, 901);
      await userEvent.click(within(displayPanel).getByRole('button', { name: 'Unmount main picker' }));
      await userEvent.click(within(displayPanel).getByRole('button', { name: 'Mount main picker' }));
      const freshMainPicker = displayPanel.querySelector<HTMLElement>('[data-shelf-column-picker]');
      const freshTarget = freshMainPicker?.querySelector<HTMLElement>('[data-column-id="title"]');
      if (!freshMainPicker || !freshTarget) throw new Error('A fresh picker visit must mount after unmount');
      pointAt(freshTarget);
      await dispatchPointer('pointerUp', unmountSource, 901);
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeUnmount);
      const freshSourceItem = freshMainPicker.querySelector<HTMLElement>('[data-column-id="cover"]');
      const freshSource = freshSourceItem?.querySelector<HTMLElement>('span');
      if (!freshSource) throw new Error('A fresh touch handle must exist');
      await touch(freshSource, 902, freshTarget);
      await expect(Number(canvas.getByTestId('main-column-writes').textContent)).toBe(beforeUnmount + 1);

      await expect(workflow.scrollWidth).toBeLessThanOrEqual(workflow.clientWidth);
      await expect(browser.innerWidth).toBeGreaterThanOrEqual(768);
    } finally {
      if (captureDescriptor) Object.defineProperty(pointerPrototype, 'setPointerCapture', captureDescriptor);
      else Reflect.deleteProperty(pointerPrototype, 'setPointerCapture');
      if (hasCaptureDescriptor) Object.defineProperty(pointerPrototype, 'hasPointerCapture', hasCaptureDescriptor);
      else Reflect.deleteProperty(pointerPrototype, 'hasPointerCapture');
      if (pointDescriptor) Object.defineProperty(document, 'elementFromPoint', pointDescriptor);
      else Reflect.deleteProperty(document, 'elementFromPoint');
    }
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
