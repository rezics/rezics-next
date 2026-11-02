import { useRef, useState } from 'react';
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
import { DocumentBody } from '../document-body';
import { m } from '../paraglide/messages.js';
import type { CurrentPost } from './actions';

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full shrink px-4 py-3 leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** This is the admitted 412 read, not a new read or a substitute for unknown-command recovery. */
export function EditConflictRecovery({
  current,
  onReplace,
  returningFocus,
}: {
  current: CurrentPost | undefined;
  onReplace: (post: CurrentPost) => void;
  returningFocus: () => HTMLElement | null;
}) {
  const [reviewing, setReviewing] = useState<CurrentPost | null>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const available = current?.availability === 'available' && current.body !== null;
  return (
    <AlertDialog
      open={current !== undefined && reviewing === current}
      onOpenChange={(open) => {
        if (!open) setReviewing(null);
      }}
    >
      {current ? (
        <Button type="button" variant="outline" className={actionClassName} onClick={() => setReviewing(current)}>
          {m.thread_edit_review_current()}
        </Button>
      ) : null}
      <AlertDialogContent
        className="min-w-0 max-w-lg grid-cols-[minmax(0,1fr)] text-start sm:max-w-xl"
        initialFocus={keepButton}
        finalFocus={() => returningFocus() ?? false}
      >
        <AlertDialogHeader className="min-w-0 place-items-stretch text-start sm:group-data-[size=default]/alert-dialog-content:text-start">
          <AlertDialogTitle>{m.thread_edit_current_title()}</AlertDialogTitle>
          <AlertDialogDescription>{m.thread_edit_replace_description()}</AlertDialogDescription>
        </AlertDialogHeader>
        {available && current && current.body !== null ? (
          <section className="min-w-0 space-y-3" aria-label={m.thread_edit_current_title()}>
            <DocumentBody document={current.body} className="mx-0! w-full overflow-x-auto [overflow-wrap:anywhere]" />
            <p className="text-sm text-muted-foreground">
              {m.thread_history_licence()}: {current.licence}
            </p>
          </section>
        ) : (
          <p role="status">{m.thread_edit_current_unavailable()}</p>
        )}
        <AlertDialogFooter className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
          <AlertDialogCancel ref={keepButton} className={actionClassName}>
            {m.thread_edit_keep_editing()}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className={actionClassName}
            disabled={!available}
            onClick={() => {
              if (!available || !current) return;
              onReplace(current);
              setReviewing(null);
            }}
          >
            {m.thread_edit_replace_current()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
