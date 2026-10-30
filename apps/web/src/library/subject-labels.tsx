import { m } from '../paraglide/messages.js';

export type SubjectLabelNoticeCode =
  | 'label-capacity'
  | 'label-restore-stale'
  | 'label-restore-expired'
  | 'label-restore-occupied'
  | 'label-restore-capacity'
  | 'closed'
  | 'unavailable'
  | 'label-removed';

const noticeMessages: Record<SubjectLabelNoticeCode, () => string> = {
  'label-capacity': m.library_subject_label_capacity,
  'label-restore-stale': m.library_subject_label_restore_stale,
  'label-restore-expired': m.library_subject_label_restore_expired,
  'label-restore-occupied': m.library_subject_label_restore_occupied,
  'label-restore-capacity': m.library_subject_label_restore_capacity,
  closed: m.library_subject_label_closed,
  unavailable: m.library_subject_label_unavailable,
  'label-removed': m.library_subject_label_removed_status,
};

/** Keep capacity, each restore refusal, and stale-slot feedback visible as distinct page outcomes. */
export function SubjectLabelNotice({ result }: { result?: string }) {
  if (!result || !Object.hasOwn(noticeMessages, result)) return null;
  const code = result as SubjectLabelNoticeCode;
  return (
    <p role={code === 'label-removed' ? 'status' : 'alert'} className="text-sm text-muted-foreground">
      {noticeMessages[code]()}
    </p>
  );
}
