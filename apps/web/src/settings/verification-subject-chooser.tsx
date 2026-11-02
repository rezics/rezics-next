import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList } from '@rezics/ui/shadcn/combobox';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useSession } from '../session/query';
import { searchVerificationSubjects } from './verification-actions';
import { withVerificationDeadline } from './verification-request-deadline';

export type VerificationSubject = { id: string; title: string; type: string };
type Search = (query: string, signal: AbortSignal) => Promise<VerificationSubject[]>;
type SearchState = {
  query: string;
  phase: 'idle' | 'pending' | 'loading' | 'ready' | 'failed';
  subjects: VerificationSubject[];
};
const idle: SearchState = { query: '', phase: 'idle', subjects: [] };

/** One current term and request, with no cache shared across human sessions. */
export class VerificationSubjectSearch {
  private state = idle;
  private enabled = false;
  private composing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | undefined;
  private listeners = new Set<() => void>();
  constructor(private load: Search) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: SearchState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const request = this.request;
    this.request = undefined;
    request?.abort();
  }
  clear = () => {
    this.cancel();
    this.composing = false;
    this.update(idle);
  };
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }
  edit = (value: string) => {
    if (!this.enabled) return;
    this.cancel();
    const query = value.slice(0, 100).replace(/[\uD800-\uDBFF]$/u, '');
    this.update({ query, phase: !this.composing && query.trim() ? 'pending' : 'idle', subjects: [] });
    if (!this.composing && query.trim()) this.timer = setTimeout(() => void this.send(), 250);
  };
  isComposing = () => this.composing;
  startComposition = () => {
    if (!this.enabled) return;
    this.cancel();
    this.composing = true;
    this.update({ query: this.state.query, phase: 'idle', subjects: [] });
  };
  endComposition = (value: string) => {
    if (!this.enabled || !this.composing) return;
    this.composing = false;
    this.edit(value);
  };
  retry = () => {
    if (this.enabled && this.state.phase === 'failed') void this.send();
  };
  current(subject: VerificationSubject) {
    return this.enabled && !this.composing && this.state.phase === 'ready' && this.state.subjects.includes(subject);
  }
  private async send() {
    const query = this.state.query;
    if (!this.enabled || this.composing || !query.trim()) return;
    const request = new AbortController();
    this.request = request;
    this.update({ query, phase: 'loading', subjects: [] });
    try {
      const subjects = await withVerificationDeadline((signal) => this.load(query.trim(), signal), request.signal);
      if (this.request === request && !request.signal.aborted) this.update({ query, phase: 'ready', subjects });
    } catch {
      if (this.request === request && !request.signal.aborted) this.update({ query, phase: 'failed', subjects: [] });
    } finally {
      if (this.request === request) this.request = undefined;
    }
  }
}

type Props = {
  selected: VerificationSubject | null;
  onSelect: (subject: VerificationSubject | null) => void;
  disabled?: boolean;
};
const nativeSearch: Search = (query, signal) => searchVerificationSubjects({ data: { query }, signal });

export function VerificationSubjectChooser(props: Props) {
  const session = useSession();
  const onSelect = useRef(props.onSelect);
  useEffect(() => {
    onSelect.current = props.onSelect;
  }, [props.onSelect]);
  const owner =
    session.state === 'signed-in' && session.subject && session.csrfToken
      ? `${session.subject}:${session.csrfToken}`
      : null;
  const [previousOwner, setPreviousOwner] = useState(owner);
  const changed = previousOwner !== owner;
  useEffect(() => {
    if (changed) {
      onSelect.current(null);
      setPreviousOwner(owner);
    }
  }, [changed, owner]);
  useEffect(() => () => onSelect.current(null), []);
  return (
    <VerificationSubjectChooserView
      key={`${owner}:${getLocale()}`}
      {...props}
      selected={owner && !changed ? props.selected : null}
      disabled={props.disabled || !owner || changed}
    />
  );
}

