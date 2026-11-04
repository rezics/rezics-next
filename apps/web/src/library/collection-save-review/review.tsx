import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { pageText } from '../../features/pages/shared';
import { libraryTitleValue } from '../title';
import type { CollectionMember, CollectionVisibility } from '../reads';
import type { CollectionTypeOption } from '../collection-presentation';
import type { EditableCollectionPage } from '../collection-load';
import { useState } from 'react';
import type {
  CollectionMetadataChange,
  CollectionSaveReviewPlan,
  CollectionSaveStepOutcome,
  CollectionSavePlanStep,
  ReviewedCollectionMemberOperation,
} from '../collection-member-edit-plan';
import { CollectionPresentationSummary } from '../showcase-collection/presentation';
import { Button } from '@rezics/ui/shadcn/button';

type BasisState = 'idle' | 'reading' | 'ready' | 'unavailable';

export type CollectionSaveReviewProps = {
  plan: CollectionSaveReviewPlan;
  initial: readonly CollectionMember[];
  desired: readonly CollectionMember[];
  types?: readonly CollectionTypeOption[] | null | undefined;
  outcomes?: readonly CollectionSaveStepOutcome[];
  complete?: boolean;
  recoverCurrent?: boolean;
  basisState?: BasisState;
  currentBasis?: EditableCollectionPage | null;
  rebaseIssue?: { operation: ReviewedCollectionMemberOperation; reason: 'member-missing' | 'anchor-missing' } | null;
  onRetry?: () => void;
  onReadCurrent?: () => void;
  onDiscard?: () => void;
  onDiscardUnavailable?: () => void;
  onReviewCurrent?: () => void;
};

function titleOf(member: CollectionMember | undefined): string {
  return member?.subject
    ? pageText(libraryTitleValue(member.subject.label), getLocale()).text
    : m.library_subject_unavailable();
}

function occurrence(
  memberId: string,
  position: number | null,
  members: readonly CollectionMember[],
): string {
  const member = members.find((candidate) => candidate.id === memberId);
  if (position === null) return titleOf(member);
  return m.library_member_occurrence({ title: titleOf(member), position });
}

function formatNote(value: string | null): string {
  return value === null || value === '' ? m.collection_review_empty_value() : value;
}

function metadataLabel(change: CollectionMetadataChange): string {
  switch (change.field) {
    case 'title':
      return m.collection_review_title();
    case 'description':
      return m.collection_review_description();
    case 'visibility':
      return m.collection_review_visibility();
    case 'presentationKind':
      return m.library_collection_kind();
    case 'coverMediaId':
      return m.subject_cover();
  }
}

function metadataValue(
  change: CollectionMetadataChange,
  value: string | null,
  types: readonly CollectionTypeOption[] | null | undefined,
  members: readonly CollectionMember[],
): string {
  if (value === null) {
    if (change.field === 'presentationKind') return m.library_collection_mixed_label();
    if (change.field === 'coverMediaId') return m.library_collection_auto();
    return m.collection_review_no_value();
  }
  if (change.field === 'visibility') {
    return value === 'public'
      ? m.library_visibility_public()
      : value === 'unlisted'
        ? m.library_visibility_unlisted()
        : m.library_visibility_private();
  }
  if (change.field === 'presentationKind') return types?.find((type) => type.id === value)?.label ?? value;
  if (change.field === 'coverMediaId') {
    const member = members.find((candidate) => candidate.subject?.cover?.media === value);
    return member ? titleOf(member) : m.library_collection_current_cover();
  }
  return value === '' ? m.collection_review_empty_value() : value;
}

