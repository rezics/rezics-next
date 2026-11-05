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
import { m } from '../paraglide/messages.js';

/** Confirm the occurrence count at Save, after the owner has reviewed the complete draft. */
export function CollectionBatchRemoveConfirmation({
  open,
  count,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  count: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm" data-collection-removal-confirmation>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.library_collection_remove_selected()}</AlertDialogTitle>
          <AlertDialogDescription>
            {m.library_collection_selection_count({ count })} — {m.library_collection_undo_note()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.library_collection_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={count < 1 || count > 100} onClick={onConfirm}>
            {m.library_collection_save()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
