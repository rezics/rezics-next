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

export function ConfirmAction({
  label,
  title,
  description,
  disabled,
  destructive,
  confirm,
}: {
  label: string;
  title: string;
  description: string;
  disabled?: boolean;
  destructive?: boolean;
  confirm: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const action = useAction();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!action.pending) setOpen(next);
      }}
    >
      <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={disabled} />}>
        {label}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <Failure error={action.error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={action.pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={action.pending}
            onClick={() =>
              void action.run(async () => {
                await confirm();
                setOpen(false);
              })
            }
          >
            {action.pending ? 'Working…' : label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
