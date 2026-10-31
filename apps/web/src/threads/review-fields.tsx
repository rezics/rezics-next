import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { useEffect, useState } from 'react';
import { coverSrc } from '../media/cover-src';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { env } from 'cloudflare:workers';
import { Label } from '@rezics/ui/shadcn/label';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { selectedReviewSubject } from './review-policy';
import { loadCurrentReviewVote, selectedVoteCitation, type CurrentReviewVote } from './review-vote';
import { contentSubjectPreset, searchContentSubjects } from './content-subject-search';

export { STANDARD_QUESTION_ID } from './review-vote';
export type { CurrentReviewVote } from './review-vote';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const readCurrentReviewVote = createServerFn({ method: 'GET' })
  .validator((input: unknown): { subjectId: string } => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('subjectId' in input) ||
      typeof input.subjectId !== 'string' ||
      !uuid.test(input.subjectId)
    )
      throw new Error('Invalid review subject');
    return { subjectId: input.subjectId };
  })
  .handler(async ({ data }): Promise<CurrentReviewVote | null> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) return null;
    return loadCurrentReviewVote(kernelClient(), data.subjectId, authorization);
  });

export function ReviewFields({
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
  const vote = readVote && readVote.subjectId === subject?.id ? readVote.vote : null;
  const locale = getLocale();

  useEffect(() => {
    let active = true;
    setReadVote(null);
    setCitingVote(false);
    onVoteCitationChange(undefined);
    if (!subject) return () => void (active = false);
    void readCurrentReviewVote({ data: { subjectId: subject.id } }).then(
      (value) => {
        if (active && value) setReadVote({ subjectId: subject.id, vote: value });
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [onVoteCitationChange, subject?.id]);

  function chooseSubject(items: EntityPickerSubject[]) {
    if (disabled) return;
    const next = items[0] ?? null;
    setSubject(next);
    onSubjectChange(selectedReviewSubject(items));
  }

  function toggleCitation(checked: boolean) {
    if (disabled) return;
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
        key={searchScope}
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
