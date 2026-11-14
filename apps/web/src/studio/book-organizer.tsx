import { useId, useMemo } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import {
  bookChapterSelection,
  bookTocIndex,
  moveBookOccurrence,
  type BookChapterSelection,
  type BookTocIndex,
  type BookTocRow,
} from './book-toc';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { sameExact } from './contract';
import type { BookOrganizationRequest } from './book-organization-canvas';
import { HostedHistoryDisclosure } from './hosted-history-view';
import type { HostedHistoryBinding } from './hosted-history';
import type { StudioController, StudioState } from './controller';

export function BookOrganizer({
  controller,
  state,
  onOpen,
  onOrganize,
  history,
}: {
  history?: HostedHistoryBinding;
  controller: StudioController;
  state: StudioState;
  onOpen: (postId: string) => void;
  onOrganize: (request: BookOrganizationRequest) => void;
}) {
  const structure = state.structure;
  const adapter = useMemo(() => {
    if (!structure) return { outline: null, error: null };
    try {
      return { outline: bookTocIndex(structure), error: null };
    } catch {
      return { outline: null, error: true };
    }
  }, [structure]);
  const locale = getLocale();
  if (!structure) return null;
  if (adapter.error) return <p role="alert">{m.studio_book_outline_unavailable({}, { locale })}</p>;
  const outline = adapter.outline!;
  const selections = bookChapterSelection(outline, state.selectedOccurrences);
  const selectionDisabled = Boolean(state.busy) || controller.hasUnresolvedCommand() || !controller.input.canPublish;
  const editable = controller.canOrganize() && !state.busy && !controller.hasUnresolvedCommand();
  return (
    <section aria-label={m.studio_book_outline_label({}, { locale })} className="studio-toc">
      <div className="studio-section-heading">
        <h2>{m.studio_book_outline_heading({}, { locale })}</h2>
        <span>
          {m.studio_book_outline_capacity(
            { count: outline.rows.length, limit: structure.limits.maxPlacements },
            { locale },
          )}
        </span>
      </div>
      <p className="studio-help">{m.studio_book_release_help({}, { locale })}</p>
      <ReleaseChoice
        label={m.studio_book_release_all({}, { locale })}
        selection={selections.get(null)!}
        disabled={selectionDisabled}
        visibleLabel
        onChange={(checked) => controller.selectBookChapters(null, checked)}
      />
      <p className="studio-help">{m.studio_book_release_count(selections.get(null)!, { locale })}</p>
      {!controller.canOrganize() ? (
        <p className="studio-help">{m.studio_book_organization_unavailable({}, { locale })}</p>
      ) : null}
      {outline.rows.length ? (
        <TocBranch
          parent={null}
          outline={outline}
          selections={selections}
          state={state}
          controller={controller}
          editable={editable}
          onOpen={onOpen}
          onOrganize={onOrganize}
        />
      ) : (
        <p>{m.studio_book_outline_empty({}, { locale })}</p>
      )}
      {controller.canOrganize() ? (
        <Button type="button" variant="outline" disabled={!editable} onClick={() => onOrganize({ kind: 'add' })}>
          {m.studio_book_add_heading({}, { locale })}
        </Button>
      ) : null}
      {history ? <HostedHistoryDisclosure key={structure.catalogueId} binding={history} /> : null}
      <details className="studio-technical">
        <summary>{m.studio_book_structure_version({}, { locale })}</summary>
        <dl>
          <dt>{m.studio_book_catalogue({}, { locale })}</dt>
          <dd>{structure.catalogueId}</dd>
          <dt>{m.exact_revision_id({}, { locale })}</dt>
          <dd>{structure.revision}</dd>
        </dl>
      </details>
    </section>
  );
}

function ReleaseChoice({
  label,
  selection,
  disabled,
  visibleLabel = false,
  onChange,
}: {
  label: string;
  selection: BookChapterSelection;
  disabled: boolean;
  visibleLabel?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal" className="w-auto shrink-0">
      <FieldLabel htmlFor={id} className={visibleLabel ? 'min-h-11 items-center' : 'studio-release-choice'}>
        <Checkbox
          id={id}
          checked={selection.total > 0 && selection.selected === selection.total}
          indeterminate={selection.selected > 0 && selection.selected < selection.total}
          disabled={disabled || selection.total === 0}
          onCheckedChange={onChange}
        />
        <span className={visibleLabel ? undefined : 'sr-only'}>{label}</span>
      </FieldLabel>
    </Field>
  );
}

