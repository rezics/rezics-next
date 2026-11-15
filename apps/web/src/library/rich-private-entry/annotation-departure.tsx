import { useRef } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@rezics/ui/shadcn/alert-dialog';
import { m } from '../../paraglide/messages.js';
import { buttonVariants } from '@rezics/ui/shadcn/button';

export type AnnotationDepartureIntent = 'discard' | 'diary';

/** Only the annotation reset and the existing diary link use this local decision. */
export function AnnotationDeparture({
  intent,
  unresolved,
  sourceOpen,
  diaryHref,
  onStay,
  onDiscard,
  returnFocus,
}: {
  intent: AnnotationDepartureIntent | null;
  unresolved: boolean;
  sourceOpen: boolean;
  diaryHref: string;
  onStay: () => void;
  onDiscard: (leave: boolean) => void;
  returnFocus: HTMLElement | null;
}) {
  const stay = useRef<HTMLButtonElement>(null);
  const locked = unresolved || (intent === 'diary' && sourceOpen);
  return (
    <AlertDialog open={intent !== null} onOpenChange={(open) => !open && onStay()}>
      {intent !== null ? (
        <AlertDialogContent initialFocus={stay} finalFocus={returnFocus ? { current: returnFocus } : undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {unresolved
                ? m.library_annotation_unresolved_title()
                : intent === 'diary'
                  ? m.library_annotation_leave_title()
                  : m.library_annotation_discard_title()}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {unresolved
                ? m.library_annotation_unresolved_departure()
                : locked
                  ? m.library_annotation_source_departure()
                  : intent === 'diary'
                    ? m.library_annotation_leave_help()
                    : m.library_annotation_discard_help()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={stay} onClick={onStay}>
              {m.library_annotation_stay()}
            </AlertDialogCancel>
            {!locked && intent === 'discard' ? (
              <AlertDialogAction onClick={() => onDiscard(false)}>
                {m.library_annotation_confirm_discard()}
              </AlertDialogAction>
            ) : null}
            {!locked && intent === 'diary' ? (
              <a
               className={buttonVariants({ variant: 'outline' })}
                href={diaryHref}
                onClick={() => onDiscard(true)}
              >
                {m.library_annotation_discard_leave()}
              </a>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );
}
