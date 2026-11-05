import { Cover, sharedRatio } from '@rezics/ui/cover';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { MetaLine } from '@rezics/ui/meta-line';
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList } from '@rezics/ui/shadcn/combobox';
import { useEffect, useId, useRef, useState } from 'react';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { validSuggestionText } from '../search/typeahead';
import { ContentSubjectSearchError, searchContentSubjects } from '../threads/content-subject-search';

type Phase = 'idle' | 'loading' | 'ready' | 'invalid' | 'unavailable' | 'forbidden' | 'closed';
type Results = { phase: Phase; query: string; items: EntityPickerSubject[] };

function EditionIdentity({ subject }: { subject: EntityPickerSubject }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <Cover
        subject={subject}
        cover={subject.cover}
        src={coverSrc}
        ratio={sharedRatio([subject])}
        size="xs"
        decorative
        labels={{
          withheld: m.thread_cover_withheld(),
          reveal: m.thread_cover_reveal(),
          credit: m.thread_cover_credit(),
          via: m.thread_cover_via(),
        }}
      />
      <span className="grid min-w-0 gap-1 text-start">
        <span className="font-medium break-words">{subject.title}</span>
        <span className="text-sm text-muted-foreground">
          <MetaLine items={[subject.typeLabel, subject.year == null ? '' : String(subject.year)]} />
        </span>
      </span>
    </span>
  );
}

/** The shared subject lookup with a single exact edition and immediate invalidation on text edits. */
export function CopyEditionPicker({
  value,
  disabled,
  onChange,
}: {
  value: EntityPickerSubject | null;
  disabled: boolean;
  onChange: (subject: EntityPickerSubject | null) => void;
}) {
  const hintId = useId();
  const [text, setText] = useState('');
  const [results, setResults] = useState<Results>({ phase: 'idle', query: '', items: [] });
  const pending = useRef<{ timer?: ReturnType<typeof setTimeout>; controller?: AbortController }>({});
  const cancel = () => {
    clearTimeout(pending.current.timer);
    pending.current.controller?.abort();
  };
  useEffect(() => cancel, []);

  function search(typed: string) {
    cancel();
    const query = typed.trim();
    if (!query || !validSuggestionText(query)) {
      setResults({ phase: query ? 'invalid' : 'idle', query, items: [] });
      return;
    }
    const controller = new AbortController();
    pending.current = { controller };
    setResults({ phase: 'loading', query, items: [] });
    pending.current.timer = setTimeout(async () => {
      try {
        const items = await searchContentSubjects(query, controller.signal);
        if (!controller.signal.aborted) setResults({ phase: 'ready', query, items });
      } catch (error) {
        if (!controller.signal.aborted)
          setResults({
            phase: error instanceof ContentSubjectSearchError ? error.reason : 'unavailable',
            query,
            items: [],
          });
      }
    }, 250);
  }

  const status =
    results.phase === 'loading'
      ? m.library_copy_lookup_loading()
      : results.phase === 'invalid'
        ? m.library_copy_lookup_limit()
        : results.phase === 'unavailable'
          ? m.library_copy_lookup_unavailable()
          : results.phase === 'forbidden'
            ? m.library_copy_lookup_forbidden()
            : results.phase === 'closed'
              ? m.library_copy_lookup_closed()
              : results.phase === 'ready' && !results.items.length
                ? m.library_copy_lookup_empty()
                : null;

  return (
    <div className="grid min-w-0 gap-3">
      <Combobox
        items={results.items}
        filter={null}
        disabled={disabled}
        value={value}
        inputValue={text}
        itemToStringLabel={(subject: EntityPickerSubject) => subject.title}
        isItemEqualToValue={(a: EntityPickerSubject, b: EntityPickerSubject) => a.id === b.id}
        onValueChange={(subject: EntityPickerSubject | null) => {
          if (!subject) {
            onChange(null);
            return;
          }
          if (
            results.phase !== 'ready' ||
            results.query !== text.trim() ||
            !results.items.some((item) => item.id === subject.id)
          )
            return;
          cancel();
          setText(subject.title);
          onChange(subject);
        }}
        onInputValueChange={(typed, details) => {
          if (details.reason === 'item-press' || details.isItemPress) return;
          if (details.reason !== 'input-change' && details.reason !== 'input-clear') return;
          setText(typed);
          onChange(null);
          search(typed);
        }}
      >
        <ComboboxInput
          aria-label={m.library_copy_edition()}
          aria-describedby={hintId}
          showTrigger={false}
          className="w-full"
        />
        <ComboboxContent aria-busy={results.phase === 'loading'}>
          <ComboboxList aria-label={m.library_copy_edition()} tabIndex={results.items.length ? 0 : -1}>
            {(subject: EntityPickerSubject) => (
              <ComboboxItem key={subject.id} value={subject} className="min-h-11 py-2">
                <EditionIdentity subject={subject} />
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <p id={hintId} className="text-sm text-muted-foreground">
        {m.library_copy_edition_hint()}
      </p>
      {status ? (
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      ) : null}
      {results.phase === 'unavailable' || results.phase === 'forbidden' || results.phase === 'closed' ? (
        <button
          type="button"
          disabled={disabled}
          className="min-h-11 justify-self-start text-primary underline underline-offset-4"
          onClick={() => search(text)}
        >
          {m.subject_view_retry()}
        </button>
      ) : null}
      {value ? <EditionIdentity subject={value} /> : null}
    </div>
  );
}
