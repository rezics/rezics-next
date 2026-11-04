import { useId, type RefObject } from 'react';
import { m } from '../../paraglide/messages.js';
import type { AnnotationDraft, AnnotationField, AnnotationIssues } from './contract';
import { annotationNoteBytes } from './contract';

export type AnnotationEditorRefs = {
  note: RefObject<HTMLTextAreaElement | null>;
  priority: RefObject<HTMLInputElement | null>;
  review: RefObject<HTMLButtonElement | null>;
};

type AnnotationEditorProps = {
  draft: AnnotationDraft;
  issues: AnnotationIssues;
  disabled: boolean;
  reviewDisabled: boolean;
  canDiscard: boolean;
  refs: AnnotationEditorRefs;
  onChange: (draft: AnnotationDraft) => void;
  onReview: () => void;
  onDiscard: (trigger: HTMLButtonElement) => void;
};

export function focusAnnotationEditor(refs: AnnotationEditorRefs, field: AnnotationField) {
  const input = field === 'note' ? refs.note.current : refs.priority.current;
  input?.focus();
}

export function AnnotationEditor({
  draft,
  issues,
  disabled,
  reviewDisabled,
  canDiscard,
  refs,
  onChange,
  onReview,
  onDiscard,
}: AnnotationEditorProps) {
  const id = useId();
  const bytes = annotationNoteBytes(draft.note);
  return (
    <form
      noValidate
      aria-labelledby={id + '-heading'}
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onReview();
      }}
    >
      <div>
        <h3 id={id + '-heading'} className="font-semibold">
          {m.library_annotation_edit_title()}
        </h3>
        <p className="text-sm text-muted-foreground">{m.library_annotation_edit_help()}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(12rem,1fr)]">
        <div className="min-w-0 space-y-2">
          <label htmlFor={id + '-note'} className="block text-sm font-medium">
            {m.library_rich_entry_note()}
          </label>
          <textarea
            ref={refs.note}
            id={id + '-note'}
            className="min-h-40 w-full rounded-md border bg-background p-3 [overflow-wrap:anywhere]"
            value={draft.note}
            readOnly={disabled}
            aria-invalid={!!issues.note}
            aria-describedby={`${id}-note-help ${id}-bytes${issues.note ? ` ${id}-note-error` : ''}`}
            onChange={(event) => onChange({ ...draft, note: event.currentTarget.value })}
          />
          <p id={id + '-note-help'} className="text-sm text-muted-foreground">
            {m.library_annotation_note_help()}
          </p>
          <p id={id + '-bytes'} className="text-sm text-muted-foreground" aria-live="polite" aria-atomic="true">
            {m.library_rich_entry_note_bytes({ count: bytes })}
          </p>
          {issues.note ? (
            <p id={id + '-note-error'} className="text-sm text-destructive" role="alert">
              {m.library_annotation_note_error()}
            </p>
          ) : null}
          <button
            type="button"
            className="min-h-11 rounded-md border px-3 disabled:opacity-50"
            disabled={disabled || draft.note === ''}
            onClick={() => {
              onChange({ ...draft, note: '' });
              refs.note.current?.focus();
            }}
          >
            {m.library_rich_entry_clear_note()}
          </button>
          <p className="text-xs text-muted-foreground">{m.library_annotation_clear_note_help()}</p>
        </div>
        <div className="min-w-0 space-y-2">
          <label htmlFor={id + '-priority'} className="block text-sm font-medium">
            {m.library_rich_entry_priority()}
          </label>
          <input
            ref={refs.priority}
            id={id + '-priority'}
            className="min-h-11 w-full rounded-md border bg-background px-3"
            type="number"
            min={1}
            max={100}
            step={1}
            inputMode="numeric"
            value={draft.priority}
            readOnly={disabled}
            aria-invalid={!!issues.priority}
            aria-describedby={`${id}-priority-help${issues.priority ? ` ${id}-priority-error` : ''}`}
            onChange={(event) => onChange({ ...draft, priority: event.currentTarget.value })}
          />
          <p id={id + '-priority-help'} className="text-sm text-muted-foreground">
            {m.library_annotation_priority_help()}
          </p>
          {issues.priority ? (
            <p id={id + '-priority-error'} className="text-sm text-destructive" role="alert">
              {m.library_annotation_priority_error()}
            </p>
          ) : null}
          {draft.priority === '' ? <p className="text-sm">{m.library_rich_entry_unranked()}</p> : null}
          <button
            type="button"
            className="min-h-11 rounded-md border px-3 disabled:opacity-50"
            disabled={disabled || draft.priority === ''}
            onClick={() => {
              onChange({ ...draft, priority: '' });
              refs.priority.current?.focus();
            }}
          >
            {m.library_rich_entry_clear_priority()}
          </button>
          <p className="text-xs text-muted-foreground">{m.library_annotation_clear_priority_help()}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          ref={refs.review}
          type="submit"
          className="min-h-11 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50"
          disabled={disabled || reviewDisabled}
        >
          {m.library_annotation_review()}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border px-3 disabled:opacity-50"
          disabled={disabled || !canDiscard}
          onClick={(event) => onDiscard(event.currentTarget)}
        >
          {m.library_annotation_discard()}
        </button>
      </div>
      <p className="text-sm text-muted-foreground">{m.library_annotation_review_help()}</p>
    </form>
  );
}
