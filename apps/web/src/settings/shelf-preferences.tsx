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
import { useSettingsNavigationDraft } from './reading-navigation';
import { preferenceRetryDeadline, usePreferenceRetry } from './preference-failure-retry';

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
type ShelfIssue =
  | 'read:closed'
  | 'read:preparing'
  | 'read:forbidden'
  | 'read:unavailable'
  | 'read:malformed_advice'
  | 'read:inconsistent'
  | 'write:closed'
  | 'write:preparing'
  | 'write:forbidden'
  | 'write:unavailable'
  | 'write:invalid'
  | 'write:unknown_outcome'
  | 'stale_version';
type ShelfPageRead = {
  preferences: ReadingPreferences | undefined;
  issue?: ShelfIssue;
  failure?: NativePreferenceFailure;
};
type ShelfState = {
  known: { shelf: ShelfPreferences; version: number };
  advice: ReadingAdvice | undefined;
  current: boolean;
  draft: ShelfDraft;
  dirty: Set<string>;
  pending: Pending | null;
  comparison: Pending | null;
  phase: 'idle' | 'saving' | 'saved' | 'uncertain' | 'conflict' | 'reloading' | 'review' | 'failed';
  reason: ShelfIssue | undefined;
  failure: NativePreferenceFailure | undefined;
  retryAt: number;
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

function currentPage(page: Awaited<ReturnType<ReadingIO['read']>>): ShelfPageRead {
  if (!page.signedIn) return { preferences: undefined, issue: 'read:forbidden' as const };
  if (!('preferences' in page)) {
    const issue =
      page.state === 'closed' || page.failure.code === 'platform_closed'
        ? 'read:closed'
        : page.state === 'preparing' || page.failure.code === 'platform_preparing'
          ? 'read:preparing'
          : page.failure.status === 401 || page.failure.status === 403
            ? 'read:forbidden'
            : 'read:unavailable';
    return { preferences: undefined, issue: issue as ShelfIssue, failure: page.failure };
  }
  if (page.preferences.advice?.allowedActions.read.allowed === false)
    return { preferences: undefined, issue: 'read:forbidden' as const };
  return {
    preferences: page.preferences,
    ...(!page.preferences.advice?.shelfAdvice ? { issue: 'read:malformed_advice' as const } : {}),
  };
}

function deniedShelfUpdate(advice: ReadingAdvice | undefined): ReadingAdvice | undefined {
  return advice
    ? {
        ...advice,
        allowedActions: { ...advice.allowedActions, update: { allowed: false, reason: 'not_authorized' } },
      }
    : undefined;
}

function frozenShelfPatch(shelf: ShelfPreferencePatch | null): ShelfPreferencePatch | null {
  if (shelf === null) return null;
  const layouts = shelf.layouts && shelf.layouts !== null ? Object.freeze({ ...shelf.layouts }) : shelf.layouts;
  const sorts =
    shelf.sorts && shelf.sorts !== null
      ? Object.freeze(
          Object.fromEntries(
            Object.entries(shelf.sorts).map(([tab, sort]) => [tab, sort && Object.freeze({ ...sort })]),
          ),
        )
      : shelf.sorts;
  const tableColumns = Array.isArray(shelf.tableColumns) ? Object.freeze([...shelf.tableColumns]) : shelf.tableColumns;
  return Object.freeze({
    ...shelf,
    ...(layouts !== undefined ? { layouts } : {}),
    ...(sorts !== undefined ? { sorts } : {}),
    ...(tableColumns !== undefined ? { tableColumns } : {}),
  });
}

function requestedShelfMatches(requested: ShelfPreferencePatch | null | undefined, actual: ShelfPreferences): boolean {
  if (requested === null) return !Object.keys(actual).length;
  if (!requested) return true;
  return (
    (!requested.layouts ||
      Object.entries(requested.layouts).every(([scope, layout]) =>
        layout === null ? actual.layouts?.[scope] === undefined : actual.layouts?.[scope] === layout,
      )) &&
    (!requested.sorts ||
      Object.entries(requested.sorts).every(([tab, sort]) =>
        sort === null
          ? actual.sorts?.[tab as ShelfPreferenceTab] === undefined
          : same(actual.sorts?.[tab as ShelfPreferenceTab], sort),
      )) &&
    (requested.gridSize === undefined || actual.gridSize === requested.gridSize) &&
    (requested.tableColumns === undefined || same(actual.tableColumns, requested.tableColumns))
  );
}

function shelfReadSummary(shelf: ShelfPreferences) {
  return (
    <dl className="space-y-2 text-sm">
      <div>
        <dt className="font-medium">{m.settings_shelf_layout()}</dt>
        <dd>{shelf.layouts?.all ? layoutName(shelf.layouts.all) : m.settings_shelf_inherited()}</dd>
      </div>
      <div>
        <dt className="font-medium">{m.settings_shelf_size()}</dt>
        <dd>
          {shelf.gridSize
            ? shelf.gridSize === 'small'
              ? m.library_size_small()
              : shelf.gridSize === 'large'
                ? m.library_size_large()
                : m.library_size_medium()
            : m.settings_shelf_inherited()}
        </dd>
      </div>
      <div>
        <dt className="font-medium">{m.settings_shelf_columns()}</dt>
        <dd>{shelf.tableColumns?.join(', ') ?? m.settings_shelf_inherited()}</dd>
      </div>
      {tabs.map((tab) => (
        <div key={tab}>
          <dt className="font-medium">{m.settings_shelf_order({ tab: tabLabel(tab) })}</dt>
          <dd>
            {shelf.sorts?.[tab]
              ? sortLabel(shelf.sorts[tab].field, shelf.sorts[tab].direction)
              : m.settings_shelf_inherited()}
          </dd>
        </div>
      ))}
      {Object.entries(shelf.layouts ?? {})
        .filter(([scope]) => scope !== 'all')
        .map(([scope, layout]) => (
          <div key={scope}>
            <dt className="font-medium"><code>{scope}</code></dt>
            <dd>{layoutName(layout)}</dd>
          </div>
        ))}
    </dl>
  );
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
      current: true,
      draft: draftFrom(shelf),
      dirty: new Set(),
      pending: null,
      comparison: null,
      phase: 'idle',
      reason: undefined,
      failure: undefined,
      retryAt: 0,
    };
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  canRetryOriginal = () =>
    this.owner.canWrite() &&
    this.state.phase === 'uncertain' &&
    this.state.pending !== null &&
    this.state.advice?.allowedActions.update.allowed !== false;
  canSubmit = () => this.writable() && !this.state.pending && this.state.phase !== 'reloading';
  needsNavigationDecision = () =>
    this.state.pending !== null ||
    this.state.comparison !== null ||
    Object.keys(patchFor(this.state.known.shelf, this.state.draft, this.state.dirty)).length > 0;

  private update(patch: Partial<ShelfState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private editable() {
    return this.owner.canWrite() && ownerMayChangeShelf(this.state.advice);
  }

  private writable() {
    return this.state.current && this.editable();
  }

  private waiting() {
    return this.state.retryAt > Date.now();
  }

  edit(next: Partial<ShelfDraft>, dirtyKey: string) {
    if (!this.editable()) return;
    this.update({
      draft: { ...this.state.draft, ...next },
      dirty: new Set([...this.state.dirty, dirtyKey]),
      phase: this.state.phase === 'saved' ? 'idle' : this.state.phase,
    });
  }

  editSort(tab: ShelfPreferenceTab, choice: string) {
    if (!this.editable()) return;
    this.update({
      draft: { ...this.state.draft, sorts: { ...this.state.draft.sorts, [tab]: choice } },
      dirty: new Set([...this.state.dirty, `sort:${tab}`]),
      phase: this.state.phase === 'saved' ? 'idle' : this.state.phase,
    });
  }

  editTypeLayout(scope: string, layout: ShelfDraft['layout'] | undefined) {
    const limits = this.state.advice?.shelfAdvice?.limits;
    if (
      !this.editable() ||
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
    if (!pending || !this.owner.canWrite() || this.waiting()) return;
    this.update({ phase: 'saving', reason: undefined, failure: undefined, retryAt: 0 });
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
      const reason =
        result.reason === 'conflict'
          ? 'stale_version'
          : (`write:${result.reason}` as ShelfIssue);
      this.update({
        pending: uncertain ? pending : null,
        comparison: uncertain ? this.state.comparison : pending,
        phase: uncertain ? 'uncertain' : result.reason === 'conflict' ? 'conflict' : 'failed',
        reason,
        failure: result.failure,
        retryAt: preferenceRetryDeadline(result.failure?.retryAfter),
        current: uncertain || result.reason === 'conflict' ? false : this.state.current,
        advice:
          result.reason === 'forbidden'
            ? deniedShelfUpdate(this.state.advice)
            : result.reason === 'conflict'
              ? undefined
              : this.state.advice,
      });
      return;
    }
    const receipt = result.preferences;
    const requested = pending.input.shelf;
    const written = receipt.shelf ?? {};
    if (!requestedShelfMatches(requested, written) || receipt.version < pending.input.expectedVersion) {
      this.update({ phase: 'uncertain', reason: 'write:unknown_outcome', pending, current: false, retryAt: 0 });
      return;
    }
    let current = receipt;
    let readIssue: ShelfIssue | undefined;
    let reacquired = false;
    if (recovering || this.owner.version() > receipt.version) {
      if (!this.owner.canRead() || this.waiting()) return;
      reacquired = true;
      try {
        const read = currentPage(await this.io.read());
        if (
          !this.owner.canRead() ||
          !read.preferences
        ) {
          this.update({
            phase: 'uncertain',
            reason: read.issue ?? 'read:unavailable',
            failure: read.failure,
            retryAt: preferenceRetryDeadline(read.failure?.retryAfter),
            current: false,
            advice: undefined,
            pending,
          });
          return;
        }
        const refreshed = read.preferences;
        if (refreshed.version < Math.max(receipt.version, this.owner.version())) {
          this.update({
            phase: 'uncertain',
            reason: 'stale_version',
            failure: undefined,
            retryAt: 0,
            current: false,
            advice: undefined,
            pending,
          });
          return;
        }
        if (refreshed.version === receipt.version && !same(refreshed.shelf ?? {}, receipt.shelf ?? {})) {
          this.update({
            phase: 'uncertain',
            reason: 'read:inconsistent',
            failure: undefined,
            retryAt: 0,
            current: false,
            advice: undefined,
            pending,
          });
          return;
        }
        current = refreshed;
        readIssue = read.issue;
      } catch {
        if (this.owner.canRead())
          this.update({
            phase: 'uncertain',
            reason: 'read:unavailable',
            failure: undefined,
            retryAt: 0,
            current: false,
            advice: undefined,
            pending,
          });
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
    const changedAfterReceipt =
      current.version > receipt.version && !requestedShelfMatches(requested, current.shelf ?? {});
    if (changedAfterReceipt) for (const key of pending.dirty) remainingDirty.add(key);
    const resetDraft = rebaseDraft(shelf, this.state.draft, remainingDirty);
    const needsReview =
      reacquired ||
      changedWhileSaving ||
      (pending.reset && pending.dirty.size > 0) ||
      changedAfterReceipt ||
      !!readIssue ||
      (remainingDirty.size > 0 && !choiceAdmitted(resetDraft, current.advice));
    this.update({
      known: { shelf, version: current.version },
      advice: current.advice,
      current: true,
      draft: resetDraft,
      dirty: remainingDirty,
      pending: null,
      comparison: needsReview ? pending : null,
      phase: needsReview ? 'review' : 'saved',
      reason: readIssue,
      failure: undefined,
      retryAt: 0,
    });
    this.owner.onVersionChange(Math.max(this.owner.version(), current.version));
  }

  async submit(reset = false) {
    if (!this.writable() || this.waiting() || this.state.pending || this.state.phase === 'reloading') return;
    if (this.owner.version() > this.state.known.version) {
      this.update({
        phase: 'conflict',
        reason: 'stale_version',
        failure: undefined,
        retryAt: 0,
        current: false,
        advice: undefined,
      });
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
      input: Object.freeze({
        expectedVersion: this.state.known.version,
        shelf: frozenShelfPatch(shelf),
        idempotencyKey: uuid(),
      }),
      draft: this.state.draft,
      dirty: new Set(this.state.dirty),
      reset,
    };
    this.update({
      pending,
      comparison: null,
      phase: 'saving',
      reason: undefined,
      failure: undefined,
      retryAt: 0,
    });
    await this.send(false);
  }

  async retry() {
    if (!this.canRetryOriginal() || this.waiting()) return;
    await this.send(true);
  }

  async reload() {
    if (
      !this.owner.canRead() ||
      this.waiting() ||
      this.state.phase === 'saving' ||
      this.state.phase === 'reloading'
    )
      return;
    this.update({ phase: 'reloading', reason: undefined, failure: undefined, retryAt: 0 });
    try {
      const read = currentPage(await this.io.read());
      if (!this.owner.canRead()) return;
      if (!read.preferences) {
        this.update({
          phase: this.state.pending ? 'uncertain' : 'failed',
          reason: read.issue ?? 'read:unavailable',
          failure: read.failure,
          retryAt: preferenceRetryDeadline(read.failure?.retryAfter),
          current: false,
          advice: undefined,
        });
        return;
      }
      const current = read.preferences;
      if (current.version < Math.max(this.state.known.version, this.owner.version())) {
        this.update({
          phase: this.state.pending ? 'uncertain' : 'conflict',
          reason: 'stale_version',
          failure: undefined,
          retryAt: 0,
          current: false,
          advice: undefined,
        });
        return;
      }
      const shelf = current.shelf ?? {};
      const draft = rebaseDraft(shelf, this.state.draft, this.state.dirty);
      this.update({
        known: { shelf, version: current.version },
        advice: current.advice,
        current: true,
        draft,
        phase: this.state.pending ? 'uncertain' : read.issue ? 'failed' : 'review',
        reason: read.issue,
        failure: undefined,
        retryAt: 0,
      });
      this.owner.onVersionChange(Math.max(this.owner.version(), current.version));
    } catch {
      if (this.owner.canRead())
        this.update({
          phase: this.state.pending ? 'uncertain' : 'failed',
          reason: 'read:unavailable',
          failure: undefined,
          retryAt: 0,
          current: false,
          advice: undefined,
        });
    }
  }

  useCurrent() {
    if (
      !this.owner.canRead() ||
      !this.state.current ||
      this.state.pending ||
      (this.state.phase !== 'review' && !this.state.comparison)
    )
      return;
    this.update({
      draft: draftFrom(this.state.known.shelf),
      dirty: new Set(),
      comparison: null,
      phase: 'idle',
      reason: undefined,
      failure: undefined,
      retryAt: 0,
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
  const needsNavigationDecision = readCurrent() && controller.needsNavigationDecision();
  useSettingsNavigationDraft(
    'shelf',
    needsNavigationDecision,
    () => readCurrent() && controller.needsNavigationDecision(),
    controller,
  );
  const advice = state.advice;
  const shelfAdvice = advice?.shelfAdvice;
  const ownerMayChange = ownerMayChangeShelf(advice);
  const canEdit = writeCurrent() && ownerMayChange;
  const canWrite = writeCurrent() && controller.canSubmit();
  const retryWaiting = usePreferenceRetry(state.failure, state.retryAt);
  const retrySeconds = Math.max(1, Math.ceil((state.retryAt - Date.now()) / 1000));
  const disabled = !canEdit || state.phase === 'saving' || state.phase === 'reloading';
  const unavailableColumns = unsupportedShelfColumns(state.known.shelf);
  const unavailableSorts = unsupportedShelfSorts(state.known.shelf);
  const inputId = 'shelf-default-columns';
  const showFailure = ['failed', 'conflict', 'uncertain', 'review'].includes(state.phase);
  const waiting = state.phase === 'saving' || state.phase === 'reloading';
  const showRecovery = !shelfAdvice || showFailure;
  const original = state.pending ?? state.comparison;
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
        {state.current && unavailableColumns.length ? (
          <p className="text-sm text-muted-foreground">
            {m.settings_shelf_columns_unavailable({ columns: unavailableColumns.join(', ') })}
          </p>
        ) : null}
        {state.current
          ? unavailableSorts.map(({ tab, field }) => (
          <p key={tab} className="text-sm text-muted-foreground">
            {m.settings_shelf_order_unavailable({ tab: tabLabel(tab), field })}
          </p>
            ))
          : null}
        {!shelfAdvice ? (
          state.current ? shelfReadSummary(state.known.shelf) : null
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
                  {state.current
                    ? state.known.shelf.layouts?.all
                      ? m.settings_shelf_saved({ value: layoutName(state.known.shelf.layouts.all) })
                      : m.settings_shelf_inherited()
                    : m.settings_shelf_choices_unavailable_text()}
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
                  {state.current
                    ? state.known.shelf.gridSize
                      ? m.settings_shelf_saved({
                        value:
                          state.known.shelf.gridSize === 'small'
                            ? m.library_size_small()
                            : state.known.shelf.gridSize === 'large'
                              ? m.library_size_large()
                              : m.library_size_medium(),
                        })
                      : m.settings_shelf_inherited()
                    : m.settings_shelf_choices_unavailable_text()}
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
                  {state.current
                    ? state.known.shelf.tableColumns
                      ? m.settings_shelf_saved_choice()
                      : m.settings_shelf_inherited()
                    : m.settings_shelf_choices_unavailable_text()}
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
                      {state.current
                        ? state.known.shelf.sorts?.[tab]
                          ? m.settings_shelf_saved_choice()
                          : m.settings_shelf_inherited()
                        : m.settings_shelf_choices_unavailable_text()}
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
        {showRecovery ? (
          <Alert variant={state.phase === 'failed' ? 'destructive' : 'default'}>
            <AlertTitle>
              {shelfAdvice ? failureText(state.phase) : m.settings_shelf_choices_unavailable_title()}
            </AlertTitle>
            <AlertDescription className="space-y-2">
              {!shelfAdvice ? <p>{m.settings_shelf_choices_unavailable_text()}</p> : null}
              {state.phase === 'uncertain' && state.pending ? <p>{m.settings_shelf_uncertain()}</p> : null}
              {state.reason ? (
                <p className="font-mono text-xs" data-recovery-reason={state.reason}>
                  {state.reason.replace(':', ' · ').replaceAll('_', ' ')}
                </p>
              ) : null}
              {state.failure?.status !== undefined ? (
                <p className="font-mono text-xs">HTTP {state.failure.status ?? 'unknown'}</p>
              ) : null}
              {state.failure?.code ? <p className="font-mono text-xs">{state.failure.code}</p> : null}
              {state.failure?.requestId ? <p>{state.failure.requestId}</p> : null}
              {state.failure?.retryAfter ? (
                <p className="font-mono text-xs" data-retry-after={state.failure.retryAfter}>
                  Retry-After: {state.failure.retryAfter}
                </p>
              ) : null}
              {retryWaiting ? (
                <p role="status" data-retry-after={state.failure?.retryAfter}>
                  {m.route_retry_after({ seconds: retrySeconds })}
                </p>
              ) : null}
              {original ? (
                <pre
                  className="overflow-auto rounded bg-muted p-2 text-xs"
                  data-original-shelf-change="true"
                >
                  {JSON.stringify(
                    { expectedVersion: original.input.expectedVersion, shelf: original.input.shelf },
                    null,
                    2,
                  )}
                </pre>
              ) : null}
              {state.phase === 'uncertain' && state.pending ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={!controller.canRetryOriginal() || !writeCurrent() || retryWaiting || waiting}
                  onClick={() => void controller.retry()}
                >
                  {m.settings_shelf_retry()}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={!canRead || waiting || retryWaiting}
                onClick={() => void controller.reload()}
              >
                {m.settings_shelf_reload()}
              </Button>
              {state.current && !state.pending && (state.phase === 'review' || state.comparison) ? (
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
              disabled={disabled || retryWaiting || !!state.pending || !state.dirty.size || !canWrite}
              onClick={() => void controller.submit()}
            >
              {m.settings_shelf_save()}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 max-w-full whitespace-normal"
              disabled={disabled || retryWaiting || !!state.pending || !canWrite}
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
