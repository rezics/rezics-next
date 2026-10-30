import { useId, useSyncExternalStore } from 'react';
import { Check, Search } from 'lucide-react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import type { ContextResolution, SetupContextPicker } from './setup-context-picker';

function Resolution({ value, saved = false }: { value: ContextResolution; saved?: boolean }) {
  return (
    <div className="min-w-0 space-y-1">
      {value.phase === 'ready' ? <p className="break-words font-medium">{value.choice?.label}</p> : null}
      <p className="break-all font-mono text-xs text-muted-foreground">{value.id}</p>
      {value.phase !== 'ready' ? (
        <p role={saved || value.phase === 'loading' ? 'status' : 'alert'} className="text-sm text-muted-foreground">
          {value.phase === 'loading'
            ? m.space_setup_loading()
            : value.phase === 'denied'
              ? m.setup_context_denied()
              : m.setup_context_unavailable()}
        </p>
      ) : null}
    </div>
  );
}

/** Lives inside the shared Realm settings form; never submits a command or changes the stored pointer. */
export function SetupContextPickerField({ picker, disabled }: { picker: SetupContextPicker; disabled: boolean }) {
  const state = useSyncExternalStore(picker.subscribe, picker.getSnapshot, picker.getSnapshot);
  const id = useId();
  const { current, selected, page, reference } = state;
  return (
    <Field className="min-w-0">
      <div className="space-y-1">
        <FieldLabel htmlFor={`${id}-query`}>{m.space_setup_context_label()}</FieldLabel>
        <FieldDescription id={`${id}-hint`}>{m.setup_context_hint()}</FieldDescription>
      </div>
      {current ? (
        <div className="space-y-3 rounded-xl border border-border p-4">
          <p className="text-xs font-medium text-muted-foreground">{m.setup_context_current()}</p>
          <Resolution value={current} saved />
          <Button
            type="button"
            variant="outline"
            disabled={disabled || current.phase === 'loading'}
            onClick={() => void picker.retryCurrent()}
          >
            {m.setup_context_check_current()}
          </Button>
          {current.phase === 'ready' ? (
            <Button type="button" variant="ghost" disabled={disabled} onClick={() => void picker.choose(current.id)}>
              {m.setup_context_use_current()}
            </Button>
          ) : null}
        </div>
      ) : null}
      {selected ? (
        <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            {selected.phase === 'ready' ? <Check className="size-4 text-primary" aria-hidden="true" /> : null}
            {m.setup_context_selected()}
          </p>
          <Resolution value={selected} />
          {current && current.id !== selected.id ? (
            <p className="text-sm text-muted-foreground">{m.setup_context_changed()}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {selected.phase === 'denied' || selected.phase === 'unavailable' ? (
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => void picker.choose(selected.id)}
              >
                {m.space_setup_retry()}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" disabled={disabled} onClick={() => picker.clear()}>
              {m.setup_context_clear()}
            </Button>
          </div>
        </div>
      ) : null}
      <div className="relative">
        <Search
          className="pointer-events-none absolute start-3 top-3 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id={`${id}-query`}
          type="search"
          value={state.query}
          maxLength={256}
          className="ps-9"
          placeholder={m.setup_context_placeholder()}
          aria-describedby={`${id}-hint`}
          disabled={disabled}
          onFocus={() => {
            if (page.phase === 'idle') picker.search(state.query);
          }}
          onChange={(event) => picker.search(event.target.value)}
        />
      </div>
      {page.phase === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.setup_context_searching()}
        </p>
      ) : null}
      {page.phase === 'ready' ? (
        <div className="space-y-3" aria-live="polite">
          <p className="text-sm text-muted-foreground">
            {state.query.trim()
              ? m.setup_context_results({ query: state.query.trim() })
              : m.setup_context_results_all()}
          </p>
          {page.contexts.length ? (
            <ul
              aria-label={m.setup_context_results_label()}
              className="divide-y divide-border overflow-hidden rounded-xl border border-border"
            >
              {page.contexts.map((choice) => (
                <li key={choice.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void picker.choose(choice.id)}
                    className="flex min-h-14 w-full flex-col gap-1 px-4 py-3 text-start hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                  >
                    <span className="break-words text-sm font-medium">{choice.label}</span>
                    <span className="break-all font-mono text-xs text-muted-foreground">{choice.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{m.setup_context_empty()}</p>
          )}
          {page.next !== null ? (
            <Button type="button" variant="outline" disabled={disabled} onClick={() => picker.next()}>
              {m.setup_context_next()}
            </Button>
          ) : null}
        </div>
      ) : null}
      {page.phase === 'unavailable' || page.phase === 'denied' ? (
        <div className="space-y-3 rounded-xl bg-muted p-4">
          <p role="alert" className="text-sm">
            {page.phase === 'denied' ? m.setup_context_denied() : m.setup_context_unavailable()}
          </p>
          <Button type="button" variant="outline" disabled={disabled} onClick={() => picker.retrySearch()}>
            {m.space_setup_retry()}
          </Button>
        </div>
      ) : null}
      <details className="rounded-xl border border-border p-3" open={selected?.phase !== 'ready'}>
        <summary className="cursor-pointer text-sm font-medium">{m.space_setup_load_existing()}</summary>
        <div className="mt-3 space-y-3">
          <FieldDescription id={`${id}-reference-hint`}>{m.space_setup_reference_hint()}</FieldDescription>
          <label htmlFor={`${id}-reference`} className="text-sm">
            {m.space_setup_reference()}
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={`${id}-reference`}
              value={reference}
              maxLength={36}
              disabled={disabled || selected?.phase === 'loading'}
              aria-describedby={`${id}-reference-hint`}
              className="min-w-0 flex-1 basis-48"
              onChange={(event) => picker.reference(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={
                disabled ||
                selected?.phase === 'loading' ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference.trim())
              }
              onClick={() => void picker.choose(reference.trim())}
            >
              {selected?.phase === 'loading' ? m.space_setup_loading() : m.space_setup_resolve()}
            </Button>
          </div>
        </div>
      </details>
      <FieldDescription>{m.setup_context_keep_draft()}</FieldDescription>
    </Field>
  );
}
