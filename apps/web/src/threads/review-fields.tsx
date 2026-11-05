import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { useEffect, useId, useRef, useState } from 'react';
import { coverSrc } from '../media/cover-src';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { selectedReviewSubject } from './review-policy';
import {
  CURRENT_REVIEW_VOTE_UNAVAILABLE,
  isCurrentReviewVoteUnavailable,
  selectedVoteCitation,
  type CurrentReviewVote,
  type CurrentReviewVoteReadResult,
} from './review-vote';
import { contentSubjectPreset, searchContentSubjects } from './content-subject-search';
import { useThreadCreationVisit } from './thread-creation-lifetime';
import { readCurrentReviewVote } from './review-vote-read';

export { STANDARD_QUESTION_ID } from './review-vote';
export type { CurrentReviewVote } from './review-vote';

export { readCurrentReviewVote } from './review-vote-read';

async function readReviewVote(subjectId: string): Promise<CurrentReviewVoteReadResult> {
  try {
    return await readCurrentReviewVote({ data: { subjectId } });
  } catch {
    return CURRENT_REVIEW_VOTE_UNAVAILABLE;
  }
}

export function ReviewFields({
  ...props
}: {
  initialSubjectId?: string;
  initialSubjectTitle?: string;
  disabled?: boolean;
  searchScope?: string;
  onSubjectChange: (subjectId: string | null) => void;
  onVoteCitationChange: (citation: CurrentReviewVote | undefined) => void;
}) {
  return <ReviewFieldsVisit key={props.searchScope} {...props} />;
}

