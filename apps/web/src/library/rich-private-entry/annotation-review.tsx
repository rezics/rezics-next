import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { PersonalEntry, PersonalEntryFieldChange } from '@rezics/client';
import { m } from '../../paraglide/messages.js';
import type { AnnotationConfirmation, AnnotationField } from './contract';

export function AnnotationNote({ value }: { value: string | null }) {
  return value === null ? (
    <span className="text-muted-foreground">{m.library_annotation_no_note()}</span>
  ) : (
    <span className="block whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</span>
  );
}

export function AnnotationPriority({ value }: { value: number | null }) {
  return value === null ? (
    <span>{m.library_rich_entry_unranked()}</span>
  ) : (
    <span>{m.library_rich_entry_priority_value({ value })}</span>
  );
}

function intendedValue<T>(before: T | null, operand: PersonalEntryFieldChange<T>): T | null {
  if (operand.op === 'unchanged') return before;
  if (operand.op === 'clear') return null;
  return operand.value;
}

function changeText<T>(operand: PersonalEntryFieldChange<T>) {
  if (operand.op === 'unchanged') return m.library_annotation_unchanged();
  if (operand.op === 'clear') return m.library_annotation_clear();
  return m.library_annotation_set();
}

function ReviewField({
  label,
  before,
  after,
  change,
  help,
  editLabel,
  disabled,
  onEdit,
}: {
  label: string;
  before: ReactNode;
  after: ReactNode;
  change: string;
  help: string;
  editLabel: string;
  disabled: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="min-w-0 space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-medium">{label}</h4>
        <span className="rounded-md bg-muted px-2 py-1 text-sm">{change}</span>
      </div>
      <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="mb-2 text-sm font-medium text-muted-foreground">{m.library_annotation_received()}</dt>
          <dd className="min-w-0 break-words">{before}</dd>
        </div>
        <div className="min-w-0">
          <dt className="mb-2 text-sm font-medium text-muted-foreground">{m.library_annotation_proposed()}</dt>
          <dd className="min-w-0 break-words">{after}</dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">{help}</p>
      <button
        type="button"
        className="min-h-11 rounded-md border px-3 disabled:opacity-50"
        disabled={disabled}
        onClick={onEdit}
      >
        {editLabel}
      </button>
    </div>
  );
}

type AnnotationReviewProps = {
  subject: { label: string };
  confirmation: AnnotationConfirmation;
  blocked: boolean;
  submitted: boolean;
  onEdit: (field: AnnotationField) => void;
  onSave: () => void;
  onClose: () => void;
  onDiscard: (trigger: HTMLButtonElement) => void;
};

export function AnnotationReview({
  subject,
  confirmation,
  blocked,
  submitted,
  onEdit,
  onSave,
  onClose,
  onDiscard,
}: AnnotationReviewProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const { entry, body } = confirmation;
  return (
    <section aria-labelledby={id + '-heading'} className="min-w-0 space-y-4 rounded-md border p-4">
      <div>
        <h3 ref={heading} tabIndex={-1} id={id + '-heading'} className="font-semibold outline-none">
          {m.library_annotation_review_title()}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{m.library_annotation_review_scope()}</p>
      </div>
      <dl className="rounded-md bg-muted p-3">
        <dt className="text-sm font-medium">{m.library_annotation_subject()}</dt>
        <dd className="mt-1 break-words font-semibold">{subject.label}</dd>
      </dl>
      <ReviewField
        label={m.library_rich_entry_note()}
        before={<AnnotationNote value={entry.note} />}
        after={<AnnotationNote value={intendedValue(entry.note, body.note)} />}
        change={changeText(body.note)}
        help={
          body.note.op === 'unchanged'
            ? m.library_annotation_note_preserved()
            : body.note.op === 'clear'
              ? m.library_annotation_note_cleared()
              : m.library_annotation_note_replaced()
        }
        editLabel={m.library_annotation_edit_note()}
        disabled={submitted}
        onEdit={() => onEdit('note')}
      />
      <ReviewField
        label={m.library_rich_entry_priority()}
        before={<AnnotationPriority value={entry.priority} />}
        after={<AnnotationPriority value={intendedValue(entry.priority, body.priority)} />}
        change={changeText(body.priority)}
        help={
          body.priority.op === 'unchanged'
            ? m.library_annotation_priority_preserved()
            : body.priority.op === 'clear'
              ? m.library_annotation_priority_cleared()
              : m.library_annotation_priority_replaced()
        }
        editLabel={m.library_annotation_edit_priority()}
        disabled={submitted}
        onEdit={() => onEdit('priority')}
      />
      <p className="text-sm text-muted-foreground">{m.library_annotation_review_exact()}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50"
          disabled={blocked || submitted}
          onClick={onSave}
        >
          {m.library_rich_entry_save()}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border px-3 disabled:opacity-50"
          disabled={submitted}
          onClick={onClose}
        >
          {m.library_annotation_back()}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border px-3 disabled:opacity-50"
          disabled={submitted}
          onClick={(event) => onDiscard(event.currentTarget)}
        >
          {m.library_annotation_discard()}
        </button>
      </div>
      {blocked && !submitted ? (
        <p role="status" className="text-sm">
          {m.library_annotation_review_blocked()}
        </p>
      ) : null}
    </section>
  );
}

/** Confirmed values are rendered from the native response, never from the submitted draft. */
export function AnnotationSaved({ entry }: { entry: PersonalEntry }) {
  return (
    <div className="space-y-3 rounded-md border p-3" role="status">
      <h3 className="font-semibold">{m.library_annotation_saved()}</h3>
      <p className="text-sm text-muted-foreground">{m.library_annotation_saved_help()}</p>
      <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="mb-1 text-sm font-medium">{m.library_rich_entry_note()}</dt>
          <dd>
            <AnnotationNote value={entry.note} />
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-sm font-medium">{m.library_rich_entry_priority()}</dt>
          <dd>
            <AnnotationPriority value={entry.priority} />
          </dd>
        </div>
      </dl>
    </div>
  );
}
