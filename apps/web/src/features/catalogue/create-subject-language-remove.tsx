import { Button } from '@rezics/ui/shadcn/button';
import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { m } from '../../paraglide/messages.js';
import { useEditorLifetime } from './editor-lifetime';

const actionClassName = 'h-auto min-h-11 max-w-full justify-self-start whitespace-normal';
type RemovalChoice = { rowId: string; active: () => boolean };

/** A local choice belongs to one unsent row and the reading that opened it. */
export function CreateSubjectLanguageRemove({
  locale,
  rowId,
  focusId,
  populated,
  disabled,
  onRemove,
}: {
  locale: string;
  rowId: string;
  focusId: string;
  populated: boolean;
  disabled: boolean;
  onRemove: () => boolean;
}) {
  const lifetime = useEditorLifetime();
  const [choice, setChoice] = useState<RemovalChoice | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const current = useRef({ rowId, focusId, disabled, onRemove, lifetime });
  current.current = { rowId, focusId, disabled, onRemove, lifetime };
  const confirming = choice?.rowId === rowId;
  const o = { locale: locale as never };
  const label = m.catalogue_create_remove_language({}, o);

  useLayoutEffect(() => {
    if (confirming) cancel.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [confirming]);

  function dismiss() {
    restoreFocus.current = true;
    setChoice(null);
  }

  function remove(owner: RemovalChoice) {
    const latest = current.current;
    if (!owner.active() || !latest.lifetime.active() || latest.disabled || latest.rowId !== owner.rowId) return;
    let removed = false;
    // Commit the row change before resolving its current surviving focus destination.
    flushSync(() => {
      removed = latest.onRemove();
    });
    if (removed && owner.active() && latest.lifetime.active()) document.getElementById(latest.focusId)?.focus();
  }

  return confirming ? (
    <div
      className="space-y-2"
      role="group"
      aria-label={m.candidate_confirm_title({ action: label }, o)}
      aria-controls={rowId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      <p>{m.candidate_confirm_title({ action: label }, o)}</p>
      <div className="flex flex-wrap gap-2">
        <Button ref={cancel} type="button" variant="outline" className={actionClassName} onClick={dismiss}>
          {m.candidate_cancel({}, o)}
        </Button>
        <Button
          type="button"
          variant="destructive"
          className={actionClassName}
          disabled={disabled}
          onClick={() => remove(choice)}
        >
          {label}
        </Button>
      </div>
    </div>
  ) : (
    <Button
      ref={trigger}
      type="button"
      variant="ghost"
      className={actionClassName}
      aria-controls={rowId}
      disabled={disabled}
      onClick={() => {
        if (!lifetime.active() || current.current.disabled || current.current.rowId !== rowId) return;
        const owner = { rowId, active: lifetime.active };
        if (populated) setChoice(owner);
        else remove(owner);
      }}
    >
      {label}
    </Button>
  );
}