/** The production chooser with an injectable transport for focused interface stories. */
export function VerificationSubjectChooserView({
  selected,
  onSelect,
  disabled = false,
  search = nativeSearch,
}: Props & { search?: Search }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const change = useRef<HTMLButtonElement>(null);
  const focus = useRef<'input' | 'change' | null>(null);
  const highlighted = useRef<VerificationSubject | undefined>(undefined);
  const [lookup] = useState(() => new VerificationSubjectSearch(search));
  const state = useSyncExternalStore(lookup.subscribe, lookup.snapshot, lookup.snapshot);
  const [open, setOpen] = useState(false);
  const locale = getLocale();
  useEffect(() => {
    lookup.setEnabled(!disabled && !selected);
    if (disabled || selected) setOpen(false);
    return () => lookup.setEnabled(false);
  }, [lookup, disabled, selected, locale]);
  useEffect(() => {
    if (disabled) focus.current = null;
    else if (focus.current === 'input' && !selected) {
      input.current?.focus();
      focus.current = null;
    } else if (focus.current === 'change' && selected) {
      change.current?.focus();
      focus.current = null;
    }
  }, [disabled, selected]);
  const subjects = !disabled && !selected && state.phase === 'ready' ? state.subjects : [];
  const busy = state.phase === 'pending' || state.phase === 'loading';
  return (
    <Field>
      <FieldLabel id={`${id}-label`} htmlFor={selected ? undefined : `${id}-input`}>
        {m.settings_verification_subject()}
      </FieldLabel>
      {selected ? (
        <div className="flex flex-wrap items-center gap-3" role="group" aria-labelledby={`${id}-label`}>
          <span className="min-w-0 break-words">
            {selected.title} · {selected.type}
          </span>
          <Button
            ref={change}
            type="button"
            variant="outline"
            className="min-h-11 whitespace-normal"
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              lookup.clear();
              focus.current = 'input';
              onSelect(null);
            }}
          >
            {m.settings_verification_change_subject()}
          </Button>
        </div>
      ) : (
        <>
          <Combobox
            items={subjects}
            filter={null}
            value={null}
            inputValue={state.query}
            autoHighlight={false}
            disabled={disabled}
            open={!disabled && open && subjects.length > 0}
            onOpenChange={setOpen}
            itemToStringLabel={(subject: VerificationSubject) => subject.title}
            onItemHighlighted={(subject) => {
              highlighted.current = subject;
            }}
            onInputValueChange={(value, details) => {
              if (details.reason === 'input-change' || details.reason === 'input-clear') {
                lookup.edit(value);
                setOpen(true);
              }
            }}
            onValueChange={(subject) => {
              if (disabled || !subject || !lookup.current(subject)) return;
              lookup.clear();
              setOpen(false);
              focus.current = 'change';
              onSelect(subject);
            }}
          >
            <ComboboxInput
              ref={input}
              id={`${id}-input`}
              className="w-full min-h-11"
              showTrigger={false}
              autoComplete="off"
              maxLength={100}
              disabled={disabled}
              aria-describedby={`${id}-help ${id}-status`}
              aria-busy={!disabled && busy}
              onBlur={() => setOpen(false)}
              onCompositionStart={() => {
                lookup.startComposition();
                setOpen(false);
              }}
              onCompositionEnd={(event) => {
                lookup.endComposition(event.currentTarget.value);
                setOpen(true);
              }}
              onKeyDown={(event) => {
                // Enter chooses only an explicitly highlighted result; it never submits the parent form.
                const composing = lookup.isComposing() || event.nativeEvent.isComposing || event.keyCode === 229;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (composing || !open || !highlighted.current || !lookup.current(highlighted.current))
                    event.preventBaseUIHandler();
                }
                if (composing) {
                  event.preventBaseUIHandler();
                  return;
                }
                if (event.key === 'Escape') setOpen(false);
              }}
            />
            <ComboboxContent>
              <ComboboxList aria-labelledby={`${id}-label`} className="space-y-2 p-2">
                {(subject: VerificationSubject) => (
                  <ComboboxItem key={subject.id} value={subject} className="min-h-11 gap-3 py-3">
                    <span className="min-w-0 break-words">
                      {subject.title} · {subject.type}
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          <FieldDescription id={`${id}-help`}>{m.settings_verification_search_help()}</FieldDescription>
          <p id={`${id}-status`} role="status" aria-live="polite" aria-atomic="true">
            {!disabled && busy ? m.settings_verification_search_loading() : null}
            {!disabled && state.phase === 'ready'
              ? subjects.length
                ? m.settings_verification_search_results({ count: subjects.length })
                : m.settings_verification_search_empty()
              : null}
            {!disabled && state.phase === 'failed' ? m.settings_verification_search_failed() : null}
          </p>
          {!disabled && state.phase === 'failed' ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 justify-self-start"
              onClick={() => {
                lookup.retry();
                setOpen(true);
                input.current?.focus();
              }}
            >
              {m.settings_retry()}
            </Button>
          ) : null}
        </>
      )}
    </Field>
  );
}
