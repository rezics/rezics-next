import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { useEffect, useRef, useState } from 'react';
import { coverSrc } from '../media/cover-src';
import { Label } from '@rezics/ui/shadcn/label';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { selectedReviewSubject } from './review-policy';
import { selectedVoteCitation, type CurrentReviewVote } from './review-vote';
import { contentSubjectPreset, searchContentSubjects } from './content-subject-search';
import { useThreadCreationVisit } from './thread-creation-lifetime';
import { readCurrentReviewVote } from './review-vote-read';

export { STANDARD_QUESTION_ID } from './review-vote';
export type { CurrentReviewVote } from './review-vote';

export { readCurrentReviewVote } from './review-vote-read';

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
  const [subject, setSubject] = useState<EntityPickerSubject | null>(() =>
    initialSubjectId ? contentSubjectPreset(initialSubjectId, initialSubjectTitle ?? m.thread_review_subject()) : null,
  );
  const [readVote, setReadVote] = useState<{ subjectId: string; vote: CurrentReviewVote } | null>(null);
  const [citingVote, setCitingVote] = useState(false);
  const visit = useThreadCreationVisit();
  const readGeneration = useRef(0);
  const selectedSubject = useRef<string | null>(subject?.id ?? null);
  selectedSubject.current = subject?.id ?? null;
  const vote = readVote && readVote.subjectId === subject?.id ? readVote.vote : null;
  const locale = getLocale();

  const current = () => visit.isCurrent();
  const editable = () => !disabled && visit.isEditable();

  useEffect(() => {
    const generation = ++readGeneration.current;
    let active = true;
    setReadVote(null);
    setCitingVote(false);
    if (editable()) onVoteCitationChange(undefined);
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
      try {
        const value = await readCurrentReviewVote({ data: { subjectId: subject.id } });
        if (
          active &&
          readGeneration.current === generation &&
          selectedSubject.current === subject.id &&
          current() &&
          editable() &&
          value
        )
          setReadVote({ subjectId: subject.id, vote: value });
      } catch {
        // An unavailable private read cannot produce a citation.
      }
    });
    return () => {
      active = false;
      if (readGeneration.current === generation) readGeneration.current++;
    };
  }, [onVoteCitationChange, subject?.id, searchScope, visit.ticket]);

  function chooseSubject(items: EntityPickerSubject[]) {
    if (!editable()) return;
    const next = items[0] ?? null;
    if (next?.id === subject?.id) {
      setSubject(next);
      onSubjectChange(selectedReviewSubject(items));
      return;
    }
    readGeneration.current++;
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

  return (
    <section
      className="space-y-3 rounded-xl border border-border/70 bg-card p-5"
      aria-label={m.thread_review_subject()}
    >
      <Label>{m.thread_review_subject()}</Label>
      <EntityPicker
        label={m.thread_review_subject()}
        search={searchContentSubjects}
        src={coverSrc}
        value={subject ? [subject] : []}
        disabled={disabled}
        onValueChange={chooseSubject}
      />
      {vote ? (
        <Field
          orientation="horizontal"
          className="min-h-10 items-start gap-3 rounded-lg border border-border/70 bg-background p-3 text-sm"
        >
          <FieldLabel htmlFor="review-cite-vote" className="items-start">
            <Checkbox
              id="review-cite-vote"
              checked={citingVote}
              disabled={disabled}
              onCheckedChange={(checked) => toggleCitation(checked === true)}
            />
            <span>
              {m.thread_review_cite_vote({
                score: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(vote.units / 2),
              })}
            </span>
          </FieldLabel>
        </Field>
      ) : null}
    </section>
  );
}
