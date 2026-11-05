import type { ReactNode, Ref } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { Menu, type MenuEntry } from './menu.tsx';
import { ReportDialog, type ReportDialogLabels, type ReportSubmission } from './report-dialog.tsx';

const useClientLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

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
  extraEntries?: MenuEntry[];
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
  /** Supply `reportOpen` and this callback when the host owns the dialog's open state. */
  reportOpen?: boolean;
  onReportOpenChange?: (open: boolean) => void;
}

export type ContentActionsProps = OwnerContentActionsProps | OtherContentActionsProps;

/**
 * The overflow menu of a piece of content. It composes the shared `Menu`, `alert-dialog` for confirming deletion,
 * and the report dialog. The owner sees editing and deletion actions;
 * everyone else can report the content, so reporting never needs a visible button.
 */
export function ContentActions(props: ContentActionsProps) {
  const [internalReportOpen, setInternalReportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState('');
  const labels = { ...contentActionsLabels, ...props.labels };
  const reportOpen = props.ownsContent === false ? (props.reportOpen ?? internalReportOpen) : false;
  const deleteAvailable = props.ownsContent === true && Boolean(props.onDelete);
  const deleteIncarnation = useRef(0);
  const deleteMounted = useRef(false);
  const deleteOpenRef = useRef(deleteOpen);
  const deleteAvailableRef = useRef(deleteAvailable);
  const deletePendingRef = useRef(false);
  const deleteOperationRef = useRef<object | null>(null);
  const deleteFailureLabelRef = useRef(labels.deleteFailure);

  useClientLayoutEffect(() => {
    deleteFailureLabelRef.current = labels.deleteFailure;
  });

  useClientLayoutEffect(() => {
    deleteMounted.current = true;
    deleteOpenRef.current = deleteOpen;
    deleteAvailableRef.current = deleteAvailable;
    deleteIncarnation.current += 1;
    deleteOperationRef.current = null;
    deletePendingRef.current = false;

    if (!deleteAvailable) {
      setDeleteOpen(false);
      setDeletePending(false);
      setDeleteFailure('');
    }

    return () => {
      deleteMounted.current = false;
      deleteOpenRef.current = false;
      deleteIncarnation.current += 1;
      deleteOperationRef.current = null;
      deletePendingRef.current = false;
    };
  }, [deleteAvailable, deleteOpen]);

  const changeReportOpen = (open: boolean) => {
    if (props.ownsContent !== false) return;
    if (props.reportOpen === undefined) setInternalReportOpen(open);
    props.onReportOpenChange?.(open);
  };

  const confirmDelete = async () => {
    if (
      props.ownsContent !== true ||
      !props.onDelete ||
      !deleteMounted.current ||
      !deleteAvailableRef.current ||
      !deleteOpenRef.current ||
      deletePendingRef.current
    )
      return;

    const onDelete = props.onDelete;
    const operation = {};
    const operationIncarnation = deleteIncarnation.current;
    deleteOperationRef.current = operation;
    deletePendingRef.current = true;
    setDeletePending(true);
    setDeleteFailure('');
    const isCurrent = () =>
      deleteMounted.current &&
      deleteAvailableRef.current &&
      deleteOpenRef.current &&
      deleteIncarnation.current === operationIncarnation &&
      deleteOperationRef.current === operation;

    try {
      await onDelete();
      if (!isCurrent()) return;
      setDeleteOpen(false);
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      setDeleteFailure(message || deleteFailureLabelRef.current);
    } finally {
      if (isCurrent()) {
        deleteOperationRef.current = null;
        deletePendingRef.current = false;
        setDeletePending(false);
      }
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
          ...(props.extraEntries?.length ? [...props.extraEntries, { type: 'separator' as const }] : []),
          ...(props.ownsContent
            ? [{ type: 'item' as const, label: labels.edit, onSelect: props.onEdit }]
            : [{ type: 'item' as const, label: labels.report, onSelect: () => changeReportOpen(true) }]),
          ...(props.ownsContent && props.onDelete
            ? [
                { type: 'separator' as const },
                {
                  type: 'destructive' as const,
                  label: labels.delete,
                  onSelect: () => {
                    setDeleteFailure('');
                    setDeleteOpen(true);
                  },
                },
              ]
            : []),
        ]}
      />

      {props.ownsContent ? (
        props.onDelete ? (
          <AlertDialog
            onOpenChange={(open, details) => {
              // A deletion in flight finishes before the dialog may close.
              if (!open && deletePendingRef.current) {
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
          onOpenChange={changeReportOpen}
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