function TocBranch({
  parent,
  outline,
  ...props
}: {
  parent: string | null;
  outline: BookTocIndex;
  selections: ReadonlyMap<string | null, BookChapterSelection>;
  state: StudioState;
  controller: StudioController;
  editable: boolean;
  onOpen: (postId: string) => void;
  onOrganize: (request: BookOrganizationRequest) => void;
}) {
  const siblings = outline.children.get(parent) ?? [];
  return (
    <ol className="studio-toc-branch">
      {siblings.map((row) => (
        <li key={row.placement.occurrenceId}>
          <TocEntry row={row} outline={outline} {...props} />
          {row.placement.target.kind === 'part' ? (
            <TocBranch parent={row.placement.occurrenceId} outline={outline} {...props} />
          ) : null}
        </li>
      ))}
    </ol>
  );
}
function TocEntry({
  row,
  outline,
  selections,
  state,
  controller,
  editable,
  onOpen,
  onOrganize,
}: {
  row: BookTocRow;
  outline: BookTocIndex;
  selections: ReadonlyMap<string | null, BookChapterSelection>;
  state: StudioState;
  controller: StudioController;
  editable: boolean;
  onOpen: (postId: string) => void;
  onOrganize: (request: BookOrganizationRequest) => void;
}) {
  const { placement } = row;
  const locale = getLocale();
  const target = placement.target;
  const selection = selections.get(placement.occurrenceId)!;
  const current = state.selected;
  const pin =
    target.kind === 'chapter' &&
    current?.source.revision.exact.postId === target.document.postId &&
    !current.dirty &&
    !current.snapshotPending &&
    !current.uploading &&
    !current.invalid &&
    !sameExact(current.source.revision.exact, target.document)
      ? current.source.revision.exact
      : null;
  return (
    <div className="studio-toc-entry">
      <div className="studio-toc-title">
        <ReleaseChoice
          label={
            target.kind === 'chapter'
              ? m.studio_book_release_chapter({ title: placement.title }, { locale })
              : m.studio_book_release_part({ title: placement.title }, { locale })
          }
          selection={selection}
          disabled={Boolean(state.busy) || controller.hasUnresolvedCommand() || !controller.input.canPublish}
          onChange={(checked) =>
            target.kind === 'chapter'
              ? controller.toggleOccurrence(placement.occurrenceId, checked)
              : controller.selectBookChapters(placement.occurrenceId, checked)
          }
        />
        {target.kind === 'chapter' ? (
          <Button
            type="button"
            variant="ghost"
            className="studio-toc-open"
            aria-current={current?.source.revision.exact.postId === target.document.postId ? 'true' : undefined}
            disabled={Boolean(state.busy) || controller.hasUnresolvedCommand()}
            onClick={() => onOpen(target.document.postId)}
          >
            {placement.title}
          </Button>
        ) : (
          <strong className="studio-part-title">{placement.title}</strong>
        )}
      </div>
      <details className="studio-toc-actions">
        <summary aria-label={m.studio_book_organize_title({ title: placement.title }, { locale })}>
          {m.studio_book_organize({}, { locale })}
        </summary>
        {target.kind === 'chapter' ? (
          <p className="studio-help studio-break">
            {m.studio_book_pinned_version({ revision: target.document.revisionId }, { locale })}
          </p>
        ) : (
          <p className="studio-help">{m.studio_book_release_count(selection, { locale })}</p>
        )}

        <div className="studio-action-row">
          <Button
            type="button"
            variant="outline"
            disabled={!editable}
            onClick={() => onOrganize({ kind: 'move', occurrenceId: placement.occurrenceId })}
          >
            {m.studio_book_move_to({}, { locale })}
          </Button>
          {(
            [
              {
                direction: 'up',
                label: m.studio_book_move_up({}, { locale }),
                name: m.studio_book_move_up_title({ title: placement.title }, { locale }),
              },
              {
                direction: 'down',
                label: m.studio_book_move_down({}, { locale }),
                name: m.studio_book_move_down_title({ title: placement.title }, { locale }),
              },
              {
                direction: 'in',
                label: m.studio_book_nest({}, { locale }),
                name: m.studio_book_nest_title({ title: placement.title }, { locale }),
              },
              {
                direction: 'out',
                label: m.studio_book_unnest({}, { locale }),
                name: m.studio_book_unnest_title({ title: placement.title }, { locale }),
              },
            ] as const
          ).map(({ direction, label, name }) => {
            const change = moveBookOccurrence(row, direction, outline);
            return (
              <Button
                key={direction}
                type="button"
                variant="outline"
                disabled={!editable || !change}
                aria-label={name}
                onClick={() => {
                  const structure = controller.snapshot().structure;
                  if (!structure) return;
                  const latest = bookTocIndex(structure);
                  const source = latest.byId.get(placement.occurrenceId);
                  const current = source ? moveBookOccurrence(source, direction, latest) : null;
                  if (current) void controller.organize(current);
                }}
              >
                {label}
              </Button>
            );
          })}
          {pin ? (
            <Button
              type="button"
              variant="outline"
              disabled={!editable}
              onClick={() =>
                void controller.organize({ kind: 'pin', occurrenceId: placement.occurrenceId, document: pin })
              }
            >
              {m.studio_book_use_saved_version({}, { locale })}
            </Button>
          ) : null}
        </div>
        <div className="studio-action-row">
          <Button
            type="button"
            variant="outline"
            disabled={!editable}
            onClick={() => onOrganize({ kind: 'rename', occurrenceId: placement.occurrenceId })}
          >
            {m.studio_book_rename({}, { locale })}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!editable}
            onClick={() => onOrganize({ kind: 'remove', occurrenceId: placement.occurrenceId })}
          >
            {m.studio_book_remove({}, { locale })}
          </Button>
        </div>
      </details>
    </div>
  );
}
