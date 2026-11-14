import { useId, useMemo } from 'react';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { bookChapterSelection, bookTocIndex, type BookChapterSelection } from './book-toc';
import type { StudioController, StudioState } from './controller';
import './book-publication-selection.css';

/** Publication inclusion stays separate from opening or organizing a draft. */
export function BookPublicationSelection({
  controller,
  state,
}: {
  controller: StudioController;
  state: StudioState;
}) {
  const structure = state.structure;
  const adapter = useMemo(() => {
    if (!structure) return { outline: null, error: false };
    try {
      return { outline: bookTocIndex(structure), error: false };
    } catch {
      return { outline: null, error: true };
    }
  }, [structure]);
  const locale = getLocale();
  const options = { locale };
  if (!structure) return null;
  if (adapter.error) return <p role="alert">{m.studio_book_outline_unavailable({}, options)}</p>;
  const outline = adapter.outline!;
  const selections = bookChapterSelection(outline, state.selectedOccurrences);
  const disabled = Boolean(state.busy) || controller.hasUnresolvedCommand() || !controller.input.canPublish;
  return (
    <div
      className="studio-book-release-selection studio-stack"
      role="group"
      aria-label={m.studio_book_release_all({}, options)}
    >
      <p className="studio-help">{m.studio_book_release_help({}, options)}</p>
      <ReleaseChoice
        label={m.studio_book_release_all({}, options)}
        selection={selections.get(null)!}
        disabled={disabled}
        onChange={(checked) => controller.selectBookChapters(null, checked)}
      />
      <p className="studio-help">{m.studio_book_release_count(selections.get(null)!, options)}</p>
      <ol className="studio-book-release-entries">
        {outline.rows.map(({ placement, depth }) => {
          const target = placement.target;
          const selection = selections.get(placement.occurrenceId)!;
          return (
            <li key={placement.occurrenceId} style={{ marginInlineStart: `${Math.min(depth, 8) * 0.75}rem` }}>
              <ReleaseChoice
                label={
                  target.kind === 'chapter'
                    ? m.studio_book_release_chapter({ title: placement.title }, options)
                    : m.studio_book_release_part({ title: placement.title }, options)
                }
                selection={selection}
                disabled={disabled}
                onChange={(checked) =>
                  target.kind === 'chapter'
                    ? controller.toggleOccurrence(placement.occurrenceId, checked)
                    : controller.selectBookChapters(placement.occurrenceId, checked)
                }
              />
              <p className="studio-help studio-break">
                {target.kind === 'chapter'
                  ? m.studio_book_pinned_version({ revision: target.document.revisionId }, options)
                  : m.studio_book_release_count(selection, options)}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ReleaseChoice({
  label,
  selection,
  disabled,
  onChange,
}: {
  label: string;
  selection: BookChapterSelection;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal" className="studio-book-release-choice">
      <FieldLabel htmlFor={id}>
        <Checkbox
          id={id}
          checked={selection.total > 0 && selection.selected === selection.total}
          indeterminate={selection.selected > 0 && selection.selected < selection.total}
          disabled={disabled || selection.total === 0}
          onCheckedChange={onChange}
        />
        <span>{label}</span>
      </FieldLabel>
    </Field>
  );
}