function MetadataChanges({
  changes,
  types,
  members,
}: {
  changes: readonly CollectionMetadataChange[];
  types?: readonly CollectionTypeOption[] | null | undefined;
  members: readonly CollectionMember[];
}) {
  if (changes.length === 0) return <p>{m.collection_review_metadata_no_change()}</p>;
  return (
    <dl className="grid min-w-0 gap-3 sm:grid-cols-[minmax(8rem,0.35fr)_minmax(0,1fr)]">
      {changes.map((change) => (
        <div key={change.field} className="contents" data-metadata-field={change.field}>
          <dt className="font-medium">{metadataLabel(change)}</dt>
          <dd className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
            <p>
              <span className="text-muted-foreground">{m.collection_review_before()}: </span>
              <span data-metadata-before={change.before ?? ''}>
                {metadataValue(change, change.before, types, members)}
              </span>
            </p>
            <p>
              <span className="text-muted-foreground">{m.collection_review_after()}: </span>
              <span data-metadata-after={change.after ?? ''}>
                {metadataValue(change, change.after, types, members)}
              </span>
            </p>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function MemberOperationText({
  entry,
  initial,
  desired,
}: {
  entry: ReviewedCollectionMemberOperation;
  initial: readonly CollectionMember[];
  desired: readonly CollectionMember[];
}) {
  const operation = entry.operation;
  const title = occurrence(operation.memberId, entry.beforePosition, initial);
  if (operation.kind === 'remove') {
    return (
      <div className="space-y-2" data-operation-kind="remove" data-member-id={operation.memberId}>
        <p>{m.collection_review_remove_context({ title, position: entry.beforePosition })}</p>
        <p className="text-muted-foreground">
          {m.collection_review_removed_note()}: {formatNote(entry.beforeNote)}
        </p>
      </div>
    );
  }
  if (operation.kind === 'note') {
    return (
      <div className="space-y-2" data-operation-kind="note" data-member-id={operation.memberId}>
        <p>{m.collection_review_note_context({ title })}</p>
        <dl className="grid gap-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3">
          <dt className="text-muted-foreground">{m.collection_review_before()}</dt>
          <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{formatNote(entry.beforeNote)}</dd>
          <dt className="text-muted-foreground">{m.collection_review_after()}</dt>
          <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{formatNote(entry.afterNote)}</dd>
        </dl>
      </div>
    );
  }
  const beforeAnchor = entry.beforeAnchorId
    ? occurrence(
        entry.beforeAnchorId,
        initial.findIndex((member) => member.id === entry.beforeAnchorId) + 1,
        initial,
      )
    : m.collection_review_start();
  const afterAnchor = operation.after
    ? occurrence(
        operation.after,
        desired.findIndex((member) => member.id === operation.after) + 1,
        desired,
      )
    : m.collection_review_start();
  return (
    <div className="space-y-2" data-operation-kind="move" data-member-id={operation.memberId}>
      <p>
        {m.collection_review_move_context({
          title,
          before: entry.beforePosition,
          after: entry.afterPosition ?? entry.beforePosition,
        })}
      </p>
      <dl className="grid gap-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3">
        <dt className="text-muted-foreground">{m.collection_review_before()}</dt>
        <dd>{m.collection_review_after_anchor({ anchor: beforeAnchor })}</dd>
        <dt className="text-muted-foreground">{m.collection_review_after()}</dt>
        <dd>{m.collection_review_after_anchor({ anchor: afterAnchor })}</dd>
      </dl>
    </div>
  );
}

function PlanStep({
  step,
  initial,
  desired,
  types,
}: {
  step: CollectionSavePlanStep;
  initial: readonly CollectionMember[];
  desired: readonly CollectionMember[];
  types?: readonly CollectionTypeOption[] | null | undefined;
}) {
  if (step.kind === 'metadata') {
    return (
      <li data-review-step={step.id} data-review-kind="metadata" className="space-y-3 rounded-lg bg-muted/35 p-3">
        <h3 className="font-medium">{m.collection_review_metadata()}</h3>
        <MetadataChanges changes={step.changes} types={types} members={[...initial, ...desired]} />
        {step.changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.collection_review_revision_step()}</p>
        ) : null}
      </li>
    );
  }
  if (step.kind === 'remove-batch') {
    return (
      <li data-review-step={step.id} data-review-kind="remove-batch" className="space-y-2 rounded-lg bg-destructive/5 p-3">
        <h3 className="font-medium text-destructive">
          {m.collection_review_batch_remove({ count: step.operations.length })}
        </h3>
        <ul className="space-y-2">
          {step.operations.map((entry) => (
            <li key={entry.id} data-review-operation={entry.id}>
              <MemberOperationText entry={entry} initial={initial} desired={desired} />
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{m.collection_review_removal_undo()}</p>
      </li>
    );
  }
  if (step.kind === 'transfer') {
    return (
      <li data-review-step={step.id} data-review-kind="transfer" className="space-y-2 rounded-lg bg-muted/35 p-3">
        <h3 className="font-medium">
          {m.collection_review_transfer({
            count: step.memberIds.length,
            source: step.sourceTitle,
            destination: step.destinationTitle,
          })}
        </h3>
        <p>
          {step.after === null
            ? m.collection_review_transfer_start()
            : m.collection_review_transfer_after({ anchor: step.after })}
        </p>
      </li>
    );
  }
  return (
    <li
      data-review-step={step.id}
      data-review-kind={step.operation.operation.kind}
      data-review-operation={step.operation.id}
      className="rounded-lg bg-muted/35 p-3"
    >
      <MemberOperationText entry={step.operation} initial={initial} desired={desired} />
    </li>
  );
}

function OutcomeText({
  step,
  initial,
  desired,
  types,
}: {
  step: CollectionSavePlanStep;
  initial: readonly CollectionMember[];
  desired: readonly CollectionMember[];
  types?: readonly CollectionTypeOption[] | null | undefined;
}) {
  if (step.kind === 'metadata')
    return <MetadataChanges changes={step.changes} types={types} members={[...initial, ...desired]} />;
  if (step.kind === 'remove-batch') {
    return (
      <ul className="space-y-2">
        {step.operations.map((entry) => (
          <li key={entry.id}>
            <MemberOperationText entry={entry} initial={initial} desired={desired} />
          </li>
        ))}
      </ul>
    );
  }
  if (step.kind === 'transfer')
    return (
      <p>
        {m.collection_review_transfer({
          count: step.memberIds.length,
          source: step.sourceTitle,
          destination: step.destinationTitle,
        })}
      </p>
    );
  return <MemberOperationText entry={step.operation} initial={initial} desired={desired} />;
}

function outcomeHeading(status: CollectionSaveStepOutcome['status']): string {
  switch (status) {
    case 'confirmed':
      return m.collection_save_confirmed();
    case 'unknown':
    case 'pending':
      return m.collection_save_unknown();
    case 'refused':
      return m.collection_save_refused();
    case 'conflict':
      return m.collection_save_conflicting();
    case 'not-sent':
      return m.collection_save_not_sent();
  }
}

function OutcomeGroups({
  outcomes,
  plan,
  initial,
  desired,
  types,
}: {
  outcomes: readonly CollectionSaveStepOutcome[];
  plan: CollectionSaveReviewPlan;
  initial: readonly CollectionMember[];
  desired: readonly CollectionMember[];
  types?: readonly CollectionTypeOption[] | null | undefined;
}) {
  const steps = new Map(plan.steps.map((step) => [step.id, step]));
  const statuses: readonly CollectionSaveStepOutcome['status'][] = [
    'confirmed',
    'pending',
    'unknown',
    'conflict',
    'refused',
    'not-sent',
  ];
  return (
    <div className="space-y-4" data-collection-save-outcomes>
      {statuses.map((status) => {
        const rows = outcomes.filter((outcome) => outcome.status === status);
        if (rows.length === 0) return null;
        return (
          <section
            key={status}
            aria-label={outcomeHeading(status)}
            data-outcome-group={status}
            className="space-y-2"
          >
            <h4 className="text-sm font-semibold">{outcomeHeading(status)}</h4>
            <ol className="space-y-2">
              {rows.map((outcome) => {
                const step = steps.get(outcome.stepId);
                if (!step) return null;
                return (
                  <li
                    key={outcome.stepId}
                    data-save-outcome={outcome.status}
                    data-save-step={outcome.stepId}
                    className="min-w-0 space-y-2 rounded-lg border border-border p-3"
                    role={status === 'unknown' || status === 'conflict' || status === 'refused' ? 'alert' : undefined}
                  >
                    <OutcomeText step={step} initial={initial} desired={desired} types={types} />
                    {outcome.revision !== undefined ? (
                      <p className="text-sm text-muted-foreground">
                        {m.collection_save_native_revision({ revision: outcome.revision })}
                      </p>
                    ) : null}
                    {outcome.targetId ? (
                      <p className="break-all font-mono text-xs text-muted-foreground" data-native-target>
                        {m.collection_save_native_target_id({ target: outcome.targetId })}
                      </p>
                    ) : null}
                    {outcome.status === 'confirmed' && outcome.revision === undefined ? (
                      <p className="text-sm text-muted-foreground">{m.collection_save_revision_not_returned()}</p>
                    ) : null}
                    {outcome.destinationRevision !== undefined ? (
                      <p className="text-sm text-muted-foreground">
                        {m.collection_save_native_destination_revision({ revision: outcome.destinationRevision })}
                      </p>
                    ) : null}
                    {outcome.undo?.length ? (
                      <div className="space-y-1 text-sm text-muted-foreground">
                        <p>{m.collection_save_undo_available({ count: outcome.undo.length })}</p>
                        <ul className="space-y-1">
                          {outcome.undo.map((episode) => {
                            const entry =
                              step.kind === 'member'
                                ? step.operation.operation.memberId === episode.memberId
                                  ? step.operation
                                  : undefined
                                : step.kind === 'remove-batch'
                                  ? step.operations.find((operation) => operation.operation.memberId === episode.memberId)
                                  : undefined;
                            return (
                              <li
                                key={episode.deletionId}
                                data-undo-member={episode.memberId}
                                className="break-all font-mono text-xs"
                              >
                                {m.collection_save_undo_receipt({
                                  title: entry
                                    ? occurrence(episode.memberId, entry.beforePosition, initial)
                                    : m.library_subject_unavailable(),
                                  receipt: episode.deletionId,
                                  revision: episode.revision,
                                })}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : null}
                    {outcome.status === 'unknown' ? <p>{m.collection_save_unknown_help()}</p> : null}
                    {outcome.status === 'refused' ? <p>{m.collection_save_refused_help()}</p> : null}
                    {outcome.status === 'conflict' ? <p>{m.collection_save_conflict_help()}</p> : null}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function BasisMembers({
  heading,
  page,
}: {
  heading: string;
  page: Pick<
    EditableCollectionPage,
    | 'id'
    | 'revision'
    | 'title'
    | 'description'
    | 'visibility'
    | 'members'
    | 'presentationKind'
    | 'presentationTypes'
    | 'coverMediaId'
  >;
}) {
  const coverMember = page.members.find((member) => member.subject?.cover?.media === page.coverMediaId);
  return (
    <section className="min-w-0 space-y-3 rounded-lg border border-border p-3" data-collection-basis={page.revision}>
      <h4 className="font-semibold">{heading}</h4>
      <div className="space-y-1 text-sm">
        <p className="font-medium whitespace-pre-wrap [overflow-wrap:anywhere]">{page.title}</p>
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{page.description || m.collection_review_no_value()}</p>
        <p>
          {page.visibility === 'public'
            ? m.library_visibility_public()
            : page.visibility === 'unlisted'
              ? m.library_visibility_unlisted()
              : m.library_visibility_private()}
        </p>
        <CollectionPresentationSummary kind={page.presentationKind ?? null} types={page.presentationTypes} />
        <p>
          {m.subject_cover()}: {coverMember ? titleOf(coverMember) : page.coverMediaId ? m.library_collection_current_cover() : m.library_collection_auto()}
        </p>
        <p className="text-muted-foreground">{m.collection_save_basis_revision({ revision: page.revision })}</p>
      </div>
      <ol className="space-y-2" aria-label={m.library_collection_members()}>
        {page.members.map((member, index) => (
          <li key={member.id} className="rounded-md bg-muted/30 p-2" data-basis-member={member.id}>
            <p>{m.library_member_occurrence({ title: titleOf(member), position: index + 1 })}</p>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{formatNote(member.note)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CurrentBasis({
  basisState,
  currentBasis,
  initial,
  desired,
  metadataChanges,
  types,
  onReadCurrent,
  onDiscard,
  onDiscardUnavailable,
  onReviewCurrent,
  rebaseIssue,
  canReviewCurrent,
}: {
  basisState: BasisState;
  currentBasis: EditableCollectionPage | null;
  initial: readonly CollectionMember[];
  desired: readonly CollectionMember[];
  metadataChanges: readonly CollectionMetadataChange[];
  types?: readonly CollectionTypeOption[] | null | undefined;
  onReadCurrent?: () => void;
  onDiscard?: () => void;
  onDiscardUnavailable?: () => void;
  onReviewCurrent?: () => void;
  rebaseIssue: CollectionSaveReviewProps['rebaseIssue'];
  canReviewCurrent: boolean;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3" data-conflict-basis>
      <h3 className="font-semibold">{m.collection_save_current_basis()}</h3>
      <p>{m.collection_save_draft_preserved()}</p>
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <section className="min-w-0 space-y-2 rounded-lg border border-border p-3" data-remaining-draft>
          <h4 className="font-semibold">{m.collection_save_remaining_draft()}</h4>
          {metadataChanges.length ? (
            <MetadataChanges changes={metadataChanges} types={types} members={[...initial, ...desired]} />
          ) : null}
          <ol className="space-y-2">
            {desired.map((member, index) => (
              <li key={member.id} className="rounded-md bg-muted/30 p-2" data-draft-member={member.id}>
                <p>{m.library_member_occurrence({ title: titleOf(member), position: index + 1 })}</p>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{formatNote(member.note)}</p>
              </li>
            ))}
          </ol>
        </section>
        {basisState === 'ready' && currentBasis ? (
          <BasisMembers heading={m.collection_save_current_basis()} page={currentBasis} />
        ) : (
          <section className="space-y-2 rounded-lg border border-border p-3" aria-live="polite">
            <h4 className="font-semibold">{m.collection_save_current_basis()}</h4>
            <p>
              {basisState === 'reading'
                ? m.collection_save_basis_reading()
                : m.collection_save_basis_unavailable()}
            </p>
            {basisState !== 'reading' && onReadCurrent ? (
              <Button type="button" variant="outline" onClick={onReadCurrent}>
                {m.collection_save_read_current()}
              </Button>
            ) : null}
          </section>
        )}
      </div>
      {rebaseIssue ? (
        <p role="alert">
          {rebaseIssue.reason === 'member-missing'
            ? m.collection_save_unavailable_member({
                title: occurrence(rebaseIssue.operation.operation.memberId, rebaseIssue.operation.beforePosition, initial),
              })
            : m.collection_save_unavailable_anchor({
                title: occurrence(rebaseIssue.operation.operation.memberId, rebaseIssue.operation.beforePosition, initial),
              })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {rebaseIssue && onDiscardUnavailable ? (
          <Button type="button" variant="outline" onClick={onDiscardUnavailable}>
            {m.collection_save_discard_unavailable_change()}
          </Button>
        ) : null}
        {currentBasis && onDiscard ? (
          <Button type="button" variant="outline" onClick={onDiscard}>
            {m.collection_save_discard_draft()}
          </Button>
        ) : null}
        {currentBasis && onReviewCurrent ? (
          <Button type="button" disabled={!canReviewCurrent || Boolean(rebaseIssue)} onClick={onReviewCurrent}>
            {m.collection_save_review_current()}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export function CollectionSaveReview({
  plan,
  initial,
  desired,
  types,
  outcomes = [],
  complete = false,
  recoverCurrent = true,
  basisState = 'idle',
  currentBasis = null,
  rebaseIssue = null,
  onRetry,
  onReadCurrent,
  onDiscard,
  onDiscardUnavailable,
  onReviewCurrent,
}: CollectionSaveReviewProps) {
  const [open, setOpen] = useState(true);
  const unknown = outcomes.find((outcome) => outcome.status === 'unknown');
  const conflicting = outcomes.some((outcome) => outcome.status === 'conflict');
  const refused = outcomes.some((outcome) => outcome.status === 'refused');
  const blockedBeforeSend = outcomes.some((outcome) => outcome.status === 'not-sent' && Boolean(outcome.reason));
  const metadataWasConfirmed = outcomes.some(
    (outcome) => outcome.stepId === 'metadata' && outcome.status === 'confirmed',
  );
  const started = outcomes.some((outcome) => outcome.status !== 'not-sent');
  const actionLabel = unknown ? m.collection_save_retry_original() : m.collection_save_outcomes_heading();
  return (
    <section
      className="min-w-0 space-y-3 rounded-2xl border border-border bg-card p-4 [overflow-wrap:anywhere] sm:p-6"
      data-collection-edit-review
      data-plan-collection={plan.collectionId}
    >
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="min-h-11 cursor-pointer rounded-lg font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          {m.collection_review_heading()}
        </summary>
        <div className="mt-3 space-y-4">
          <p className="text-sm text-muted-foreground">{m.collection_review_native_help()}</p>
          <CollectionPresentationSummary kind={plan.after.presentationKind} types={types} />
          {plan.steps.length === 0 ? (
            <p>{m.collection_save_no_changes()}</p>
          ) : (
            <ol className="space-y-2" data-review-order>
              {plan.steps.map((step) => (
                <PlanStep
                  key={step.id}
                  step={step}
                  initial={initial}
                  desired={desired}
                  types={types}
                />
              ))}
            </ol>
          )}
        </div>
      </details>
      {started || complete ? (
        <section className="space-y-3 border-t border-border pt-3" aria-labelledby="collection-save-outcomes-heading">
          <h3 id="collection-save-outcomes-heading" className="font-semibold">
            {complete
              ? plan.steps.length === 0
                ? m.collection_save_no_changes()
                : plan.metadataChanges.length && (plan.operations.length || plan.steps.some((step) => step.kind === 'transfer'))
                ? m.collection_save_complete_mixed()
                : plan.operations.length || plan.steps.some((step) => step.kind === 'transfer')
                  ? m.collection_save_complete_members()
                  : m.collection_save_complete_metadata()
              : m.collection_save_outcomes_heading()}
          </h3>
          <OutcomeGroups outcomes={outcomes} plan={plan} initial={initial} desired={desired} types={types} />
          {unknown && onRetry ? (
            <div className="space-y-2 rounded-lg border border-amber-500/40 p-3">
              <p>{m.collection_save_unknown_help()}</p>
              <Button type="button" onClick={onRetry}>
                {actionLabel}
              </Button>
            </div>
          ) : null}
          {complete ? <p role="status">{m.collection_save_complete_return()}</p> : null}
          {(conflicting || refused || blockedBeforeSend) && recoverCurrent ? (
            <CurrentBasis
              basisState={basisState}
              currentBasis={currentBasis}
              initial={initial}
              desired={desired}
              metadataChanges={metadataWasConfirmed ? [] : plan.metadataChanges}
              types={types}
              onReadCurrent={onReadCurrent}
              onDiscard={onDiscard}
              onDiscardUnavailable={onDiscardUnavailable}
              onReviewCurrent={onReviewCurrent}
              rebaseIssue={rebaseIssue}
              canReviewCurrent={!unknown}
            />
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

