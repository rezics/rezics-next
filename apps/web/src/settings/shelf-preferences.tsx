import { useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
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
  shelfPreferenceColumns,
  shelfPreferenceSortFields,
  shelfPreferenceTabs,
  type NativePreferenceFailure,
  type PreferenceChange,
  type ReadingPreferences,
  type ShelfPreferencePatch,
  type ShelfPreferenceSort,
  type ShelfPreferenceTab,
  type ShelfPreferences,
} from './preferences';
import { useSettingsCurrent, useSettingsReadCurrent } from './settings-session-owner';

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
  draft: ShelfDraft;
  dirty: Set<string>;
  pending: Pending | null;
  phase: 'idle' | 'saving' | 'saved' | 'uncertain' | 'conflict' | 'reloading' | 'review' | 'failed';
  reason?: string;
  failure?: NativePreferenceFailure;
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
      return [tab, order ? `${shelfOrderFromLibrary(order).field}:${order.direction}` : stored ? `unsupported:${stored.field}` : defaultSortChoice];
    }),
  ) as Record<ShelfPreferenceTab, string>;
  return {
    layout: shelf.layouts?.all ?? 'grid',
    gridSize: shelf.gridSize ?? 'medium',
    columns: appColumns.filter((column) => selected.has(column)),
    sorts,
  };
}

