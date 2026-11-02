import { useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Check, Search } from 'lucide-react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import type { ContextResolution, SetupContextPicker } from './setup-context-picker';

function Resolution({ value, saved = false }: { value: ContextResolution; saved?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {value.phase === 'ready' ? (
        <p className="min-w-0 font-medium leading-relaxed">
          <bdi>{value.choice?.label}</bdi>
        </p>
      ) : null}
      <p className="break-all font-mono text-xs leading-relaxed text-muted-foreground">
        <bdi dir="ltr">{value.id}</bdi>
      </p>
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
  const queryInput = useRef<HTMLInputElement>(null);
  const resultRegion = useRef<HTMLDivElement>(null);
  const keyboardPosition = useRef<{
    picker: SetupContextPicker;
    query: string;
    cursor: string | undefined;
    version: number;
  } | null>(null);
  const { current, selected, page, reference } = state;
  const currentVersion = picker.currentVersion();
  const searchVersion = picker.searchVersion();
  const selectionVersion = picker.selectionVersion();
  const referenceVersion = picker.referenceVersion();
  useLayoutEffect(() => {
    const pending = keyboardPosition.current;
    if (!pending) return;
    if (
      disabled ||
      pending.picker !== picker ||
      pending.version !== picker.searchVersion() ||
      pending.query !== state.query ||
      pending.cursor !== page.cursor
    ) {
      keyboardPosition.current = null;
      return;
    }
    if (page.phase !== 'loading') {
      resultRegion.current?.focus();
      keyboardPosition.current = null;
    }
  }, [disabled, page, picker, state.query]);
  const pageAction = (detail: number, cursor: string | undefined, action: () => boolean | void, mouseAccepted?: () => void) => {
    const pending =
      detail === 0
        ? { picker, query: state.query, cursor, version: searchVersion + 1 }
        : null;
    keyboardPosition.current = pending;
    const accepted = action();
    if (pending && (accepted === false || picker.searchVersion() !== pending.version)) keyboardPosition.current = null;
    else if (!pending && accepted !== false) mouseAccepted?.();
  };
  return (
    <Field className="min-w-0 max-w-full [overflow-wrap:anywhere]">
      <div className="flex min-w-0 flex-col gap-1">
        <FieldLabel className="min-w-0 max-w-full" htmlFor={`${id}-query`}>
          {m.space_setup_context_label()}
        </FieldLabel>
        <FieldDescription className="text-start" id={`${id}-hint`}>
          {m.setup_context_hint()}
        </FieldDescription>
      </div>
      {current ? (
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4">
          <p className="text-xs font-medium text-muted-foreground">{m.setup_context_current()}</p>
          <Resolution value={current} saved />
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
              disabled={disabled || current.phase === 'loading'}
              onClick={() => void picker.retryCurrent(current.id, currentVersion)}
            >
              {m.setup_context_check_current()}
            </Button>
            {current.phase === 'ready' ? (
              <Button
                type="button"
                variant="ghost"
                className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
                disabled={disabled}
                onClick={() => void picker.chooseCurrent(current.id, currentVersion)}
              >
                {m.setup_context_use_current()}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {selected ? (
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <p className="flex min-w-0 items-start gap-2 text-sm font-medium">
            {selected.phase === 'ready' ? (
              <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            ) : null}
            {m.setup_context_selected()}
          </p>
          <Resolution value={selected} />
          {current && current.id !== selected.id ? (
            <p className="text-sm text-muted-foreground">{m.setup_context_changed()}</p>
          ) : null}
          <div className="flex min-w-0 flex-wrap gap-2">
            {selected.phase === 'denied' || selected.phase === 'unavailable' ? (
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
                disabled={disabled}
                onClick={() => void picker.retrySelected(selected.id, selected.phase, selectionVersion)}
              >
                {m.space_setup_retry()}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
              disabled={disabled}
              onClick={() => picker.clear(selected.id, selectionVersion)}
            >
              {m.setup_context_clear()}
            </Button>
          </div>
        </div>
      ) : null}
      <div className="relative min-w-0">
        <Search
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={queryInput}
          id={`${id}-query`}
          type="search"
          value={state.query}
          maxLength={256}
          className="h-auto min-h-11 ps-9 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
          placeholder={m.setup_context_placeholder()}
          aria-describedby={`${id}-hint`}
          disabled={disabled}
          onFocus={() => {
            if (page.phase === 'idle') picker.search(state.query, state.query, searchVersion);
          }}
          onChange={(event) => picker.search(event.target.value, state.query, searchVersion)}
        />
      </div>
      {page.phase !== 'idle' ? (
        <div
          ref={resultRegion}
          role="region"
          aria-label={m.setup_context_results_label()}
          aria-live="polite"
          aria-busy={page.phase === 'loading'}
          tabIndex={-1}
          className="flex min-w-0 flex-col items-start gap-3"
        >
          {page.phase === 'loading' ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m.setup_context_searching()}
            </p>
          ) : null}
          {page.phase === 'ready' ? (
            <>
              <p className="text-sm text-muted-foreground">
                {state.query.trim()
                  ? m.setup_context_results({ query: state.query.trim() })
                  : m.setup_context_results_all()}
              </p>
              {page.contexts.length ? (
                <ul
                  aria-label={m.setup_context_results_label()}
                  className="w-full min-w-0 divide-y divide-border rounded-xl border border-border"
                >
                  {page.contexts.map((choice) => (
                    <li key={choice.id} className="min-w-0">
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                          void picker.choosePage(choice.id, {
                            query: state.query,
                            ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
                            version: searchVersion,
                          })
                        }
                        className="flex h-auto min-h-14 min-w-0 w-full max-w-full flex-col gap-1 rounded-lg px-4 py-3 text-start whitespace-normal hover:bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
                      >
                        <span className="min-w-0 max-w-full text-sm font-medium leading-relaxed">
                          <bdi>{choice.label}</bdi>
                        </span>
                        <span className="min-w-0 max-w-full break-all font-mono text-xs leading-relaxed text-muted-foreground">
                          <bdi dir="ltr">{choice.id}</bdi>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{m.setup_context_empty()}</p>
              )}
              {page.next !== null ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
                  disabled={disabled}
                  onClick={(event) =>
                    pageAction(event.detail, page.next, () =>
                      picker.next({
                        query: state.query,
                        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
                        next: page.next,
                        version: searchVersion,
                      }),
                    )
                  }
                >
                  {m.setup_context_next()}
                </Button>
              ) : null}
            </>
          ) : null}
          {page.phase === 'unavailable' || page.phase === 'denied' ? (
            <div className="flex min-w-0 flex-col items-start gap-3 rounded-xl bg-muted p-4">
              <p role="alert" className="text-sm">
                {page.phase === 'denied' ? m.setup_context_denied() : m.setup_context_unavailable()}
              </p>
              <div className="flex min-w-0 flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
                  disabled={disabled}
                  onClick={(event) =>
                    pageAction(event.detail, page.cursor, () =>
                      picker.retrySearch({
                        query: state.query,
                        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
                        version: searchVersion,
                      }),
                    )
                  }
                >
                  {m.space_setup_retry()}
                </Button>
                {page.phase === 'unavailable' && page.cursor !== undefined ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
                    disabled={disabled}
                    onClick={(event) =>
                      pageAction(
                        event.detail,
                        undefined,
                        () => picker.restartSearch({ query: state.query, cursor: page.cursor!, version: searchVersion }),
                        () => queryInput.current?.focus(),
                      )
                    }
                  >
                    {m.setup_context_restart()}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <details className="min-w-0 max-w-full rounded-xl border border-border p-3" open={selected?.phase !== 'ready'}>
        <summary className="min-h-11 min-w-11 max-w-full cursor-pointer content-center rounded-md py-2 text-start text-sm font-medium whitespace-normal focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring">
          {m.space_setup_load_existing()}
        </summary>
        <div className="mt-3 flex min-w-0 flex-col gap-3">
          <FieldDescription className="text-start" id={`${id}-reference-hint`}>
            {m.space_setup_reference_hint()}
          </FieldDescription>
          <label htmlFor={`${id}-reference`} className="text-sm">
            {m.space_setup_reference()}
          </label>
          <div className="flex min-w-0 flex-wrap gap-2">
            <Input
              id={`${id}-reference`}
              dir="ltr"
              value={reference}
              maxLength={36}
              disabled={disabled || selected?.phase === 'loading'}
              aria-describedby={`${id}-reference-hint`}
              className="h-auto min-h-11 min-w-0 flex-1 basis-64 font-mono text-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
              onChange={(event) => picker.reference(event.target.value, reference, referenceVersion)}
            />
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
              disabled={
                disabled ||
                selected?.phase === 'loading' ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference.trim())
              }
              onClick={() => void picker.chooseReference(reference.trim(), referenceVersion)}
            >
              {selected?.phase === 'loading' ? m.space_setup_loading() : m.space_setup_resolve()}
            </Button>
          </div>
        </div>
      </details>
      <FieldDescription className="text-start">{m.setup_context_keep_draft()}</FieldDescription>
    </Field>
  );
}
