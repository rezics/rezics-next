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
import { vndbActionClass } from './controls';

export function VndbDeparture({
  active,
  locked,
  onLeave,
}: {
  active: boolean;
  locked: boolean;
  onLeave: () => Promise<boolean>;
}) {
  const stay = useRef<HTMLButtonElement>(null);
  const [leaving, setLeaving] = useState(false);
  const blocker = useBlocker({ shouldBlockFn: () => active, withResolver: true, enableBeforeUnload: active });
  useEffect(() => {
    if (!active && blocker.status === 'blocked') blocker.proceed?.();
  }, [active, blocker]);
  const open = active && blocker.status === 'blocked';

  async function leave() {
    setLeaving(true);
    try {
      if (await onLeave()) blocker.proceed?.();
    } finally {
      setLeaving(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(value) => !value && blocker.reset?.()}>
      {open ? (
        <AlertDialogContent initialFocus={stay}>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.library_vndb_leave_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {locked ? m.library_vndb_leave_pending() : m.library_vndb_leave_help()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={stay} className={vndbActionClass} onClick={() => blocker.reset?.()}>
              {m.library_bangumi_stay()}
            </AlertDialogCancel>
            {!locked ? (
              <AlertDialogAction
                className={vndbActionClass}
                disabled={leaving || !active}
                onClick={(event) => {
                  event.preventDefault();
                  void leave();
                }}
              >
                {leaving ? m.library_vndb_stopping() : m.library_bangumi_leave()}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );
}
