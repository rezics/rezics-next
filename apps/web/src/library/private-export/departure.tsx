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
import { useBlocker } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { m } from '../../paraglide/messages.js';
import { actionClass } from './controls';

export function ExportDeparture({
  active,
  locked,
  onLeave,
}: {
  active: boolean;
  locked: boolean;
  onLeave: () => void;
}) {
  const stay = useRef<HTMLButtonElement>(null);
  const blocker = useBlocker({ shouldBlockFn: () => active, withResolver: true, enableBeforeUnload: active });
  useEffect(() => {
    if (!active && blocker.status === 'blocked') blocker.proceed?.();
  }, [active, blocker]);
  const open = active && blocker.status === 'blocked';
  return (
    <AlertDialog open={open} onOpenChange={(value) => !value && blocker.reset?.()}>
      {open ? (
        <AlertDialogContent initialFocus={stay}>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.library_export_leave_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {locked ? m.library_export_leave_pending() : m.library_export_leave_help()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={stay} className={actionClass} onClick={() => blocker.reset?.()}>
              {m.library_export_stay()}
            </AlertDialogCancel>
            {!locked ? (
              <AlertDialogAction
                className={actionClass}
                onClick={() => {
                  onLeave();
                  blocker.proceed?.();
                }}
              >
                {m.library_export_leave()}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );
}
