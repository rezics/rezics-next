'use client';

import { XIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList } from '@rezics/ui/shadcn/combobox';
import { Spinner } from '@rezics/ui/shadcn/spinner';
import { MetaLine } from './meta-line.tsx';
import { uiCopyLocale } from '../i18n/copy.ts';
import { cn } from '../utils.ts';
import { entityPickerMessages } from './entity-picker-messages.ts';
import { useLocale } from './locale.tsx';
import { Cover, sharedRatio, type CoverRatio, type CoverSummary } from './cover.tsx';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** One search result: the subject's summary as the kernel returns it, with the site's own type label. */
export interface EntityPickerSubject {
  /** Identifies the subject to the site; the picker never shows it. */
  id: string;
  title: string;
  /** The subject's semantic types, which choose the cover frame and its placeholder. */
  types: readonly string[];
  /** The type in the reader's language, for example “Light novel”. */
  typeLabel: string;
  year?: number | null;
  cover: CoverSummary | null;
}

/** Searches subjects. The signal advises obsolete work to stop; the picker also ignores obsolete completions. */
export type EntityPickerSearch = (text: string, signal: AbortSignal) => Promise<readonly EntityPickerSubject[]>;

/** Builds the address of one cover variant; the site owns the media route. */
type CoverSrc = ComponentProps<typeof Cover>['src'];

export interface EntityPickerProps {
  search: EntityPickerSearch;
  /** Builds cover variant URLs; the site owns the media route. */
  src: CoverSrc;
  /** The accessible name of the search box. */
  label: string;
  placeholder?: string;
  /** Allows several subjects; each stays listed below the search box until removed. */
  multiple?: boolean;
  value?: readonly EntityPickerSubject[];
  defaultValue?: readonly EntityPickerSubject[];
  onValueChange?: (value: EntityPickerSubject[]) => void;
  /** Milliseconds to wait after the last keystroke before searching. */
  debounce?: number;
  disabled?: boolean;
  className?: string;
}

type Phase = 'idle' | 'searching' | 'done' | 'failed';
interface Results {
  phase: Phase;
  /** The text the results answer, trimmed. */
  query: string;
  items: readonly EntityPickerSubject[];
  multiple: boolean;
  /** Single-select results belong to the selected label as well as the query. */
  selectionKey: string;
}

interface SearchInvocation {
  query: string;
  multiple: boolean;
  selectionKey: string;
  timer?: ReturnType<typeof setTimeout>;
  request?: AbortController;
}

function selectionKey(items: readonly EntityPickerSubject[]): string {
  return JSON.stringify(items.map(({ id, title }) => [id, title])) ?? '[]';
}

/** The small cover of a result, using the shared compact placeholder when the subject has no image. */
function ResultCover({ subject, src, ratio }: { subject: EntityPickerSubject; src: CoverSrc; ratio: CoverRatio }) {
  return (
    <span data-slot="entity-picker-cover" className="shrink-0">
      <Cover
        subject={{ id: subject.id, title: subject.title, types: subject.types }}
        cover={subject.cover}
        size="xs"
        src={src}
        ratio={ratio}
        decorative
      />
    </span>
  );
}

