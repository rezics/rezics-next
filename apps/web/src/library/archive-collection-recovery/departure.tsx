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
import { useEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { actionClass } from '../private-export/controls';

export function ArchiveRecoveryDeparture({
  active,
  locked,
  busy,
  canCancel,
  onLeave,
  onCancel,
}: {
  active: boolean;
  locked: boolean;
  busy: boolean;
  canCancel: boolean;
  onLeave: () => void;
  onCancel: () => void;
}) {
  const stay = useRef<HTMLButtonElement>(null);
  const blocker = useBlocker({ shouldBlockFn: () => active, withResolver: true, enableBeforeUnload: active });
  const [confirmCancel, setConfirmCancel] = useState(false);
  useEffect(() => {
    if (!active && blocker.status === 'blocked') blocker.proceed?.();
  }, [active, blocker]);
  const open = active && blocker.status === 'blocked';
  return (
    <div className="flex flex-wrap gap-3">
      {canCancel ? (
        <button type="button" className={actionClass} disabled={busy || locked} onClick={() => setConfirmCancel(true)}>
          {m.library_archive_recovery_cancel()}
        </button>
      ) : null}
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.library_archive_recovery_cancel_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.library_archive_recovery_cancel_help()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={actionClass} disabled={busy} onClick={() => setConfirmCancel(false)}>
              {m.library_archive_recovery_stay()}
            </AlertDialogCancel>
            <AlertDialogAction
              className={actionClass}
              disabled={busy || locked}
              onClick={() => {
                setConfirmCancel(false);
                onCancel();
              }}
            >
              {m.library_archive_recovery_confirm_cancel()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={open} onOpenChange={(value) => !value && blocker.reset?.()}>
        {open ? (
          <AlertDialogContent initialFocus={stay}>
            <AlertDialogHeader>
              <AlertDialogTitle>{m.library_archive_recovery_leave_title()}</AlertDialogTitle>
              <AlertDialogDescription>
                {locked ? m.library_archive_recovery_leave_pending() : m.library_archive_recovery_leave_help()}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel ref={stay} className={actionClass} onClick={() => blocker.reset?.()}>
                {m.library_archive_recovery_stay()}
              </AlertDialogCancel>
              {!locked ? (
                <AlertDialogAction
                  className={actionClass}
                  onClick={() => {
                    onLeave();
                    blocker.proceed?.();
                  }}
                >
                  {m.library_archive_recovery_leave()}
                </AlertDialogAction>
              ) : null}
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
}
