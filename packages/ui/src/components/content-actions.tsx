import type { ReactNode, Ref } from 'react';
import { useState } from 'react';
import { EllipsisIcon, LoaderCircleIcon } from 'lucide-react';
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
import { Menu } from './menu.tsx';
import { ReportDialog, type ReportDialogLabels, type ReportSubmission } from './report-dialog.tsx';

export const contentActionsLabels = {
  moreActions: 'More actions',
  copyLink: 'Copy link',
  edit: 'Edit',
  delete: 'Delete',
  report: 'Report',
  deleteTitle: 'Delete this content?',
  deleteDescription: 'This action cannot be undone.',
  confirmDelete: 'Delete content',
  cancel: 'Cancel',
  deleteFailure: 'This content could not be deleted.',
} as const;

export type ContentActionsLabels = { readonly [K in keyof typeof contentActionsLabels]: string };

interface ContentActionsCommonProps {
  onCopyLink: () => void | Promise<void>;
  labels?: Partial<ContentActionsLabels>;
  triggerRef?: Ref<HTMLButtonElement>;
}

export interface OwnerContentActionsProps extends ContentActionsCommonProps {
  ownsContent: true;
  onEdit: () => void;
  onDelete?: () => void | Promise<void>;
  onReport?: never;
}

export interface OtherContentActionsProps extends ContentActionsCommonProps {
  ownsContent: false;
  onEdit?: never;
  onDelete?: never;
  onReport: (report: ReportSubmission) => Promise<void>;
  verified: boolean;
  verification?: ReactNode;
  maxDetails?: number;
  reportLabels?: Partial<ReportDialogLabels>;
}

export type ContentActionsProps = OwnerContentActionsProps | OtherContentActionsProps;

/**
 * The overflow menu of a piece of content. It composes the shared `Menu`, `alert-dialog` for confirming deletion,
 * and the report dialog. The owner sees editing and deletion actions;
 * everyone else can report the content, so reporting never needs a visible button.
 */
export function ContentActions(props: ContentActionsProps) {
  const [reportOpen, setReportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState('');
  const labels = { ...contentActionsLabels, ...props.labels };

  const confirmDelete = async () => {
    if (props.ownsContent !== true || !props.onDelete || deletePending) return;

    setDeletePending(true);
    setDeleteFailure('');
    try {
      await props.onDelete();
      setDeleteOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      setDeleteFailure(message || labels.deleteFailure);
    } finally {
      setDeletePending(false);
    }
  };

  return (
    <>
      <Menu
        title={labels.moreActions}
        backLabel={labels.cancel}
        trigger={
          <Button aria-label={labels.moreActions} ref={props.triggerRef} size="icon-sm" variant="ghost">
            <EllipsisIcon aria-hidden="true" />
          </Button>
        }
        entries={[
          { type: 'item', label: `${labels.copyLink}`, onSelect: props.onCopyLink },
          ...(props.ownsContent
            ? [{ type: 'item' as const, label: labels.edit, onSelect: props.onEdit }]
            : [{ type: 'item' as const, label: labels.report, onSelect: () => setReportOpen(true) }]),
          ...(props.ownsContent && props.onDelete
            ? [
                { type: 'separator' as const },
                { type: 'destructive' as const, label: labels.delete, onSelect: () => setDeleteOpen(true) },
              ]
            : []),
        ]}
      />

      {props.ownsContent ? (
        props.onDelete ? (
          <AlertDialog
            onOpenChange={(open, details) => {
              // A deletion in flight finishes before the dialog may close.
              if (!open && deletePending) {
                details.cancel();
                return;
              }
              setDeleteOpen(open);
              if (!open) setDeleteFailure('');
            }}
            open={deleteOpen}
          >
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>{labels.deleteTitle}</AlertDialogTitle>
                <AlertDialogDescription>{labels.deleteDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              {deleteFailure ? (
                <p className="text-destructive text-sm" role="alert">
                  {deleteFailure}
                </p>
              ) : null}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deletePending}>{labels.cancel}</AlertDialogCancel>
                <AlertDialogAction
                  aria-busy={deletePending}
                  disabled={deletePending}
                  onClick={confirmDelete}
                  variant="destructive"
                >
                  {deletePending ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : null}
                  {labels.confirmDelete}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null
      ) : (
        <ReportDialog
          {...(props.maxDetails === undefined ? {} : { maxDetails: props.maxDetails })}
          onOpenChange={setReportOpen}
          onSubmit={props.onReport}
          open={reportOpen}
          verified={props.verified}
          {...(props.verification === undefined ? {} : { verification: props.verification })}
          {...(props.reportLabels === undefined ? {} : { labels: props.reportLabels })}
        />
      )}
    </>
  );
}
