import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
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
  const [referenceOpen, setReferenceOpen] = useState(true);
  const queryInput = useRef<HTMLInputElement>(null);
  const resultRegion = useRef<HTMLDivElement>(null);
  const selectedRegion = useRef<HTMLDivElement>(null);
  const caller = useMemo(() => ({ active: false }), [picker, disabled]);
  const keyboardPosition = useRef<{
    picker: SetupContextPicker;
    query: string;
    cursor: string | undefined;
    version: number;
    ownsFocus: () => boolean;
    cancel: () => void;
  } | null>(null);
  const selectionPosition = useRef<{
    picker: SetupContextPicker;
    id: string | null;
    destination: 'selected' | 'query';
    version: number;
    ownsFocus: () => boolean;
    cancel: () => void;
  } | null>(null);
  const { current, selected, page, reference } = state;
  const currentVersion = picker.currentVersion();
  const searchVersion = picker.searchVersion();
  const selectionVersion = picker.selectionVersion();
  const referenceVersion = picker.referenceVersion();
  const referenceDraft = reference.trim();
  const hasReferenceDraft = referenceDraft !== '' && reference !== (current?.id ?? '');
  useLayoutEffect(() => {
    caller.active = true;
    return () => {
      caller.active = false;
      keyboardPosition.current?.cancel();
      selectionPosition.current?.cancel();
    };
  }, [caller]);
  useLayoutEffect(() => {
    const pending = keyboardPosition.current;
    if (!pending) return;
    if (
      disabled ||
      pending.picker !== picker ||
      pending.version !== picker.searchVersion() ||
      pending.query !== state.query ||
      pending.cursor !== page.cursor ||
      !pending.ownsFocus()
    ) {
      pending.cancel();
      return;
    }
    if (page.phase !== 'loading') {
      pending.cancel();
      resultRegion.current?.focus();
    }
  }, [disabled, page, picker, state.query]);
  useLayoutEffect(() => {
    const pending = selectionPosition.current;
    if (!pending) return;
    const selected = picker.getSnapshot().selected;
    if (
      disabled ||
      pending.picker !== picker ||
      pending.version !== picker.selectionVersion() ||
      !pending.ownsFocus() ||
      (pending.destination === 'selected' && selected?.id !== pending.id) ||
      (pending.destination === 'query' && selected !== null)
    ) {
      pending.cancel();
      return;
    }
    if (pending.destination === 'selected' && selected?.phase !== 'loading') {
      pending.cancel();
      if (selectedRegion.current?.isConnected) selectedRegion.current.focus();
    } else if (pending.destination === 'query') {
      pending.cancel();
      if (queryInput.current?.isConnected) queryInput.current.focus();
    }
  }, [disabled, picker, selectionVersion, selected]);
  const pageAction = (
    event: MouseEvent<HTMLButtonElement>,
    cursor: string | undefined,
    action: () => boolean | void,
  ) => {
    // A retained handler cannot regain ownership after a picker/disabled ABA visit or unmount.
    if (!caller.active || disabled || picker.searchVersion() !== searchVersion) return;
    selectionPosition.current?.cancel();
    keyboardPosition.current?.cancel();
    if (event.detail === 0) {
      const document = event.currentTarget.ownerDocument;
      const owner = document.activeElement;
      const cancel = () => {
        if (keyboardPosition.current === pending) keyboardPosition.current = null;
        document.removeEventListener('focusin', focusMoved, true);
        document.removeEventListener('focusout', focusLeft, true);
        for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click'])
          document.removeEventListener(type, cancel, true);
        document.removeEventListener('keydown', cancel, true);
        document.defaultView?.removeEventListener('blur', cancel);
      };
      const focusMoved = (event: FocusEvent) => {
        if (event.target !== owner) cancel();
      };
      const focusLeft = (event: FocusEvent) => {
        if ((owner?.isConnected && !owner.matches(':disabled')) || event.relatedTarget !== null) cancel();
      };
      const pending = {
        picker,
        query: state.query,
        cursor,
        version: searchVersion + 1,
        // Loading removes its button. The resulting body fallback is not a new focus choice.
        ownsFocus: () =>
          document.activeElement === owner ||
          (!!owner && (!owner.isConnected || owner.matches(':disabled')) && document.activeElement === document.body),
        cancel,
      };
      keyboardPosition.current = pending;
      document.addEventListener('focusin', focusMoved, true);
      document.addEventListener('focusout', focusLeft, true);
      for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click'])
        document.addEventListener(type, cancel, true);
      document.addEventListener('keydown', cancel, true);
      document.defaultView?.addEventListener('blur', cancel);
    }
    const pending = keyboardPosition.current;
    const accepted = action();
    if (!caller.active || accepted === false || picker.searchVersion() !== searchVersion + 1) pending?.cancel();
  };
  const selectionAction = (
    event: MouseEvent<HTMLButtonElement>,
    expectedId: string | null,
    destination: 'selected' | 'query',
    action: () => Promise<void> | void,
  ) => {
    if (!caller.active || disabled || picker.selectionVersion() !== selectionVersion) return;
    keyboardPosition.current?.cancel();
    selectionPosition.current?.cancel();
    const before = picker.selectionVersion();
    let pending: typeof selectionPosition.current = null;
    if (event.detail === 0) {
      const document = event.currentTarget.ownerDocument;
      const owner = document.activeElement;
      const cancel = () => {
        if (selectionPosition.current === pending) selectionPosition.current = null;
        document.removeEventListener('focusin', focusMoved, true);
        document.removeEventListener('focusout', focusLeft, true);
        for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click'])
          document.removeEventListener(type, cancel, true);
        document.removeEventListener('keydown', cancel, true);
        document.defaultView?.removeEventListener('blur', cancel);
      };
      const focusMoved = (event: FocusEvent) => {
        if (event.target !== owner) cancel();
      };
      const focusLeft = (event: FocusEvent) => {
        if ((owner?.isConnected && !owner.matches(':disabled')) || event.relatedTarget !== null) cancel();
      };
      pending = {
        picker,
        id: expectedId,
        destination,
        version: before + 1,
        ownsFocus: () =>
          document.activeElement === owner ||
          (!!owner && (!owner.isConnected || owner.matches(':disabled')) && document.activeElement === document.body),
        cancel,
      };
      selectionPosition.current = pending;
      document.addEventListener('focusin', focusMoved, true);
      document.addEventListener('focusout', focusLeft, true);
      for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click'])
        document.addEventListener(type, cancel, true);
      document.addEventListener('keydown', cancel, true);
      document.defaultView?.addEventListener('blur', cancel);
    }
    void action();
    const selected = picker.getSnapshot().selected;
    if (
      !caller.active ||
      picker.selectionVersion() !== before + 1 ||
      (destination === 'selected' && selected?.id !== expectedId) ||
      (destination === 'query' && selected !== null)
    )
      pending?.cancel();
  };
  return (
    <Field className="min-w-0 max-w-full [overflow-wrap:anywhere]">
      <div className="flex min-w-0 flex-col gap-1">
        <FieldLabel className="min-w-0 max-w-full" htmlFor={`${id}-query`}>
          {m.space_setup_context_label()}
        </FieldLabel>
      </div>
      {current ? (
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4">
          <div id={`${id}-current-reading`} className="flex min-w-0 flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">{m.setup_context_current()}</p>
            <Resolution value={current} saved />
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-7 max-w-full text-start whitespace-normal"
              aria-describedby={`${id}-current-reading`}
              disabled={disabled || current.phase === 'loading'}
              onClick={() => void picker.retryCurrent(current.id, currentVersion)}
            >
              {m.setup_context_check_current()}
            </Button>
            {current.phase === 'ready' ? (
              <Button
                type="button"
                variant="ghost"
                className="h-auto min-h-7 max-w-full text-start whitespace-normal"
                aria-describedby={`${id}-current-reading`}
                disabled={disabled}
                onClick={(event) =>
                  selectionAction(event, current.id, 'selected', () => picker.chooseCurrent(current.id, currentVersion))
                }
              >
                {m.setup_context_use_current()}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {selected ? (
        <div
          ref={selectedRegion}
          id={`${id}-selected-reading`}
          role="group"
          aria-labelledby={`${id}-selected-label`}
          tabIndex={-1}
          className="flex min-w-0 flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <div id={`${id}-selected-label`} className="flex min-w-0 items-start gap-2 text-sm font-medium">
            {selected.phase === 'ready' ? (
              <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            ) : null}
            {m.setup_context_selected()}
          </div>
          <div id={`${id}-selected-description`} className="flex min-w-0 flex-col gap-1">
            <Resolution value={selected} />
            {current && current.id !== selected.id ? (
              <p className="text-sm text-muted-foreground">{m.setup_context_changed()}</p>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            {selected.phase === 'denied' || selected.phase === 'unavailable' ? (
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-7 max-w-full text-start whitespace-normal"
                aria-describedby={`${id}-selected-label ${id}-selected-description`}
                disabled={disabled}
                onClick={(event) =>
                  selectionAction(event, selected.id, 'selected', () =>
                    picker.retrySelected(selected.id, selected.phase, selectionVersion),
                  )
                }
              >
                {m.space_setup_retry()}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-h-7 max-w-full text-start whitespace-normal"
              aria-describedby={`${id}-selected-label ${id}-selected-description`}
              disabled={disabled}
              onClick={(event) =>
                selectionAction(event, null, 'query', () => picker.clear(selected.id, selectionVersion))
              }
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
          className="ps-9"
          placeholder={m.setup_context_placeholder()}
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
          className="flex min-w-0 flex-col items-start gap-3 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {page.phase === 'loading' ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m.setup_context_searching()}
            </p>
          ) : null}
          {page.phase === 'ready' ? (
            <>
              <p id={`${id}-results-reading`} className="text-sm text-muted-foreground">
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
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={disabled}
                        aria-describedby={`${id}-results-reading`}
                        onClick={(event) =>
                          selectionAction(event, choice.id, 'selected', () =>
                            picker.choosePage(choice.id, {
                              query: state.query,
                              ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
                              version: searchVersion,
                            }),
                          )
                        }
                        className="h-auto min-h-7 w-full max-w-full flex-col items-start gap-1 whitespace-normal text-start"
                      >
                        <span className="min-w-0 max-w-full text-sm font-medium leading-relaxed">
                          <bdi>{choice.label}</bdi>
                        </span>
                        <span className="min-w-0 max-w-full break-all font-mono text-xs leading-relaxed text-muted-foreground">
                          <bdi dir="ltr">{choice.id}</bdi>
                        </span>
                      </Button>
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
                  className="h-auto min-h-7 max-w-full text-start whitespace-normal"
                  disabled={disabled}
                  aria-describedby={`${id}-results-reading`}
                  onClick={(event) =>
                    pageAction(event, page.next!, () =>
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
              <p id={`${id}-page-error-reading`} role="alert" className="text-sm">
                {page.phase === 'denied' ? m.setup_context_denied() : m.setup_context_unavailable()}
              </p>
              <div className="flex min-w-0 flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-7 max-w-full text-start whitespace-normal"
                  aria-describedby={`${id}-page-error-reading`}
                  disabled={disabled}
                  onClick={(event) =>
                    pageAction(event, page.cursor, () =>
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
                    className="h-auto min-h-7 max-w-full text-start whitespace-normal"
                    aria-describedby={`${id}-page-error-reading`}
                    disabled={disabled}
                    onClick={(event) =>
                      pageAction(
                        event,
                        undefined,
                        () => picker.restartSearch({ query: state.query, cursor: page.cursor!, version: searchVersion }),
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
      {!referenceOpen && hasReferenceDraft ? (
        <div
          id={`${id}-reference-draft-reading`}
          role="group"
          aria-labelledby={`${id}-reference-draft-label`}
          className="flex min-w-0 flex-col gap-1 rounded-xl border border-border p-3"
        >
          <p id={`${id}-reference-draft-label`} className="text-xs font-medium text-muted-foreground">
            {m.space_setup_reference()}
          </p>
          <p className="break-all font-mono text-xs leading-relaxed text-muted-foreground">
            <bdi dir="ltr">{reference}</bdi>
          </p>
        </div>
      ) : null}
      <details
        className="min-w-0 max-w-full rounded-xl border border-border p-3"
        open={referenceOpen}
        onToggle={(event) => setReferenceOpen(event.currentTarget.open)}
      >
        <summary className="max-w-full cursor-pointer content-center text-start text-sm font-medium whitespace-normal">
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
              className="min-w-0 flex-1 basis-64 font-mono text-sm"
              onChange={(event) => picker.reference(event.target.value, reference, referenceVersion)}
            />
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-7 max-w-full text-start whitespace-normal"
              aria-describedby={`${id}-reference-hint`}
              disabled={
                disabled ||
                selected?.phase === 'loading' ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference.trim())
              }
              onClick={(event) =>
                selectionAction(event, reference.trim(), 'selected', () =>
                  picker.chooseReference(reference.trim(), referenceVersion),
                )
              }
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