function ReviewFieldsVisit({
  initialSubjectId,
  initialSubjectTitle,
  disabled = false,
  searchScope,
  onSubjectChange,
  onVoteCitationChange,
}: {
  initialSubjectId?: string;
  initialSubjectTitle?: string;
  disabled?: boolean;
  searchScope?: string;
  onSubjectChange: (subjectId: string | null) => void;
  onVoteCitationChange: (citation: CurrentReviewVote | undefined) => void;
}) {
  const detailsId = useId();
  const [subject, setSubject] = useState<EntityPickerSubject | null>(() =>
    initialSubjectId ? contentSubjectPreset(initialSubjectId, initialSubjectTitle ?? m.thread_review_subject()) : null,
  );
  const [readVote, setReadVote] = useState<{ subjectId: string; result: CurrentReviewVoteReadResult } | null>(null);
  const [citingVote, setCitingVote] = useState(false);
  const [retryingVote, setRetryingVote] = useState(false);
  const visit = useThreadCreationVisit();
  const readGeneration = useRef(0);
  const retryToken = useRef<object | null>(null);
  const selectedSubject = useRef<string | null>(subject?.id ?? null);
  const visitRef = useRef(visit);
  const disabledRef = useRef(disabled);
  const onVoteCitationChangeRef = useRef(onVoteCitationChange);
  selectedSubject.current = subject?.id ?? null;
  visitRef.current = visit;
  disabledRef.current = disabled;
  onVoteCitationChangeRef.current = onVoteCitationChange;
  const result = readVote && readVote.subjectId === subject?.id ? readVote.result : undefined;
  const vote = result && !isCurrentReviewVoteUnavailable(result) ? result : null;
  const unavailable = result !== undefined && isCurrentReviewVoteUnavailable(result);
  const locale = getLocale();

  const current = () => visitRef.current.isCurrent();
  const editable = () => !disabledRef.current && visitRef.current.isEditable();

  useEffect(() => {
    const generation = ++readGeneration.current;
    let active = true;
    retryToken.current = null;
    setRetryingVote(false);
    setReadVote(null);
    setCitingVote(false);
    if (editable()) onVoteCitationChangeRef.current(undefined);
    if (!subject) return () => void (active = false);
    // Keep the invocation behind a visit and subject check so queued effects cannot start an obsolete read.
    void Promise.resolve().then(async () => {
      if (
        !active ||
        readGeneration.current !== generation ||
        selectedSubject.current !== subject.id ||
        !current() ||
        !editable()
      )
        return;
      const value = await readReviewVote(subject.id);
      if (
        active &&
        readGeneration.current === generation &&
        selectedSubject.current === subject.id &&
        current() &&
        editable()
      )
        setReadVote({ subjectId: subject.id, result: value });
    });
    return () => {
      active = false;
      if (readGeneration.current === generation) readGeneration.current++;
    };
  }, [subject?.id, searchScope, visit.ticket]);

  function chooseSubject(items: EntityPickerSubject[]) {
    if (!editable()) return;
    const next = items[0] ?? null;
    if (next?.id === subject?.id) {
      setSubject(next);
      onSubjectChange(selectedReviewSubject(items));
      return;
    }
    readGeneration.current++;
    retryToken.current = null;
    setRetryingVote(false);
    setReadVote(null);
    setCitingVote(false);
    setSubject(next);
    onSubjectChange(selectedReviewSubject(items));
    onVoteCitationChange(undefined);
  }

  function toggleCitation(checked: boolean) {
    if (!editable() || !current()) return;
    setCitingVote(checked);
    onVoteCitationChange(selectedVoteCitation(vote, checked));
  }

  async function retryCurrentVoteRead() {
    const subjectId = subject?.id;
    if (
      !subjectId ||
      result === undefined ||
      !isCurrentReviewVoteUnavailable(result) ||
      !editable() ||
      !current() ||
      retryToken.current
    )
      return;
    const generation = ++readGeneration.current;
    const token = {};
    retryToken.current = token;
    setRetryingVote(true);
    const value = await readReviewVote(subjectId);
    if (
      retryToken.current === token &&
      readGeneration.current === generation &&
      selectedSubject.current === subjectId &&
      current() &&
      editable()
    )
      setReadVote({ subjectId, result: value });
    if (retryToken.current === token) {
      retryToken.current = null;
      setRetryingVote(false);
    }
  }

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card p-5"
      aria-labelledby={`${detailsId}-heading`}
    >
      <h2 id={`${detailsId}-heading`} className="text-base font-medium [overflow-wrap:anywhere]">
        {m.thread_review_details_heading()}
      </h2>
      <EntityPicker
        label={m.thread_review_subject()}
        search={searchContentSubjects}
        src={coverSrc}
        value={subject ? [subject] : []}
        disabled={disabled}
        onValueChange={chooseSubject}
      />
      {subject ? (
        <p data-slot="review-selected-subject" className="min-w-0 text-sm [overflow-wrap:anywhere]">
          {m.thread_review_details_selected_subject({ title: subject.title })}
        </p>
      ) : null}
      {result === null ? <p role="status">{m.thread_review_vote_none()}</p> : null}
      {unavailable ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert">{m.thread_review_vote_read_failed()}</p>
          <button
            type="button"
            className="w-fit cursor-pointer text-sm font-medium underline underline-offset-4 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={disabled || retryingVote || !current() || !editable()}
            onClick={() => void retryCurrentVoteRead()}
          >
            {m.thread_review_vote_retry()}
          </button>
        </div>
      ) : null}
      {vote ? (
        <Field
          data-disabled={disabled}
          className="min-w-0 gap-0 rounded-lg border border-border/70 bg-background text-sm"
        >
          <FieldLabel
            id={`${detailsId}-citation-label`}
            htmlFor={`${detailsId}-cite-vote`}
            className="min-h-11 min-w-0 w-full cursor-pointer items-start gap-3 rounded-lg p-3 text-start has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring group-data-[disabled=true]/field:cursor-not-allowed"
          >
            <Checkbox
              id={`${detailsId}-cite-vote`}
              aria-describedby={`${detailsId}-citation-help`}
              className="mt-0.5"
              checked={citingVote}
              disabled={disabled}
              onCheckedChange={(checked) => toggleCitation(checked === true)}
            />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {m.thread_review_cite_vote({
                score: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(vote.units / 2),
              })}
            </span>
          </FieldLabel>
          <FieldDescription
            id={`${detailsId}-citation-help`}
            className="min-w-0 px-3 pb-3 text-start [overflow-wrap:anywhere]"
          >
            {m.thread_review_details_citation_help()}
          </FieldDescription>
        </Field>
      ) : null}
    </section>
  );
}