function nativeColumnList(shelf: ShelfPreferences, selected: PersonalShelfColumnId[]): ShelfPreferences['tableColumns'] {
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
  if (dirty.has('layout') && shelf.layouts?.all !== draft.layout) patch.layouts = { all: draft.layout };
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

/** Versioned shelf editor: drafts stay local until save, and uncertain writes retain their exact command. */
export class ShelfPreferenceDraftRecovery {
  private state: ShelfState;
  private listeners = new Set<() => void>();

  constructor(initial: ReadingPreferences, private io: ReadingIO, private owner: ShelfOwner) {
    const shelf = initial.shelf ?? {};
    this.state = {
      known: { shelf, version: initial.version },
      draft: draftFrom(shelf),
      dirty: new Set(),
      pending: null,
      phase: 'idle',
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

  edit(next: Partial<ShelfDraft>, dirtyKey: string) {
    if (!this.owner.canWrite()) return;
    this.update({
      draft: { ...this.state.draft, ...next },
      dirty: new Set([...this.state.dirty, dirtyKey]),
      phase: this.state.phase === 'saved' ? 'idle' : this.state.phase,
    });
  }

  editSort(tab: ShelfPreferenceTab, choice: string) {
    if (!this.owner.canWrite()) return;
    this.update({
      draft: { ...this.state.draft, sorts: { ...this.state.draft.sorts, [tab]: choice } },
      dirty: new Set([...this.state.dirty, `sort:${tab}`]),
      phase: this.state.phase === 'saved' ? 'idle' : this.state.phase,
    });
  }

  private async send(recovering: boolean) {
    const pending = this.state.pending;
    if (!pending || !this.owner.canWrite()) return;
    this.update({ phase: 'saving', reason: undefined, failure: undefined });
    let result;
    try {
      result = await this.io.save(pending.input);
    } catch {
      result = { ok: false as const, reason: 'unavailable' as const };
    }
    if (!this.owner.canWrite()) return;
    if (!result.ok) {
      const uncertain = result.reason === 'unavailable' || result.reason === 'preparing' || (recovering && result.reason !== 'conflict');
      this.update({
        pending: uncertain ? pending : null,
        phase: uncertain ? 'uncertain' : result.reason === 'conflict' ? 'conflict' : 'failed',
        reason: result.reason,
        ...(result.failure ? { failure: result.failure } : {}),
      });
      return;
    }
    const receipt = result.preferences;
    if (receipt.version < pending.input.expectedVersion) {
      this.update({ phase: 'uncertain', reason: 'unavailable', pending });
      return;
    }
    let current = receipt;
    if (recovering || this.owner.version() > receipt.version) {
      if (!this.owner.canRead()) return;
      try {
        const refreshed = pagePreferences(await this.io.read());
        if (!this.owner.canRead() || !refreshed || refreshed.version < receipt.version) {
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
    const changedWhileSaving = !same(this.state.draft, pending.draft);
    const resetDraft = pending.reset && !pending.dirty.size ? draftFrom({}) : this.state.draft;
    this.update({
      known: { shelf, version: current.version },
      draft: resetDraft,
      dirty: changedWhileSaving || (pending.reset && pending.dirty.size > 0) ? this.state.dirty : new Set(),
      pending: null,
      phase: changedWhileSaving || (pending.reset && pending.dirty.size > 0) ? 'review' : 'saved',
      reason: undefined,
      failure: undefined,
    });
    this.owner.onVersionChange(Math.max(this.owner.version(), current.version));
  }

  async submit(reset = false) {
    if (!this.owner.canWrite() || this.state.pending || this.state.phase === 'reloading') return;
    if (this.owner.version() > this.state.known.version) {
      this.update({ phase: 'conflict', reason: 'conflict', failure: undefined });
      return;
    }
    const shelf = reset ? null : patchFor(this.state.known.shelf, this.state.draft, this.state.dirty);
    if (!reset && !Object.keys(shelf).length) {
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
    if (this.state.phase !== 'uncertain' || !this.state.pending || !this.owner.canWrite()) return;
    await this.send(true);
  }

  async reload() {
    if (!this.owner.canRead() || this.state.phase === 'saving' || this.state.phase === 'reloading') return;
    this.update({ phase: 'reloading', reason: undefined, failure: undefined });
    try {
      const current = pagePreferences(await this.io.read());
      if (!this.owner.canRead()) return;
      if (!current) {
        this.update({ phase: this.state.pending ? 'uncertain' : 'failed', reason: 'unavailable' });
        return;
      }
      this.update({
        known: { shelf: current.shelf ?? {}, version: current.version },
        phase: this.state.pending ? 'uncertain' : 'review',
      });
      this.owner.onVersionChange(Math.max(this.owner.version(), current.version));
    } catch {
      if (this.owner.canRead()) this.update({ phase: this.state.pending ? 'uncertain' : 'failed', reason: 'unavailable' });
    }
  }

  useCurrent() {
    if (!this.owner.canRead() || this.state.pending || this.state.phase !== 'review') return;
    this.update({ draft: draftFrom(this.state.known.shelf), dirty: new Set(), phase: 'idle', reason: undefined, failure: undefined });
  }
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
}: {
  initial: ShelfPreferences;
  version: number;
  csrfToken: string | null;
  io: ReadingIO;
  onVersionChange: (version: number) => void;
}) {
  const canWrite = useSettingsCurrent(csrfToken, !!io);
  const canRead = useSettingsReadCurrent(csrfToken, !!io);
  const ownerRef = useRef({ version, canWrite, canRead, onVersionChange });
  ownerRef.current = { version, canWrite, canRead, onVersionChange };
  const [controller] = useState(
    () =>
      new ShelfPreferenceDraftRecovery(
        { spoilerLevel: 0, suitability: 'blur', version, shelf: initial },
        io,
        {
          canRead: () => ownerRef.current.canRead,
          canWrite: () => ownerRef.current.canWrite,
          version: () => ownerRef.current.version,
          onVersionChange: (next) => ownerRef.current.onVersionChange(next),
        },
      ),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const disabled = !canWrite || state.phase === 'saving' || state.phase === 'reloading';
  const unavailableColumns = unsupportedShelfColumns(state.known.shelf);
  const unavailableSorts = unsupportedShelfSorts(state.known.shelf);
  const inputId = 'shelf-default-columns';
  const showFailure = ['failed', 'conflict', 'uncertain', 'review'].includes(state.phase);
  const waiting = state.phase === 'saving' || state.phase === 'reloading';

  return (
    <Card>
      <CardHeader>
        <CardTitle><h2 id="settings-shelf-heading">{m.settings_shelf_heading()}</h2></CardTitle>
        <CardDescription>{m.settings_shelf_text()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {unavailableColumns.length ? <p className="text-sm text-muted-foreground">{m.settings_shelf_columns_unavailable({ columns: unavailableColumns.join(', ') })}</p> : null}
        {unavailableSorts.map(({ tab, field }) => (
          <p key={tab} className="text-sm text-muted-foreground">
            {m.settings_shelf_order_unavailable({ tab: tabLabel(tab), field })}
          </p>
        ))}
        <fieldset disabled={disabled} className="space-y-5">
          <label className="grid gap-1 text-sm">
            {m.settings_shelf_layout()}
            <select
              className="min-h-11 max-w-full rounded-md border bg-background px-3 py-2"
              value={state.draft.layout}
              onChange={(event) => controller.edit({ layout: event.currentTarget.value as ShelfDraft['layout'] }, 'layout')}
            >
              <option value="grid">{m.library_layout_grid()}</option>
              <option value="list">{m.library_layout_list()}</option>
              <option value="table">{m.library_layout_table()}</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {m.settings_shelf_size()}
            <select
              className="min-h-11 max-w-full rounded-md border bg-background px-3 py-2"
              value={state.draft.gridSize}
              onChange={(event) => controller.edit({ gridSize: event.currentTarget.value as ShelfDraft['gridSize'] }, 'gridSize')}
            >
              <option value="small">{m.library_size_small()}</option>
              <option value="medium">{m.library_size_medium()}</option>
              <option value="large">{m.library_size_large()}</option>
            </select>
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{m.settings_shelf_columns()}</legend>
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
                          (item) => item === 'title' || (item === column ? checked === true : state.draft.columns.includes(item)),
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
                <select
                  className="min-h-11 max-w-full rounded-md border bg-background px-3 py-2"
                  value={current}
                  onChange={(event) => controller.editSort(tab, event.currentTarget.value)}
                >
                  {current.startsWith('unsupported:') ? (
                    <option value={current} disabled>
                      {m.settings_shelf_unavailable_option({ field: current.slice('unsupported:'.length).replaceAll('_', ' ') })}
                    </option>
                  ) : null}
                  <option value={defaultSortChoice}>{m.settings_shelf_order_application_default()}</option>
                  {(['last_activity', 'added', 'finished'] as const).flatMap((field) =>
                    (['desc', 'asc'] as const).map((direction) => {
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
        {showFailure ? (
          <Alert variant={state.phase === 'failed' ? 'destructive' : 'default'}>
            <AlertTitle>{failureText(state.phase)}</AlertTitle>
            <AlertDescription className="space-y-2">
              {state.failure?.requestId ? <p>{state.failure.requestId}</p> : null}
              {state.phase === 'uncertain' && state.pending ? (
                <Button type="button" variant="outline" className="min-h-11" disabled={!canWrite} onClick={() => void controller.retry()}>
                  {m.settings_shelf_retry()}
                </Button>
              ) : null}
              <Button type="button" variant="outline" className="min-h-11" disabled={!canRead || waiting} onClick={() => void controller.reload()}>
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
        <div className="flex flex-wrap gap-2">
          <Button type="button" className="min-h-11 max-w-full whitespace-normal" disabled={disabled || !state.dirty.size} onClick={() => void controller.submit()}>
            {m.settings_shelf_save()}
          </Button>
          <Button type="button" variant="outline" className="min-h-11 max-w-full whitespace-normal" disabled={disabled || !!state.pending} onClick={() => void controller.submit(true)}>
            {m.settings_shelf_reset()}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
