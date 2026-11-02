import { useEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { readSubjectLabelPage } from './labels-actions';
import type { LibraryLabelSummary } from './subject-labels.ts';
import { m } from '../paraglide/messages.js';

export type SubjectLabelNoticeCode =
  | 'label-conflict'
  | 'label-capacity'
  | 'label-restore-stale'
  | 'label-restore-expired'
  | 'label-restore-occupied'
  | 'label-restore-capacity'
  | 'closed'
  | 'unavailable'
  | 'label-removed';

const noticeMessages: Record<SubjectLabelNoticeCode, () => string> = {
  'label-conflict': m.library_subject_label_steps_conflict,
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

/** Continues the existing picker with one signed page, without accumulating the owner's catalogue. */
export function SubjectLabelMore({
  query,
  next,
  onPage,
  isCurrent,
  acceptPage,
}: {
  query: string;
  next: string | null;
  onPage: (page: {
    labels: LibraryLabelSummary[];
    next?: string | null;
    state: 'loaded' | 'closed' | 'signed-out' | 'unavailable';
  }) => void;
  /** Optional owning Subject workflow fences; existing shelf callers retain their page behavior. */
  isCurrent?: () => boolean;
  acceptPage?: (
    page: Awaited<ReturnType<typeof readSubjectLabelPage>>,
    request: { query: string; cursor?: string },
  ) => boolean;
}) {
  const requestId = useRef(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    requestId.current++;
    setBusy(false);
    setFailure(undefined);
    return () => {
      requestId.current++;
    };
  }, [query, next]);
  if (!next) return null;
  return (
    <div className="space-y-2">
      {failure ? <p role="alert">{labelReadMessage(failure) ?? m.library_subject_label_unavailable()}</p> : null}
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          if (busy || (isCurrent && !isCurrent())) return;
          const id = ++requestId.current;
          const request = { query, ...(failure === 'stale_cursor' ? {} : { cursor: next }) };
          setBusy(true);
          try {
            const page = await readSubjectLabelPage({
              data: request,
            });
            if (id !== requestId.current || (isCurrent && !isCurrent())) return;
            if (acceptPage && !acceptPage(page, request)) {
              setFailure('unavailable');
              return;
            }
            if (page.state === 'loaded') onPage(page);
            else setFailure(page.reason ?? page.state);
          } catch {
            if (id === requestId.current && (!isCurrent || isCurrent())) setFailure('unavailable');
          } finally {
            if (id === requestId.current && (!isCurrent || isCurrent())) setBusy(false);
          }
        }}
      >
        {failure === 'stale_cursor' ? m.library_labels_filter() : m.library_label_more()}
      </Button>
    </div>
  );
}

export function labelReadMessage(reason?: string): string | undefined {
  if (reason === 'index_not_ready' || reason === 'semantic_not_ready') return m.library_labels_preparing();
  if (
    reason === 'forbidden' ||
    reason === 'unauthorized' ||
    reason === 'authentication_required' ||
    reason === 'invalid_credentials' ||
    reason === 'not_found'
  )
    return m.library_labels_denied();
  return undefined;
}

export function SubjectLabelReadNotice({ reason }: { reason?: string }) {
  const text = labelReadMessage(reason);
  return text ? (
    <p role="status" className="text-sm text-muted-foreground">
      {text}
    </p>
  ) : null;
}
