import type { ReactNode, Ref } from 'react';
import { useState } from 'react';
import { EllipsisIcon, FlagIcon, LinkIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { Button } from './button.tsx';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
} from './alert-dialog.tsx';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './menu.tsx';
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

/** The owner sees editing and deletion actions; everyone else can report the content. */
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
      <Menu>
        <MenuTrigger asChild>
          <Button aria-label={labels.moreActions} ref={props.triggerRef} size="icon-sm" variant="ghost">
            <EllipsisIcon aria-hidden="true" />
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onClick={props.onCopyLink} value="copy-link">
            <LinkIcon aria-hidden="true" />
            {labels.copyLink}
          </MenuItem>
          {props.ownsContent ? (
            <>
              <MenuItem onClick={props.onEdit} value="edit">
                <PencilIcon aria-hidden="true" />
                {labels.edit}
              </MenuItem>
              {props.onDelete ? (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={() => setDeleteOpen(true)} value="delete">
                    <Trash2Icon aria-hidden="true" />
                    {labels.delete}
                  </MenuItem>
                </>
              ) : null}
            </>
          ) : (
            <MenuItem onClick={() => setReportOpen(true)} value="report">
              <FlagIcon aria-hidden="true" />
              {labels.report}
            </MenuItem>
          )}
        </MenuContent>
      </Menu>

      {props.ownsContent ? (
        props.onDelete ? (
          <AlertDialog
            onOpenChange={({ open }) => {
              setDeleteOpen(open);
              if (!open) setDeleteFailure('');
            }}
            open={deleteOpen}
            pending={deletePending}
          >
            <AlertDialogContent size="sm">
              <AlertDialogHeader description={labels.deleteDescription} title={labels.deleteTitle} />
              {deleteFailure ? (
                <p className="px-6 text-sm" role="alert">
                  {deleteFailure}
                </p>
              ) : null}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deletePending}>{labels.cancel}</AlertDialogCancel>
                <AlertDialogAction
                  disabled={deletePending}
                  isLoading={deletePending}
                  onClick={confirmDelete}
                  variant="destructive"
                >
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
