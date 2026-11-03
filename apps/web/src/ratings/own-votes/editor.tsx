import { useState } from 'react';
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
import type { OwnVoteEntry } from '../../../../../services/kernel/src/rating/own-votes-page.ts';
import { m } from '../../paraglide/messages.js';
import { ownVoteChangedAt, ownVoteScale, ownVoteValue } from './presentation';
import { isAdmittedVoteAction } from './intent';

export type OwnVoteFeedback =
  | { kind: 'saving' | 'clearing' | 'reviewing' }
  | { kind: 'saved' | 'cleared' | 'rejected' | 'uncertain' | 'readback-unavailable' | 'review-missing' | 'review-failed' }
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
  const editable = isAdmittedVoteAction(entry, entry.actions, 'PUT') && isAdmittedVoteAction(entry, entry.actions, 'GET');
  const canClear = isAdmittedVoteAction(entry, entry.actions, 'DELETE') && isAdmittedVoteAction(entry, entry.actions, 'GET');
  const changedAt = ownVoteChangedAt(entry, locale);
  const parsedDraft = draft === '' ? Number.NaN : Number(draft);
  const validDraft =
    Number.isSafeInteger(parsedDraft) &&
    parsedDraft >= entry.question.scale.min &&
    parsedDraft <= entry.question.scale.max &&
    (parsedDraft - entry.question.scale.min) % entry.question.scale.displayStep === 0;

  return (
    <section className="space-y-4 rounded-xl border p-4" aria-labelledby="my-ratings-inspection">
      <div className="space-y-2">
        <h2 id="my-ratings-inspection" className="text-lg font-semibold">
          {m.library_my_ratings_inspect()}
        </h2>
        <p className="break-words font-medium">{entry.subject.label?.value ?? m.subject_value_unlabelled()}</p>
        <p className="text-sm text-muted-foreground">{entry.question.label}</p>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium">{m.library_my_ratings_original_key()}</dt>
            <dd className="break-all">{entry.targetId} · {entry.questionId}</dd>
          </div>
          <div>
            <dt className="font-medium">{m.library_my_ratings_value()}</dt>
            <dd>{ownVoteValue(entry, locale)}</dd>
          </div>
          <div>
            <dt className="font-medium">{m.library_my_ratings_scale()}</dt>
            <dd>{ownVoteScale(entry, locale)}</dd>
          </div>
          {changedAt ? (
            <div>
              <dt className="font-medium">{m.library_my_ratings_changed()}</dt>
              <dd><time dateTime={entry.own.at}>{changedAt}</time></dd>
            </div>
          ) : null}
        </dl>
      </div>

      {entry.actions.state === 'retired' ? <p role="status">{m.library_my_ratings_retired()}</p> : null}
      {entry.actions.state === 'unavailable' && entry.actions.reason === 'merged_source' ? (
        <p role="status">{m.library_my_ratings_merged()}</p>
      ) : null}
      {entry.actions.state === 'unavailable' && entry.actions.reason === 'identity_pending' ? (
        <p role="status">{m.library_my_ratings_identity_pending()}</p>
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
              aria-describedby="my-ratings-scale-help"
              onChange={(event) => onDraft(event.currentTarget.value)}
            />
          </label>
          <p id="my-ratings-scale-help" className="text-sm text-muted-foreground">
            {ownVoteScale(entry, locale)}
          </p>
          {!validDraft ? <p role="alert">{m.library_my_ratings_choose_value()}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-11" disabled={locked || busy || !validDraft} onClick={onSave}>
              {m.library_my_ratings_save()}
            </Button>
            <Button className="min-h-11" variant="outline" disabled={locked || busy} onClick={onCancel}>
              {m.library_my_ratings_cancel()}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {editable ? (
            <Button className="min-h-11" disabled={locked || busy} onClick={onEdit}>
              {m.library_my_ratings_edit()}
            </Button>
          ) : null}
          {canClear ? (
            <Button className="min-h-11" variant="outline" disabled={locked || busy} onClick={() => setConfirmingClear(true)}>
              {m.library_my_ratings_clear()}
            </Button>
          ) : null}
        </div>
      )}

      {feedback ? <Feedback feedback={feedback} locale={locale} /> : null}
      {feedback?.kind === 'uncertain' || feedback?.kind === 'readback-unavailable' || feedback?.kind === 'review-failed' || feedback?.kind === 'review-missing' ? (
        <div className="flex flex-wrap gap-2">
          {canRetry ? (
            <Button className="min-h-11" disabled={busy} onClick={onRetry}>{m.library_my_ratings_retry_original()}</Button>
          ) : null}
          <Button className="min-h-11" variant="outline" disabled={busy} onClick={onReview}>
            {m.library_my_ratings_review_original()}
          </Button>
        </div>
      ) : feedback?.kind === 'review-pending' ? (
        <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" disabled={busy} onClick={onRetry}>{m.library_my_ratings_retry_original()}</Button>
          <Button className="min-h-11" variant="outline" disabled={busy} onClick={onReview}>
            {m.library_my_ratings_review_original()}
          </Button>
        </div>
      ) : null}

      <AlertDialog open={confirmingClear} onOpenChange={setConfirmingClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.library_my_ratings_confirm_clear_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.library_my_ratings_confirm_clear_text()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">{m.library_my_ratings_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11"
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
      case 'saving': return m.library_my_ratings_saving();
      case 'clearing': return m.library_my_ratings_clearing();
      case 'reviewing': return m.library_my_ratings_reviewing();
      case 'saved': return m.library_my_ratings_saved();
      case 'cleared':
      case 'review-cleared': return m.library_my_ratings_cleared();
      case 'rejected': return m.library_my_ratings_rejected();
      case 'uncertain': return m.library_my_ratings_uncertain_text();
      case 'readback-unavailable': return m.library_my_ratings_readback_unavailable();
      case 'review-missing': return m.library_my_ratings_review_missing();
      case 'review-failed': return m.library_my_ratings_review_failed();
      case 'review-current': return m.library_my_ratings_review_current({ value: value ?? '' });
      case 'review-pending': return m.library_my_ratings_review_current({ value: value ?? '' });
    }
  })();
  const alert = feedback.kind === 'rejected' || feedback.kind === 'uncertain' || feedback.kind === 'readback-unavailable' || feedback.kind === 'review-failed';
  return <p role={alert ? 'alert' : 'status'}>{message}</p>;
}
