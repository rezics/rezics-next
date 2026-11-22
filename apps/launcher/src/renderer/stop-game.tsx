import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@rezics/ui/shadcn/alert-dialog';
import { Button } from '@rezics/ui/shadcn/button';
import { useState } from 'react';
import { Failure, useAction } from './actions';

export function StopGame({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const stop = useAction();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!stop.pending) setOpen(next);
      }}
    >
      <AlertDialogTrigger render={<Button size="sm" variant="outline" />}>Force stop</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Force stop this game?</AlertDialogTitle>
          <AlertDialogDescription>
            The game will close immediately. Unsaved progress may be lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Failure error={stop.error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={stop.pending}>Keep playing</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={stop.pending}
            onClick={() =>
              void stop.run(async () => {
                await window.launcher.stopGame(sessionId);
                setOpen(false);
              })
            }
          >
            {stop.pending ? 'Stopping…' : 'Force stop'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