function ResultText({ subject }: { subject: EntityPickerSubject }) {
  const details = [subject.typeLabel, subject.year == null ? '' : String(subject.year)];
  return (
    <span className="grid min-w-0 flex-1 gap-0.5 text-start">
      <span className="line-clamp-2 font-medium [overflow-wrap:anywhere]">{subject.title}</span>
      {details.some(Boolean) ? (
        <span className="truncate text-xs text-muted-foreground">
          <MetaLine items={details} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * A subject picker that searches as the person types.
 *
 * shadcn's `combobox` filters a list it already holds; this one asks the site's search for each text, waits for a
 * pause in typing, aborts the search a newer keystroke makes stale, and shows each subject with its cover, type and
 * year. The id is only ever passed back to the site, never shown.
 */
export function EntityPicker({
  search,
  src,
  label,
  placeholder,
  multiple = false,
  value: controlled,
  defaultValue,
  onValueChange,
  debounce = 250,
  disabled,
  className,
}: EntityPickerProps) {
  const t = entityPickerMessages[uiCopyLocale(useLocale().locale)];
  const [inner, setInner] = useState<readonly EntityPickerSubject[]>(defaultValue ?? []);
  const selected = controlled ?? inner;
  const selectedKey = selectionKey(selected);
  const selectedTitle = selected[0]?.title ?? '';
  const isDisabled = !!disabled;
  const [text, setText] = useState(() => (multiple ? '' : (selected[0]?.title ?? '')));
  const [results, setResults] = useState<Results>({
    phase: 'idle',
    query: '',
    items: [],
    multiple,
    selectionKey: multiple ? '' : selectedKey,
  });
  const pending = useRef<SearchInvocation | null>(null);
  const boundary = useRef({ multiple, disabled: isDisabled, selectionKey: selectedKey });
  const searchRef = useRef(search);
  searchRef.current = search;

  const cancel = useCallback(() => {
    const invocation = pending.current;
    pending.current = null;
    if (!invocation) return;
    if (invocation.timer !== undefined) clearTimeout(invocation.timer);
    invocation.request?.abort();
  }, []);
  useIsomorphicLayoutEffect(() => cancel, [cancel]);

  // Keep controlled label changes visible without treating fresh but equivalent parent objects as changes.
  const textBoundaryChanged =
    boundary.current.multiple !== multiple || (!multiple && boundary.current.selectionKey !== selectedKey);
  const inputText = textBoundaryChanged ? (multiple ? '' : (selected[0]?.title ?? '')) : text;

  useIsomorphicLayoutEffect(() => {
    const previous = boundary.current;
    const modeChanged = previous.multiple !== multiple;
    const selectionChanged = previous.selectionKey !== selectedKey;
    const disabledChanged = previous.disabled !== isDisabled;
    const singleSelectionChanged = selectionChanged && (!multiple || !previous.multiple);

    // Disabling/re-enabling and single selection changes retire any query that belonged to the old workflow.
    // Re-enabling keeps the person's draft; they can continue typing to admit a fresh query.
    if (modeChanged || disabledChanged || singleSelectionChanged) {
      cancel();
      setResults({
        phase: 'idle',
        query: '',
        items: [],
        multiple,
        selectionKey: multiple ? '' : selectedKey,
      });
    }
    if (modeChanged || (!multiple && selectionChanged)) setText(multiple ? '' : selectedTitle);

    boundary.current = { multiple, disabled: isDisabled, selectionKey: selectedKey };
  }, [cancel, isDisabled, multiple, selectedKey, selectedTitle]);

  const run = (typed: string, wait: number) => {
    cancel();
    const query = typed.trim();
    if (!query || isDisabled) {
      setResults({
        phase: 'idle',
        query: '',
        items: [],
        multiple,
        selectionKey: multiple ? '' : selectedKey,
      });
      return;
    }
    const invocation: SearchInvocation = {
      query,
      multiple,
      selectionKey: multiple ? '' : selectedKey,
    };
    pending.current = invocation;
    // Earlier results stay visible but unselectable until these arrive, so the list does not jump on every key.
    setResults((current) => ({
      phase: 'searching',
      query,
      items: current.items,
      multiple,
      selectionKey: multiple ? '' : selectedKey,
    }));
    invocation.timer = setTimeout(() => {
      // Abort is advisory. Identity also retires work when a provider ignores its signal or resolves after unmount.
      if (pending.current !== invocation || isDisabled) return;
      const request = new AbortController();
      invocation.request = request;
      const complete = (phase: 'done' | 'failed', items: readonly EntityPickerSubject[]) => {
        if (pending.current !== invocation || request.signal.aborted) return;
        pending.current = null;
        setResults({
          phase,
          query,
          items,
          multiple: invocation.multiple,
          selectionKey: invocation.selectionKey,
        });
      };
      try {
        Promise.resolve(searchRef.current(query, request.signal)).then(
          (items) => complete('done', items),
          () => complete('failed', []),
        );
      } catch {
        complete('failed', []);
      }
    }, wait);
  };

  const change = (next: readonly EntityPickerSubject[]) => {
    if (isDisabled) return;
    const value = multiple ? [...next] : next.slice(0, 1);
    if (controlled === undefined) setInner(value);
    onValueChange?.(value);
  };

  const currentResults =
    !isDisabled &&
    results.multiple === multiple &&
    results.query === inputText.trim() &&
    (multiple || results.selectionKey === selectedKey)
      ? results
      : {
          phase: 'idle' as const,
          query: '',
          items: [] as readonly EntityPickerSubject[],
          multiple,
          selectionKey: multiple ? '' : selectedKey,
        };
  // Base UI restores a selected label when an empty input's item collection changes. Keep an active single-select
  // draft separate from that selected value so clearing or editing the query stays a real input state.
  const singleValue = inputText === selectedTitle ? (selected[0] ?? null) : null;

  // Rows in one list share a frame ratio so the covers align.
  const resultRatio = sharedRatio(currentResults.items);
  const selectedRatio = sharedRatio(selected);
  const busy = currentResults.phase === 'searching';
  const status =
    currentResults.phase === 'idle'
      ? t.hint
      : currentResults.phase === 'failed'
        ? t.failed
        : busy
          ? t.searching
          : currentResults.items.length === 0
            ? t.empty.replace('{query}', currentResults.query)
            : null;

  return (
    <div data-slot="entity-picker" className={cn('grid min-w-0 gap-3', className)}>
      <Combobox
        items={currentResults.items}
        filter={null}
        multiple={multiple}
        disabled={isDisabled}
        value={multiple ? selected : singleValue}
        onValueChange={(next: EntityPickerSubject | EntityPickerSubject[] | null) => {
          if (isDisabled) return;
          const value = next === null ? [] : Array.isArray(next) ? next : [next];
          const selectedIds = new Set(selected.map((subject) => subject.id));
          const additions = value.filter((subject) => !selectedIds.has(subject.id));
          const eligibleSubjects =
            currentResults.phase === 'done' ? new Set(currentResults.items) : new Set<EntityPickerSubject>();

          // Only a current, completed result may add a selection; removals and an explicit clear remain available.
          if (additions.some((subject) => !eligibleSubjects.has(subject))) return;
          if (!multiple && value[0] && !selectedIds.has(value[0].id) && !eligibleSubjects.has(value[0])) return;
          change(value);
        }}
        inputValue={inputText}
        onInputValueChange={(typed, details) => {
          // Choosing an item writes its title into the box (or clears the box); neither is a new search.
          if (details.reason === 'item-press' || details.isItemPress) {
            if (!multiple) {
              cancel();
              setText(typed);
              setResults({ phase: 'idle', query: '', items: [], multiple, selectionKey: selectedKey });
            }
            return;
          }
          if (isDisabled) return;
          setText(typed);
          if (details.reason === 'input-change' || details.reason === 'input-clear') {
            run(typed, debounce);
          } else if (typed !== inputText) {
            cancel();
            setResults({
              phase: 'idle',
              query: '',
              items: [],
              multiple,
              selectionKey: multiple ? '' : selectedKey,
            });
          }
        }}
        itemToStringLabel={(subject: EntityPickerSubject) => subject.title}
        isItemEqualToValue={(a: EntityPickerSubject, b: EntityPickerSubject) => a.id === b.id}
      >
        <ComboboxInput
          aria-label={label}
          placeholder={placeholder}
          disabled={isDisabled}
          showTrigger={false}
          className="w-full"
        />
        <ComboboxContent aria-busy={busy} className="min-w-0">
          {/* Results scroll, and a scrolling region needs a keyboard stop for assistive technology that does not follow the input. */}
          <ComboboxList aria-label={label} tabIndex={currentResults.items.length > 0 ? 0 : -1}>
            {(subject: EntityPickerSubject) => (
              <ComboboxItem
                key={subject.id}
                value={subject}
                disabled={busy || isDisabled}
                className="min-w-0 items-start gap-3 py-2"
              >
                <ResultCover subject={subject} src={src} ratio={resultRatio} />
                <ResultText subject={subject} />
              </ComboboxItem>
            )}
          </ComboboxList>
          <div
            role="status"
            className={cn(
              'flex flex-wrap items-center justify-center gap-2 px-3 text-center text-sm text-muted-foreground [overflow-wrap:anywhere]',
              (status || busy) && 'py-3',
            )}
          >
            {busy ? <Spinner role="presentation" aria-hidden="true" aria-label={undefined} /> : null}
            <span className="min-w-0">{status}</span>
            {currentResults.phase === 'failed' && !isDisabled ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto whitespace-normal py-1"
                onClick={() => {
                  if (isDisabled || currentResults.phase !== 'failed' || currentResults.query !== inputText.trim())
                    return;
                  run(currentResults.query, 0);
                }}
              >
                {t.retry}
              </Button>
            ) : null}
          </div>
        </ComboboxContent>
      </Combobox>
      {multiple && selected.length > 0 ? (
        <ul aria-label={t.selected} className="grid min-w-0 gap-2">
          {selected.map((subject) => (
            <li
              key={subject.id}
              className="flex min-w-0 items-start gap-3 rounded-2xl border border-border bg-card p-2 text-card-foreground"
            >
              <ResultCover subject={subject} src={src} ratio={selectedRatio} />
              <ResultText subject={subject} />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={isDisabled}
                aria-label={t.remove.replace('{title}', subject.title)}
                onClick={() => change(selected.filter((entry) => entry.id !== subject.id))}
              >
                <XIcon aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
