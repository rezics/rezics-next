import { useId, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
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
import type { OwnVoteEntry } from './types';
import { m } from '../../paraglide/messages.js';
import { ownVoteScale } from './presentation';
import { isAdmittedVoteAction } from './intent';

export type OwnVoteFeedback =
  | { kind: 'saving' | 'clearing' | 'reviewing' }
  | {
      kind:
        | 'saved'
        | 'cleared'
        | 'rejected'
        | 'uncertain'
        | 'readback-unavailable'
        | 'review-missing'
        | 'review-failed';
    }
  | { kind: 'review-current'; value: number }
  | { kind: 'review-pending'; value: number }
  | { kind: 'review-cleared' };

export function OwnVoteEditor({
  entry,
  locale,
  editing,
  draft,
  locked,
  busy,
  canRetry,
  feedback,
  onEdit,
  onDraft,
  onSave,
  onCancel,
  onClear,
  onRetry,
  onReview,
}: {
  entry: OwnVoteEntry;
  locale: string;
  editing: boolean;
  draft: string;
  locked: boolean;
  busy: boolean;
  canRetry: boolean;
  feedback: OwnVoteFeedback | null;
  onEdit: () => void;
  onDraft: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onClear: () => void;
  onRetry: () => void;
  onReview: () => void;
}) {
  const [confirmingClear, setConfirmingClear] = useState(false);
  const editable =
    isAdmittedVoteAction(entry, entry.actions, 'PUT') && isAdmittedVoteAction(entry, entry.actions, 'GET');
  const canClear =
    isAdmittedVoteAction(entry, entry.actions, 'DELETE') && isAdmittedVoteAction(entry, entry.actions, 'GET');
  const id = useId();
  const helpId = `${id}-scale`;
  const parsedDraft = draft === '' ? Number.NaN : Number(draft);
  const validDraft =
    Number.isSafeInteger(parsedDraft) &&
    parsedDraft >= entry.question.scale.min &&
    parsedDraft <= entry.question.scale.max &&
    (parsedDraft - entry.question.scale.min) % entry.question.scale.displayStep === 0;

  return (
    <section
      className="min-w-0 space-y-4 border-s-2 border-primary/40 bg-muted/30 p-4 sm:p-5"
      aria-label={m.library_my_ratings_value()}
      data-slot="own-vote-editor"
      aria-busy={busy}
    >
      <p id={helpId} className="text-sm text-muted-foreground">
        {ownVoteScale(entry, locale)}
      </p>

      {entry.actions.state === 'retired' ? <p role="status">{m.library_my_ratings_retired()}</p> : null}
      {entry.actions.state === 'unavailable' && entry.actions.reason === 'merged_source' ? (
        <p role="status">{m.library_my_ratings_merged()}</p>
      ) : null}
      {entry.actions.state === 'unavailable' && entry.actions.reason === 'identity_pending' ? (
        <p role="status">{m.library_my_ratings_identity_pending()}</p>
      ) : null}
      {entry.actions.state === 'unavailable' && entry.actions.reason === 'read_only' ? (
        <p role="status">{m.library_my_ratings_read_only()}</p>
      ) : null}

      {editing && editable ? (
        <div className="space-y-3">
          <label className="grid gap-1 text-sm font-medium">
            {m.library_my_ratings_value()}
            <input
              className="min-h-11 w-full max-w-sm rounded-md border bg-background px-3 text-base"
              type="number"
              inputMode="numeric"
              min={entry.question.scale.min}
              max={entry.question.scale.max}
              step={entry.question.scale.displayStep}
              value={draft}
              disabled={locked || busy}
              aria-describedby={helpId}
              onChange={(event) => onDraft(event.currentTarget.value)}
            />
          </label>
          {!validDraft ? <p role="alert">{m.library_my_ratings_choose_value()}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              className="h-auto min-h-11 max-w-full whitespace-normal wrap-anywhere py-2"
              disabled={locked || busy || !validDraft}
              onClick={onSave}
            >
              {m.library_my_ratings_save()}
            </Button>
            <Button
              className="h-auto min-h-11 max-w-full whitespace-normal wrap-anywhere py-2"
              variant="outline"
              disabled={locked || busy}
              onClick={onCancel}
            >
              {m.library_my_ratings_cancel()}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {editable ? (
            <Button
              className="h-auto min-h-11 max-w-full whitespace-normal wrap-anywhere py-2"
              disabled={locked || busy}
              onClick={onEdit}
            >
              {m.library_my_ratings_edit()}
            </Button>
          ) : null}
          {canClear ? (
            <Button
              className="h-auto min-h-11 max-w-full whitespace-normal wrap-anywhere py-2"
              variant="outline"
              disabled={locked || busy}
              onClick={() => setConfirmingClear(true)}
            >
              {m.library_my_ratings_clear()}
            </Button>
          ) : null}
        </div>
      )}

      {feedback ? <Feedback feedback={feedback} locale={locale} /> : null}
      {feedback &&
      ['uncertain', 'readback-unavailable', 'review-failed', 'review-missing', 'review-pending'].includes(
        feedback.kind,
      ) ? (
        <div className="flex flex-wrap gap-2">
          {canRetry ? (
            <Button
              className="h-auto min-h-11 max-w-full whitespace-normal wrap-anywhere py-2"
              disabled={busy}
              onClick={onRetry}
            >
              {m.library_my_ratings_retry_original()}
            </Button>
          ) : null}
          {isAdmittedVoteAction(entry, entry.actions, 'GET') ? (
            <Button
              className="h-auto min-h-11 max-w-full whitespace-normal wrap-anywhere py-2"
              variant="outline"
              disabled={busy}
              onClick={onReview}
            >
              {m.library_my_ratings_review_original()}
            </Button>
          ) : null}
        </div>
      ) : null}
      <details className="text-xs text-muted-foreground">
        <summary className="min-h-11 cursor-pointer content-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {m.library_my_ratings_original_key()}
        </summary>
        <p className="mt-1 break-all" data-slot="own-vote-original-pair">
          {entry.targetId} · {entry.questionId}
        </p>
      </details>

      <AlertDialog open={confirmingClear && canClear} onOpenChange={setConfirmingClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.library_my_ratings_confirm_clear_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.library_my_ratings_confirm_clear_text()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-auto min-h-11 max-w-full whitespace-normal wrap-anywhere py-2">
              {m.library_my_ratings_cancel()}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-auto min-h-11 max-w-full whitespace-normal wrap-anywhere py-2"
              onClick={(event) => {
                event.preventDefault();
                setConfirmingClear(false);
                onClear();
              }}
            >
              {m.library_my_ratings_confirm_clear()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function Feedback({ feedback, locale }: { feedback: OwnVoteFeedback; locale: string }) {
  const value = 'value' in feedback ? new Intl.NumberFormat(locale).format(feedback.value) : undefined;
  const message = (() => {
    switch (feedback.kind) {
      case 'saving':
        return m.library_my_ratings_saving();
      case 'clearing':
        return m.library_my_ratings_clearing();
      case 'reviewing':
        return m.library_my_ratings_reviewing();
      case 'saved':
        return m.library_my_ratings_saved();
      case 'cleared':
      case 'review-cleared':
        return m.library_my_ratings_cleared();
      case 'rejected':
        return m.library_my_ratings_rejected();
      case 'uncertain':
        return m.library_my_ratings_uncertain_text();
      case 'readback-unavailable':
        return m.library_my_ratings_readback_unavailable();
      case 'review-missing':
        return m.library_my_ratings_review_missing();
      case 'review-failed':
        return m.library_my_ratings_review_failed();
      case 'review-current':
        return m.library_my_ratings_review_current({ value: value ?? '' });
      case 'review-pending':
        return `${m.library_my_ratings_review_current({ value: value ?? '' })} ${m.library_my_ratings_uncertain_text()}`;
    }
  })();
  const alert =
    feedback.kind === 'rejected' ||
    feedback.kind === 'uncertain' ||
    feedback.kind === 'readback-unavailable' ||
    feedback.kind === 'review-failed';
  return <p role={alert ? 'alert' : 'status'}>{message}</p>;
}
