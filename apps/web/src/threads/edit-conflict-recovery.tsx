import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { CurrentPost } from './actions';
import { CurrentConflictReading, EditConflictComparison, conflictActionClassName } from './edit-conflict-comparison';
import { ConflictInspection, type ConflictPresentation, type ConflictInvalidation } from './edit-conflict-inspection';
import { useConflictReturn } from './edit-conflict-return';

function invalidationMessage(reason: ConflictInvalidation): string {
  switch (reason) {
    case 'draft':
      return m.thread_inspect_draft_changed();
    case 'current':
      return m.thread_inspect_current_changed();
    case 'retired':
      return m.thread_authoring_session_changed();
  }
}

/** Only the caller's definitive 412 result can enter this visit. It starts no read or write. */
export function EditConflictRecovery({
  current,
  onReplace,
  returningFocus,
  presentation,
}: {
  current: CurrentPost | undefined;
  onReplace: (post: CurrentPost) => void;
  returningFocus: () => HTMLElement | null;
  /** Opt in to paired inspection; callers without a draft port retain single-reader behavior. */
  presentation?: ConflictPresentation;
}) {
  const [eventInvalidation, setEventInvalidation] = useState<ConflictInvalidation | null>(null);
  const [reviewing, setReviewing] = useState<ConflictInspection | null>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const returnOwner = useRef<Pick<ConflictPresentation, 'authority' | 'signal'> | null>(null);
  const latest = useRef({ current, presentation, onReplace });
  latest.current = { current, presentation, onReplace };
  const focus = useConflictReturn({
    returningFocus,
    admitted: () => {
      const original = returnOwner.current;
      const port = latest.current.presentation;
      return original
        ? !!port &&
            port.authority === original.authority &&
            port.signal === original.signal &&
            !original.signal.aborted &&
            port.read() !== null
        : port === undefined;
    },
  });
  const invalidation = reviewing?.validate(current, presentation) ?? eventInvalidation;
  const snapshot = invalidation ? undefined : reviewing?.current;
  const draft = invalidation ? undefined : reviewing?.draftProjection;
  const available = snapshot?.availability === 'available' && snapshot.body !== null;
  const ready =
    available && (!presentation || (reviewing?.currentProjection?.state === 'ready' && draft?.state === 'ready'));

  useEffect(() => {
    if (!reviewing) return;
    const signal = presentation?.signal;
    const retire = () => {
      reviewing.clear();
      focus.retire();
      setReviewing(null);
    };
    if (signal?.aborted) retire();
    signal?.addEventListener('abort', retire, { once: true });
    return () => {
      signal?.removeEventListener('abort', retire);
      reviewing.clear();
    };
  }, [reviewing, presentation?.signal]);

  function valid(): boolean {
    const next = latest.current;
    return reviewing !== null && reviewing.validate(next.current, next.presentation) === null;
  }

  function guardReading(event: SyntheticEvent) {
    if (valid()) return;
    event.preventDefault();
    event.stopPropagation();
    setEventInvalidation(reviewing?.validate(latest.current.current, latest.current.presentation) ?? 'retired');
  }

  function close() {
    reviewing?.clear();
    setReviewing(null);
    setEventInvalidation(null);
  }

  function replace() {
    const next = latest.current;
    const replacement = reviewing?.replacement(next.current, next.presentation);
    if (!replacement || !ready) {
      setEventInvalidation(reviewing?.validate(next.current, next.presentation) ?? null);
      return;
    }
    // The owner still performs confirmation semantics, upload retirement and command reset.
    focus.replacing();
    reviewing?.clear();
    setReviewing(null);
    next.onReplace(replacement);
  }

  return (
    <AlertDialog
      open={current !== undefined && reviewing !== null && invalidation !== 'retired'}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {current ? (
        <Button
          type="button"
          variant="outline"
          className={conflictActionClassName}
          disabled={presentation?.inspectable === false}
          onClick={(event) => {
            if (presentation && (presentation.signal.aborted || !presentation.read())) return;
            returnOwner.current = presentation
              ? { authority: presentation.authority, signal: presentation.signal }
              : null;
            focus.capture(event.currentTarget);
            const visit = new ConflictInspection(current, presentation);
            setEventInvalidation(null);
            setReviewing(visit);
          }}
        >
          {m.thread_edit_review_current()}
        </Button>
      ) : null}
      <AlertDialogContent
        ref={focus.popup}
        className={
          presentation
            ? 'min-w-0 max-w-6xl! grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden! text-start p-4 sm:p-6'
            : 'min-w-0 max-w-lg grid-cols-[minmax(0,1fr)] text-start sm:max-w-xl'
        }
        initialFocus={keepButton}
        finalFocus={() => focus.resolve()}
      >
        <AlertDialogHeader className="min-w-0 place-items-stretch text-start sm:group-data-[size=default]/alert-dialog-content:text-start">
          <AlertDialogTitle>{presentation ? m.thread_inspect_title() : m.thread_edit_current_title()}</AlertDialogTitle>
          <AlertDialogDescription>{m.thread_edit_replace_description()}</AlertDialogDescription>
        </AlertDialogHeader>
        {invalidation ? (
          <p role="alert">{invalidationMessage(invalidation)}</p>
        ) : draft ? (
          <div
            className="min-h-0 min-w-0 overflow-y-auto overscroll-contain"
            onClickCapture={guardReading}
            onKeyDownCapture={guardReading}
            onPointerDownCapture={guardReading}
          >
            <EditConflictComparison
              draft={draft}
              current={reviewing?.currentProjection}
              licence={available ? snapshot!.licence : undefined}
              createdAt={available ? snapshot!.createdAt : undefined}
              revisedAt={available ? snapshot!.revisedAt : undefined}
              erased={snapshot?.availability === 'erased'}
              allowed={valid}
            />
          </div>
        ) : available && snapshot && snapshot.body !== null ? (
          <CurrentConflictReading body={snapshot.body} licence={snapshot.licence} />
        ) : (
          <p role="status">{m.thread_edit_current_unavailable()}</p>
        )}
        <AlertDialogFooter className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
          <AlertDialogCancel ref={keepButton} className={conflictActionClassName}>
            {m.thread_edit_keep_editing()}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className={conflictActionClassName}
            disabled={!available || !ready || invalidation !== null}
            onClick={replace}
          >
            {m.thread_edit_replace_current()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
