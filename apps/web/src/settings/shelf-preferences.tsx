import { useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { shelfColumnLabel } from '../library/shelf-columns';
import { shelfColumnIds, type PersonalShelfColumnId } from '../library/shelf-params';
import {
  libraryOrderFromShelf,
  shelfOrderFromLibrary,
  unsupportedShelfColumns,
  unsupportedShelfSorts,
} from '../library/shelf-preferences';
import type { ReadingIO } from './reading-preferences';
import {
  ownerMayChangeShelf,
  shelfPreferenceColumns,
  shelfPreferenceSortFields,
  shelfPreferenceTabs,
  type NativePreferenceFailure,
  type PreferenceChange,
  type ReadingAdvice,
  type ReadingPreferences,
  type ShelfAdvice,
  type ShelfPreferencePatch,
  type ShelfPreferenceSort,
  type ShelfPreferenceTab,
  type ShelfPreferences,
} from './preferences';
import { useSettingsCurrent, useSettingsReadCurrent, useSettingsSessionOwner } from './settings-session-owner';
import { ShelfTypeDefaults } from './shelf-type-defaults/editor';
import type { ShelfTypesCurrentRead } from '../library/shelf-types-read';

const personalColumn = {
  cover: 'cover',
  title: 'title',
  creator: undefined,
  type: 'type',
  status: 'status',
  progress: 'progress',
  rating: undefined,
  added: 'added',
  started: undefined,
  finished: 'finished',
  last_activity: 'lastActivity',
} as const satisfies Record<(typeof shelfPreferenceColumns)[number], PersonalShelfColumnId | undefined>;

const appColumns = [...shelfColumnIds];
const tabs = [...shelfPreferenceTabs];
const fields = [...shelfPreferenceSortFields];
const defaultSortChoice = '__default';
const uuid = () => crypto.randomUUID();

type ShelfDraft = {
  layout: 'grid' | 'list' | 'table';
  layouts: NonNullable<ShelfPreferences['layouts']>;
  gridSize: 'small' | 'medium' | 'large';
  columns: PersonalShelfColumnId[];
  sorts: Record<ShelfPreferenceTab, string>;
};
type Pending = {
  input: Readonly<PreferenceChange>;
  draft: ShelfDraft;
  dirty: Set<string>;
  reset: boolean;
};
type ShelfState = {
  known: { shelf: ShelfPreferences; version: number };
  advice: ReadingAdvice | undefined;
  draft: ShelfDraft;
  dirty: Set<string>;
  pending: Pending | null;
  phase: 'idle' | 'saving' | 'saved' | 'uncertain' | 'conflict' | 'reloading' | 'review' | 'failed';
  reason: string | undefined;
  failure: NativePreferenceFailure | undefined;
};
type ShelfOwner = {
  canRead: () => boolean;
  canWrite: () => boolean;
  version: () => number;
  onVersionChange: (version: number) => void;
};

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function draftFrom(shelf: ShelfPreferences): ShelfDraft {
  const columns = shelf.tableColumns
    ? shelf.tableColumns.flatMap((column) => {
        const mapped = personalColumn[column];
        return mapped ? [mapped] : [];
      })
    : appColumns;
  const selected = new Set<PersonalShelfColumnId>(['title', ...columns]);
  const sorts = Object.fromEntries(
    tabs.map((tab) => {
      const stored = shelf.sorts?.[tab];
      const order = libraryOrderFromShelf(stored);
      return [
        tab,
        order && order.orderBy !== 'personalScore'
          ? `${shelfOrderFromLibrary(order).field}:${order.direction}`
          : stored
            ? `unsupported:${stored.field}`
            : defaultSortChoice,
      ];
    }),
  ) as Record<ShelfPreferenceTab, string>;
  return {
    layout: shelf.layouts?.all ?? 'grid',
    layouts: { ...shelf.layouts },
    gridSize: shelf.gridSize ?? 'medium',
    columns: appColumns.filter((column) => selected.has(column)),
    sorts,
  };
}

/** Refresh clean fields while preserving only the person's explicit edits. */
function rebaseDraft(shelf: ShelfPreferences, draft: ShelfDraft, dirty: Set<string>): ShelfDraft {
  const next = draftFrom(shelf);
  if (dirty.has('layout')) next.layout = draft.layout;
  if (dirty.has('gridSize')) next.gridSize = draft.gridSize;
  if (dirty.has('columns')) next.columns = draft.columns;
  for (const tab of tabs) if (dirty.has(`sort:${tab}`)) next.sorts[tab] = draft.sorts[tab];
  for (const key of dirty) {
    if (!key.startsWith('layout:')) continue;
    const scope = key.slice(7);
    delete next.layouts[scope];
    if (draft.layouts[scope]) next.layouts[scope] = draft.layouts[scope];
  }
  return next;
}

function nativeColumnList(
  shelf: ShelfPreferences,
  selected: PersonalShelfColumnId[],
): NonNullable<ShelfPreferences['tableColumns']> {
  const chosen = new Set<PersonalShelfColumnId>(['title', ...selected]);
  const existing = shelf.tableColumns ?? [];
  const retained = existing.filter((column) => {
    const mapped = personalColumn[column];
    return mapped ? chosen.has(mapped) : true;
  });
  const present = new Set(retained);
  const additions = shelfPreferenceColumns.filter((column) => {
    const mapped = personalColumn[column];
    return mapped !== undefined && chosen.has(mapped) && !present.has(column);
  });
  return [...retained, ...additions];
}

function patchFor(shelf: ShelfPreferences, draft: ShelfDraft, dirty: Set<string>): ShelfPreferencePatch {
  const patch: ShelfPreferencePatch = {};
  const layouts: NonNullable<ShelfPreferencePatch['layouts']> = {};
  if (dirty.has('layout') && shelf.layouts?.all !== draft.layout) layouts.all = draft.layout;
  for (const key of dirty) {
    if (!key.startsWith('layout:')) continue;
    const scope = key.slice(7);
    if (shelf.layouts?.[scope] !== draft.layouts[scope]) layouts[scope] = draft.layouts[scope] ?? null;
  }
  if (Object.keys(layouts).length) patch.layouts = layouts;
  if (dirty.has('gridSize') && shelf.gridSize !== draft.gridSize) patch.gridSize = draft.gridSize;
  if (dirty.has('columns')) {
    const columns = nativeColumnList(shelf, draft.columns);
    if (columns.length && !same(columns, shelf.tableColumns)) patch.tableColumns = columns;
  }
  const sorts: NonNullable<ShelfPreferencePatch['sorts']> = {};
  for (const tab of tabs) {
    if (!dirty.has(`sort:${tab}`)) continue;
    const choice = draft.sorts[tab];
    if (choice.startsWith('unsupported:')) continue;
    const stored = shelf.sorts?.[tab];
    if (choice === defaultSortChoice) {
      if (stored) sorts[tab] = null;
      continue;
    }
    const [field, direction] = choice.split(':');
    if (
      fields.includes(field as never) &&
      (direction === 'asc' || direction === 'desc') &&
      !same(stored, { field, direction })
    )
      sorts[tab] = { field: field as ShelfPreferenceSort['field'], direction };
  }
  if (Object.keys(sorts).length) patch.sorts = sorts;
  return patch;
}

function pagePreferences(page: Awaited<ReturnType<ReadingIO['read']>>) {
  return page.signedIn && 'preferences' in page ? page.preferences : undefined;
}

function executableSorts(supported: ShelfAdvice['supported'] | undefined) {
  return (['last_activity', 'added', 'finished'] as const).filter((field) => supported?.sortFields.includes(field));
}

function choiceAdmitted(draft: ShelfDraft, advice: ReadingAdvice | undefined): boolean {
  const supported = advice?.shelfAdvice?.supported;
  if (!supported) return false;
  if (!supported.layouts.includes(draft.layout) || !supported.gridSizes.includes(draft.gridSize)) return false;
  for (const layout of Object.values(draft.layouts)) if (layout && !supported.layouts.includes(layout)) return false;
  for (const choice of Object.values(draft.sorts)) {
    if (choice === defaultSortChoice || choice.startsWith('unsupported:')) continue;
    const [field, direction] = choice.split(':');
    if (
      !supported.sortFields.includes(field as ShelfPreferenceSort['field']) ||
      !supported.sortDirections.includes(direction as 'asc' | 'desc')
    )
      return false;
  }
  return true;
}

/** Versioned shelf editor: drafts stay local until save, and uncertain writes retain their exact command. */
export class ShelfPreferenceDraftRecovery {
  private state: ShelfState;
  private listeners = new Set<() => void>();

  constructor(
    initial: ReadingPreferences,
    private io: ReadingIO,
    private owner: ShelfOwner,
  ) {
    const shelf = initial.shelf ?? {};
    this.state = {
      known: { shelf, version: initial.version },
      advice: initial.advice,
      draft: draftFrom(shelf),
      dirty: new Set(),
      pending: null,
      phase: 'idle',
      reason: undefined,
      failure: undefined,
    };
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<ShelfState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private writable() {
    return this.owner.canWrite() && ownerMayChangeShelf(this.state.advice);
  }

  edit(next: Partial<ShelfDraft>, dirtyKey: string) {
    if (!this.writable()) return;
    this.update({
      draft: { ...this.state.draft, ...next },
      dirty: new Set([...this.state.dirty, dirtyKey]),
      phase: this.state.phase === 'saved' ? 'idle' : this.state.phase,
    });
  }

  editSort(tab: ShelfPreferenceTab, choice: string) {
    if (!this.writable()) return;
    this.update({
      draft: { ...this.state.draft, sorts: { ...this.state.draft.sorts, [tab]: choice } },
      dirty: new Set([...this.state.dirty, `sort:${tab}`]),
      phase: this.state.phase === 'saved' ? 'idle' : this.state.phase,
    });
  }

  editTypeLayout(scope: string, layout: ShelfDraft['layout'] | undefined) {
    const limits = this.state.advice?.shelfAdvice?.limits;
    if (
      !this.writable() ||
      !limits ||
      scope === 'all' ||
      scope.length > limits.scopeMaxLength ||
      !new RegExp(limits.scopePattern).test(scope)
    )
      return;
    const layouts = { ...this.state.draft.layouts };
    delete layouts[scope];
    if (layout) layouts[scope] = layout;
    this.edit({ layouts }, `layout:${scope}`);
  }

  private async send(recovering: boolean) {
    const pending = this.state.pending;
    if (!pending || !this.writable()) return;
    this.update({ phase: 'saving', reason: undefined, failure: undefined });
    let result;
    try {
      result = await this.io.save(pending.input);
    } catch {
      result = { ok: false as const, reason: 'unavailable' as const };
    }
    if (!this.owner.canWrite()) return;
    if (!result.ok) {
      const uncertain =
        result.reason === 'unavailable' ||
        result.reason === 'preparing' ||
        (recovering && result.reason !== 'conflict');
      this.update({
        pending: uncertain ? pending : null,
        phase: uncertain ? 'uncertain' : result.reason === 'conflict' ? 'conflict' : 'failed',
        reason: result.reason,
        ...(result.failure ? { failure: result.failure } : {}),
      });
      return;
    }
    const receipt = result.preferences;
    const requested = pending.input.shelf;
    const written = receipt.shelf ?? {};
    const matches =
      requested === null
        ? !Object.keys(written).length
        : (!requested?.layouts ||
            Object.entries(requested.layouts).every(([scope, layout]) =>
              layout === null ? written.layouts?.[scope] === undefined : written.layouts?.[scope] === layout,
            )) &&
          (!requested?.sorts ||
            Object.entries(requested.sorts).every(([tab, sort]) =>
              sort === null
                ? written.sorts?.[tab as ShelfPreferenceTab] === undefined
                : same(written.sorts?.[tab as ShelfPreferenceTab], sort),
            )) &&
          (requested?.gridSize === undefined || written.gridSize === requested.gridSize) &&
          (requested?.tableColumns === undefined || same(written.tableColumns, requested.tableColumns));
    if (!matches || receipt.version < pending.input.expectedVersion) {
      this.update({ phase: 'uncertain', reason: 'unavailable', pending });
      return;
    }
    let current = receipt;
    if (recovering || this.owner.version() > receipt.version) {
      if (!this.owner.canRead()) return;
      try {
        const refreshed = pagePreferences(await this.io.read());
        if (
          !this.owner.canRead() ||
          !refreshed ||
          refreshed.version < Math.max(receipt.version, this.owner.version())
        ) {
          this.update({ phase: 'uncertain', reason: 'unavailable', pending });
          return;
        }
        if (refreshed.version === receipt.version && !same(refreshed.shelf ?? {}, receipt.shelf ?? {})) {
          this.update({ phase: 'uncertain', reason: 'unavailable', pending });
          return;
        }
        current = refreshed;
      } catch {
        if (this.owner.canRead()) this.update({ phase: 'uncertain', reason: 'unavailable', pending });
        return;
      }
    }
    if (!this.owner.canWrite()) return;
    const shelf = current.shelf ?? {};
    const remainingDirty = new Set(
      [...this.state.dirty].filter((key) => {
        if (pending.reset && pending.dirty.size > 0) return true;
        if (key.startsWith('layout:')) {
          const scope = key.slice(7);
          return this.state.draft.layouts[scope] !== pending.draft.layouts[scope];
        }
        if (key.startsWith('sort:')) {
          const tab = key.slice(5) as ShelfPreferenceTab;
          return this.state.draft.sorts[tab] !== pending.draft.sorts[tab];
        }
        return key === 'layout'
          ? this.state.draft.layout !== pending.draft.layout
          : key === 'gridSize'
            ? this.state.draft.gridSize !== pending.draft.gridSize
            : key === 'columns' && !same(this.state.draft.columns, pending.draft.columns);
      }),
    );
    const changedWhileSaving = remainingDirty.size > 0;
    const resetDraft = rebaseDraft(shelf, this.state.draft, remainingDirty);
    const needsReview =
      changedWhileSaving ||
      (pending.reset && pending.dirty.size > 0) ||
      (remainingDirty.size > 0 && !choiceAdmitted(resetDraft, current.advice));
    this.update({
      known: { shelf, version: current.version },
      advice: current.advice,
      draft: resetDraft,
      dirty: remainingDirty,
      pending: null,
      phase: needsReview ? 'review' : 'saved',
      reason: undefined,
      failure: undefined,
    });
    this.owner.onVersionChange(Math.max(this.owner.version(), current.version));
  }

  async submit(reset = false) {
    if (!this.writable() || this.state.pending || this.state.phase === 'reloading') return;
    if (this.owner.version() > this.state.known.version) {
      this.update({ phase: 'conflict', reason: 'conflict', failure: undefined });
      return;
    }
    const shelf = reset ? null : patchFor(this.state.known.shelf, this.state.draft, this.state.dirty);
    if (shelf?.layouts) {
      const maxLayouts = this.state.advice?.shelfAdvice?.limits.maxLayouts ?? 0;
      const merged = { ...this.state.known.shelf.layouts, ...shelf.layouts };
      if (
        Object.keys(shelf.layouts).length > maxLayouts ||
        Object.values(merged).filter((value) => value !== null).length > maxLayouts
      ) {
        this.update({ phase: 'failed', reason: 'invalid' });
        return;
      }
    }
    if (!reset && shelf && !Object.keys(shelf).length) {
      this.update({ phase: 'saved' });
      return;
    }
    const pending: Pending = {
      input: { expectedVersion: this.state.known.version, shelf, idempotencyKey: uuid() },
      draft: this.state.draft,
      dirty: new Set(this.state.dirty),
      reset,
    };
    this.update({ pending, phase: 'saving', reason: undefined, failure: undefined });
    await this.send(false);
  }

  async retry() {
    if (this.state.phase !== 'uncertain' || !this.state.pending || !this.writable()) return;
    await this.send(true);
  }

  async reload() {
    if (!this.owner.canRead() || this.state.phase === 'saving' || this.state.phase === 'reloading') return;
    this.update({ phase: 'reloading', reason: undefined, failure: undefined });
    try {
      const current = pagePreferences(await this.io.read());
      if (!this.owner.canRead()) return;
      if (!current || current.version < Math.max(this.state.known.version, this.owner.version())) {
        this.update({ phase: this.state.pending ? 'uncertain' : 'failed', reason: 'unavailable' });
        return;
      }
      const shelf = current.shelf ?? {};
      const draft = rebaseDraft(shelf, this.state.draft, this.state.dirty);
      this.update({
        known: { shelf, version: current.version },
        advice: current.advice,
        draft,
        phase: this.state.pending
          ? 'uncertain'
          : this.state.dirty.size > 0 || !choiceAdmitted(draft, current.advice)
            ? 'review'
            : 'idle',
      });
      this.owner.onVersionChange(Math.max(this.owner.version(), current.version));
    } catch {
      if (this.owner.canRead())
        this.update({ phase: this.state.pending ? 'uncertain' : 'failed', reason: 'unavailable' });
    }
  }

  useCurrent() {
    if (!this.owner.canRead() || this.state.pending || this.state.phase !== 'review') return;
    this.update({
      draft: draftFrom(this.state.known.shelf),
      dirty: new Set(),
      phase: 'idle',
      reason: undefined,
      failure: undefined,
    });
  }
}

function layoutName(layout: string) {
  return layout === 'grid'
    ? m.library_layout_grid()
    : layout === 'list'
      ? m.library_layout_list()
      : layout === 'table'
        ? m.library_layout_table()
        : layout;
}

function tabLabel(tab: ShelfPreferenceTab): string {
  switch (tab) {
    case 'in_progress':
      return m.library_state_in_progress();
    case 'planned':
      return m.library_state_planned();
    case 'completed':
      return m.library_state_completed();
    case 'paused':
      return m.library_state_paused();
    case 'dropped':
      return m.library_state_dropped();
    case 'all':
      return m.library_state_all();
  }
}

function sortLabel(field: string, direction: 'asc' | 'desc') {
  const fieldLabel =
    field === 'last_activity'
      ? m.library_sort_activity()
      : field === 'added'
        ? m.library_sort_created()
        : field === 'finished'
          ? m.library_sort_finished()
          : field.replaceAll('_', ' ');
  return `${fieldLabel} · ${direction === 'desc' ? m.library_sort_newest() : m.library_sort_oldest()}`;
}

function failureText(phase: ShelfState['phase']) {
  return phase === 'conflict'
    ? m.settings_shelf_conflict()
    : phase === 'uncertain'
      ? m.settings_shelf_uncertain()
      : phase === 'review'
        ? m.settings_shelf_review()
        : m.settings_shelf_failed();
}

export function ShelfPreferencesCard({
  initial,
  version,
  csrfToken,
  io,
  onVersionChange,
  readTypes,
}: {
  initial: ReadingPreferences;
  version: number;
  csrfToken: string | null;
  io: ReadingIO;
  onVersionChange: (version: number) => void;
  readTypes?: (cursor?: string) => Promise<ShelfTypesCurrentRead>;
}) {
  const writeCurrent = useSettingsCurrent(csrfToken, !!io);
  const readCurrent = useSettingsReadCurrent(csrfToken, !!io);
  const sessionOwner = useSettingsSessionOwner(csrfToken);
  const canRead = readCurrent();
  const ownerRef = useRef({ version, writeCurrent, readCurrent, onVersionChange });
  ownerRef.current = { version, writeCurrent, readCurrent, onVersionChange };
  const [controller] = useState(
    () =>
      new ShelfPreferenceDraftRecovery(initial, io, {
        canRead: () => ownerRef.current.readCurrent(),
        canWrite: () => ownerRef.current.writeCurrent(),
        version: () => ownerRef.current.version,
        onVersionChange: (next) => ownerRef.current.onVersionChange(next),
      }),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const advice = state.advice;
  const shelfAdvice = advice?.shelfAdvice;
  const ownerMayChange = ownerMayChangeShelf(advice);
  const canWrite = writeCurrent() && ownerMayChange;
  const disabled = !canWrite || state.phase === 'saving' || state.phase === 'reloading';
  const unavailableColumns = unsupportedShelfColumns(state.known.shelf);
  const unavailableSorts = unsupportedShelfSorts(state.known.shelf);
  const inputId = 'shelf-default-columns';
  const showFailure = ['failed', 'conflict', 'uncertain', 'review'].includes(state.phase);
  const waiting = state.phase === 'saving' || state.phase === 'reloading';
  const offeredLayouts = shelfAdvice?.supported.layouts ?? [];
  const offeredSizes = shelfAdvice?.supported.gridSizes ?? [];
  const offeredSorts = executableSorts(shelfAdvice?.supported);
  const maxLayouts = shelfAdvice?.limits.maxLayouts ?? 0;

  if (!canRead) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id="settings-shelf-heading">{m.settings_shelf_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_shelf_text()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {unavailableColumns.length ? (
          <p className="text-sm text-muted-foreground">
            {m.settings_shelf_columns_unavailable({ columns: unavailableColumns.join(', ') })}
          </p>
        ) : null}
        {unavailableSorts.map(({ tab, field }) => (
          <p key={tab} className="text-sm text-muted-foreground">
            {m.settings_shelf_order_unavailable({ tab: tabLabel(tab), field })}
          </p>
        ))}
        {!shelfAdvice ? (
          <Alert>
            <AlertTitle>{m.settings_shelf_choices_unavailable_title()}</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{m.settings_shelf_choices_unavailable_text()}</p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={!canRead || waiting}
                onClick={() => void controller.reload()}
              >
                {m.settings_shelf_reload()}
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {ownerMayChange ? null : (
              <Alert>
                <AlertTitle>{m.settings_shelf_read_only_title()}</AlertTitle>
                <AlertDescription>{m.settings_shelf_read_only_text()}</AlertDescription>
              </Alert>
            )}
            <fieldset disabled={disabled} className="space-y-5">
              <label className="grid gap-1 text-sm">
                {m.settings_shelf_layout()}
                <span className="text-muted-foreground">
                  {state.known.shelf.layouts?.all
                    ? m.settings_shelf_saved({ value: layoutName(state.known.shelf.layouts.all) })
                    : m.settings_shelf_inherited()}
                </span>
                <select
                  className="min-h-11 max-w-full rounded-md border bg-background px-3 py-2"
                  value={state.draft.layout}
                  onChange={(event) =>
                    controller.edit({ layout: event.currentTarget.value as ShelfDraft['layout'] }, 'layout')
                  }
                >
                  {(offeredLayouts.includes(state.draft.layout)
                    ? offeredLayouts
                    : [state.draft.layout, ...offeredLayouts]
                  ).map((layout) => (
                    <option key={layout} value={layout}>
                      {layoutName(layout)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                {m.settings_shelf_size()}
                <span className="text-muted-foreground">
                  {state.known.shelf.gridSize
                    ? m.settings_shelf_saved({
                        value:
                          state.known.shelf.gridSize === 'small'
                            ? m.library_size_small()
                            : state.known.shelf.gridSize === 'large'
                              ? m.library_size_large()
                              : m.library_size_medium(),
                      })
                    : m.settings_shelf_inherited()}
                </span>
                <select
                  className="min-h-11 max-w-full rounded-md border bg-background px-3 py-2"
                  value={state.draft.gridSize}
                  onChange={(event) =>
                    controller.edit({ gridSize: event.currentTarget.value as ShelfDraft['gridSize'] }, 'gridSize')
                  }
                >
                  {(offeredSizes.includes(state.draft.gridSize)
                    ? offeredSizes
                    : [state.draft.gridSize, ...offeredSizes]
                  ).map((size) => (
                    <option key={size} value={size}>
                      {size === 'small'
                        ? m.library_size_small()
                        : size === 'large'
                          ? m.library_size_large()
                          : m.library_size_medium()}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{m.settings_shelf_columns()}</legend>
                <p className="text-sm text-muted-foreground">
                  {state.known.shelf.tableColumns ? m.settings_shelf_saved_choice() : m.settings_shelf_inherited()}
                </p>
                {appColumns.map((column) => (
                  <Field key={column} orientation="horizontal" className="min-h-11">
                    <Checkbox
                      id={`${inputId}-${column}`}
                      checked={state.draft.columns.includes(column)}
                      disabled={column === 'title'}
                      onCheckedChange={(checked) =>
                        controller.edit(
                          {
                            columns: appColumns.filter(
                              (item) =>
                                item === 'title' ||
                                (item === column ? checked === true : state.draft.columns.includes(item)),
                            ),
                          },
                          'columns',
                        )
                      }
                    />
                    <FieldLabel htmlFor={`${inputId}-${column}`}>
                      {column === 'lastActivity' ? m.library_sort_activity() : shelfColumnLabel(column)}
                    </FieldLabel>
                  </Field>
                ))}
              </fieldset>
              {tabs.map((tab) => {
                const current = state.draft.sorts[tab];
                return (
                  <label key={tab} className="grid gap-1 text-sm">
                    {m.settings_shelf_order({ tab: tabLabel(tab) })}
                    <span className="text-muted-foreground">
                      {state.known.shelf.sorts?.[tab] ? m.settings_shelf_saved_choice() : m.settings_shelf_inherited()}
                    </span>
                    <select
                      className="min-h-11 max-w-full rounded-md border bg-background px-3 py-2"
                      value={current}
                      onChange={(event) => controller.editSort(tab, event.currentTarget.value)}
                    >
                      {current.startsWith('unsupported:') ? (
                        <option value={current} disabled>
                          {m.settings_shelf_unavailable_option({
                            field:
                              state.known.shelf.sorts?.[tab]?.field === 'rating'
                                ? `${m.library_score_order()} · ${state.known.shelf.sorts[tab].direction === 'desc' ? m.library_score_highest() : m.library_score_lowest()}`
                                : current.slice('unsupported:'.length).replaceAll('_', ' '),
                          })}
                        </option>
                      ) : null}
                      <option value={defaultSortChoice}>{m.settings_shelf_order_application_default()}</option>
                      {offeredSorts.flatMap((field) =>
                        (['desc', 'asc'] as const)
                          .filter((direction) => shelfAdvice.supported.sortDirections.includes(direction))
                          .map((direction) => {
                            const choice = `${field}:${direction}`;
                            return (
                              <option key={choice} value={choice}>
                                {sortLabel(field, direction)}
                              </option>
                            );
                          }),
                      )}
                    </select>
                  </label>
                );
              })}
            </fieldset>
            <ShelfTypeDefaults
              key={JSON.stringify([sessionOwner?.subject, csrfToken, getLocale()])}
              layouts={{ ...state.draft.layouts, ...(state.dirty.has('layout') ? { all: state.draft.layout } : {}) }}
              globalLayout={state.draft.layout}
              savedLayouts={state.known.shelf.layouts ?? {}}
              disabled={disabled}
              subject={sessionOwner?.subject ?? null}
              isCurrent={readCurrent}
              maxLayouts={maxLayouts}
              scopeMaxLength={shelfAdvice.limits.scopeMaxLength}
              onChange={(scope, layout) => controller.editTypeLayout(scope, layout)}
              {...(readTypes ? { readTypes } : {})}
            />
          </>
        )}
        {showFailure ? (
          <Alert variant={state.phase === 'failed' ? 'destructive' : 'default'}>
            <AlertTitle>{failureText(state.phase)}</AlertTitle>
            <AlertDescription className="space-y-2">
              {state.failure?.requestId ? <p>{state.failure.requestId}</p> : null}
              {state.phase === 'uncertain' && state.pending ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={!canWrite}
                  onClick={() => void controller.retry()}
                >
                  {m.settings_shelf_retry()}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={!canRead || waiting}
                onClick={() => void controller.reload()}
              >
                {m.settings_shelf_reload()}
              </Button>
              {state.phase === 'review' ? (
                <Button type="button" variant="ghost" className="min-h-11" onClick={() => controller.useCurrent()}>
                  {m.settings_shelf_use_current()}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {state.phase === 'saved' ? <p role="status">{m.settings_saved()}</p> : null}
        {shelfAdvice ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              className="min-h-11 max-w-full whitespace-normal"
              disabled={disabled || !!state.pending || !state.dirty.size}
              onClick={() => void controller.submit()}
            >
              {m.settings_shelf_save()}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 max-w-full whitespace-normal"
              disabled={disabled || !!state.pending}
              onClick={() => void controller.submit(true)}
            >
              {m.settings_shelf_reset()}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
