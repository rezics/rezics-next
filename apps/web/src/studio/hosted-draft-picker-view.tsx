import { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { HostedDraftPicker } from './hosted-draft-picker';

/** This disclosure reads nothing until the author opens it. Rows never mount document bodies. */
export function HostedDraftPickerView({
  picker,
  disabled,
  onSelect,
}: {
  picker: HostedDraftPicker;
  disabled: boolean;
  onSelect(postId: string): void;
}) {
  const state = useSyncExternalStore(picker.subscribe, picker.snapshot, picker.snapshot);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (state.kind === 'closed' && returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [state.kind]);
  const id = useId();
  const locale = getLocale();
  const expanded = state.kind !== 'closed' && state.kind !== 'ended';
  const busy = state.kind === 'loading' || (state.kind === 'page' && state.selecting !== null);
  const error = state.kind === 'failed' || state.kind === 'page' ? state.error : null;
  return (
    <div className="studio-stack">
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        aria-expanded={expanded}
        aria-controls={`${id}-picker`}
        disabled={disabled || state.kind === 'ended' || expanded}
        onClick={() => void picker.open()}
      >
        {m.studio_book_pick_draft({}, { locale })}
      </Button>
      {disabled ? <p className="studio-help">{m.studio_book_picker_working({}, { locale })}</p> : null}
      {state.kind === 'ended' ? <p role="status">{m.studio_books_ended({}, { locale })}</p> : null}
      {expanded ? (
        <section id={`${id}-picker`} className="studio-stack" aria-labelledby={`${id}-heading`} aria-busy={busy}>
          <h3 id={`${id}-heading`}>{m.own_drafts_title({}, { locale })}</h3>
          <p className="studio-help">{m.studio_book_picker_help({}, { locale })}</p>
          {state.kind === 'loading' ? <p role="status">{m.own_drafts_loading({}, { locale })}</p> : null}
          {error ? (
            <p role="alert">
              {error === 'denied'
                ? m.own_drafts_denied({}, { locale })
                : error === 'stale'
                  ? m.own_drafts_stale_selection({}, { locale })
                  : error === 'concealed'
                    ? m.own_drafts_selection_unavailable({}, { locale })
                    : m.own_drafts_unavailable({}, { locale })}
            </p>
          ) : null}
          {state.kind === 'page' ? (
            <>
              {state.page.preparing ? <p role="status">{m.own_drafts_preparing({}, { locale })}</p> : null}
              {!state.page.rows.length && !state.page.preparing ? <p>{m.own_drafts_empty({}, { locale })}</p> : null}
              <ol className="studio-draft-list">
                {state.page.rows.map((entry) => (
                  <li key={entry.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={disabled || busy || !picker.canSelect(entry)}
                      onClick={() => onSelect(entry.id)}
                    >
                      {entry.title ?? m.own_drafts_no_title({}, { locale })}
                    </Button>
                    <span className="studio-help">
                      {picker.canSelect(entry)
                        ? m.studio_book_picker_saved({}, { locale })
                        : m.studio_account_continue_drafts({}, { locale })}
                    </span>
                    <time dateTime={entry.savedAt}>{entry.savedAt}</time>
                  </li>
                ))}
              </ol>
              {state.selecting ? <p role="status">{m.studio_book_picker_opening({}, { locale })}</p> : null}
              {state.page.next ? (
                <Button type="button" variant="outline" disabled={disabled || busy} onClick={() => void picker.next()}>
                  {m.studio_book_picker_next({}, { locale })}
                </Button>
              ) : null}
            </>
          ) : null}
          <div className="studio-action-row">
            {state.kind === 'failed' ? (
              <Button type="button" variant="outline" disabled={disabled} onClick={() => void picker.retry()}>
                {m.own_drafts_retry({}, { locale })}
              </Button>
            ) : null}
            <Button type="button" variant="outline" disabled={disabled || busy} onClick={() => void picker.restart()}>
              {m.own_drafts_restart({}, { locale })}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                returnFocus.current = true;
                picker.close();
              }}
            >
              {m.action_cancel({}, { locale })}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
