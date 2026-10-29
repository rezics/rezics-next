'use client';

import { XIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList } from '@rezics/ui/shadcn/combobox';
import { Spinner } from '@rezics/ui/shadcn/spinner';
import { MetaLine } from './meta-line.tsx';
import { uiCopyLocale } from '../i18n/copy.ts';
import { cn } from '../utils.ts';
import { entityPickerMessages } from './entity-picker-messages.ts';
import { useLocale } from './locale.tsx';
import { Cover, sharedRatio, type CoverRatio, type CoverSummary } from './cover.tsx';

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

/** Searches subjects. The signal aborts when the person types again, so a slow search never overwrites a newer one. */
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
}

/** The small cover of a result: `Cover` at `xs`, which paints its title's initials when the subject has no image. */
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
  const [text, setText] = useState(() => (multiple ? '' : (selected[0]?.title ?? '')));
  const [results, setResults] = useState<Results>({ phase: 'idle', query: '', items: [] });
  const pending = useRef<{ timer?: ReturnType<typeof setTimeout>; request?: AbortController }>({});
  const searchRef = useRef(search);
  searchRef.current = search;

  const cancel = () => {
    clearTimeout(pending.current.timer);
    pending.current.request?.abort();
  };
  useEffect(() => cancel, []);

  const run = (typed: string, wait: number) => {
    cancel();
    const query = typed.trim();
    if (!query) {
      setResults({ phase: 'idle', query: '', items: [] });
      return;
    }
    // Earlier results stay visible but unselectable until these arrive, so the list does not jump on every key.
    setResults((current) => ({ ...current, phase: 'searching', query }));
    pending.current.timer = setTimeout(() => {
      const request = new AbortController();
      pending.current.request = request;
      searchRef.current(query, request.signal).then(
        (items) => {
          if (!request.signal.aborted) setResults({ phase: 'done', query, items });
        },
        () => {
          if (!request.signal.aborted) setResults({ phase: 'failed', query, items: [] });
        },
      );
    }, wait);
  };

  const change = (next: readonly EntityPickerSubject[]) => {
    const value = multiple ? [...next] : next.slice(0, 1);
    if (controlled === undefined) setInner(value);
    onValueChange?.(value);
  };

  // Rows in one list share a frame ratio so the covers align.
  const resultRatio = sharedRatio(results.items);
  const selectedRatio = sharedRatio(selected);
  const busy = results.phase === 'searching';
  const status =
    results.phase === 'idle'
      ? t.hint
      : results.phase === 'failed'
        ? t.failed
        : busy
          ? t.searching
          : results.items.length === 0
            ? t.empty.replace('{query}', results.query)
            : null;

  return (
    <div data-slot="entity-picker" className={cn('grid min-w-0 gap-3', className)}>
      <Combobox
        items={results.items}
        filter={null}
        multiple={multiple}
        disabled={disabled}
        value={multiple ? selected : (selected[0] ?? null)}
        onValueChange={(next: EntityPickerSubject | EntityPickerSubject[] | null) =>
          change(next === null ? [] : Array.isArray(next) ? next : [next])
        }
        inputValue={text}
        onInputValueChange={(typed, details) => {
          // Choosing an item writes its title into the box (or clears the box); neither is a new search.
          if (details.reason === 'item-press' || details.isItemPress) {
            if (!multiple) setText(typed);
            return;
          }
          setText(typed);
          if (details.reason === 'input-change' || details.reason === 'input-clear') run(typed, debounce);
        }}
        itemToStringLabel={(subject: EntityPickerSubject) => subject.title}
        isItemEqualToValue={(a: EntityPickerSubject, b: EntityPickerSubject) => a.id === b.id}
      >
        <ComboboxInput aria-label={label} placeholder={placeholder} showTrigger={false} className="w-full" />
        <ComboboxContent aria-busy={busy}>
          {/* Results scroll, and a scrolling region needs a keyboard stop for assistive technology that does not follow the input. */}
          <ComboboxList aria-label={label} tabIndex={results.items.length > 0 ? 0 : -1}>
            {(subject: EntityPickerSubject) => (
              <ComboboxItem key={subject.id} value={subject} disabled={busy} className="items-start gap-3 py-2">
                <ResultCover subject={subject} src={src} ratio={resultRatio} />
                <ResultText subject={subject} />
              </ComboboxItem>
            )}
          </ComboboxList>
          <div
            role="status"
            className={cn(
              'flex items-center justify-center gap-2 px-3 text-sm text-muted-foreground',
              (status || busy) && 'py-3',
            )}
          >
            {busy ? <Spinner role="presentation" aria-hidden="true" aria-label={undefined} /> : null}
            {status}
            {results.phase === 'failed' ? (
              <Button type="button" variant="outline" size="sm" onClick={() => run(results.query, 0)}>
                {t.retry}
              </Button>
            ) : null}
          </div>
        </ComboboxContent>
      </Combobox>
      {multiple && selected.length > 0 ? (
        <ul aria-label={t.selected} className="grid gap-2">
          {selected.map((subject) => (
            <li
              key={subject.id}
              className="flex items-start gap-3 rounded-2xl border border-border bg-card p-2 text-card-foreground"
            >
              <ResultCover subject={subject} src={src} ratio={selectedRatio} />
              <ResultText subject={subject} />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
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
