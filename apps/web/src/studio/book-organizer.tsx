import { useId, useMemo, useState, type FormEvent } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import {
  bookChapterSelection,
  bookMoveDestinations,
  bookMovePositions,
  bookTocIndex,
  moveBookOccurrence,
  moveBookOccurrenceTo,
  type BookChapterSelection,
  type BookTocIndex,
  type BookTocRow,
} from './book-toc';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { sameExact, type BookStructure, type BookStructureChange } from './contract';
import { HostedHistoryDisclosure } from './hosted-history-view';
import type { HostedHistoryBinding } from './hosted-history';
import type { StudioController, StudioState } from './controller';

export function BookOrganizer({
  controller,
  state,
  onOpen,
  history,
}: {
  history?: HostedHistoryBinding;
  controller: StudioController;
  state: StudioState;
  onOpen: (postId: string) => void;
}) {
  const structure = state.structure;
  const adapter = useMemo(() => {
    if (!structure) return { outline: null, error: null };
    try {
      return { outline: bookTocIndex(structure), error: null };
    } catch (error) {
      return { outline: null, error: error instanceof Error ? error.message : 'The table of contents is unavailable.' };
    }
  }, [structure]);
  if (!structure) return null;
  if (adapter.error) return <p role="alert">{adapter.error}</p>;
  const outline = adapter.outline!;
  const selections = bookChapterSelection(outline, state.selectedOccurrences);
  const locale = getLocale();
  const selectionDisabled = Boolean(state.busy) || controller.hasUnresolvedCommand() || !controller.input.canPublish;
  const editable = controller.canOrganize() && !state.busy && !controller.hasUnresolvedCommand();
  return (
    <section aria-label="Book table of contents" className="studio-toc">
      <div className="studio-section-heading">
        <h2>Table of contents</h2>
        <span>
          {outline.rows.length} / {structure.limits.maxPlacements}
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
      {!controller.canOrganize() ? <p className="studio-help">Organization is unavailable for this visit.</p> : null}
      {outline.rows.length ? (
        <TocBranch
          parent={null}
          outline={outline}
          selections={selections}
          state={state}
          controller={controller}
          editable={editable}
          onOpen={onOpen}
        />
      ) : (
        <p>No parts or chapters yet. Create a draft, then place its saved version here.</p>
      )}
      {controller.canOrganize() ? (
        <PlacementForm
          key={structure.revision}
          structure={structure}
          rows={outline.rows}
          state={state}
          disabled={!editable || outline.rows.length >= structure.limits.maxPlacements}
          onChange={controller.organize}
        />
      ) : null}
      {history ? <HostedHistoryDisclosure key={structure.catalogueId} binding={history} /> : null}
      <details className="studio-technical">
        <summary>Structure version</summary>
        <dl>
          <dt>Catalogue</dt>
          <dd>{structure.catalogueId}</dd>
          <dt>Revision</dt>
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
}: {
  row: BookTocRow;
  outline: BookTocIndex;
  selections: ReadonlyMap<string | null, BookChapterSelection>;
  state: StudioState;
  controller: StudioController;
  editable: boolean;
  onOpen: (postId: string) => void;
}) {
  const { placement } = row;
  const [title, setTitle] = useState(placement.title);
  const [removing, setRemoving] = useState(false);
  const [moving, setMoving] = useState(false);
  const locale = getLocale();
  const renameId = useId();
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
  const hasDescendants = outline.maxDescendantDepth.get(placement.occurrenceId)! > row.depth;
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
      {target.kind === 'chapter' ? (
        <p className="studio-help studio-break">Pinned version: {target.document.revisionId}</p>
      ) : (
        <p className="studio-help">{m.studio_book_release_count(selection, { locale })}</p>
      )}
      <details className="studio-toc-actions">
        <summary>
          Organize <span className="studio-sr-only">{placement.title}</span>
        </summary>
        <div className="studio-action-row">
          <Button type="button" variant="outline" disabled={!editable} onClick={() => setMoving(true)}>
            {m.studio_book_move_to({}, { locale })}
          </Button>
          {(['up', 'down', 'in', 'out'] as const).map((direction) => {
            const change = moveBookOccurrence(row, direction, outline);
            return (
              <Button
                key={direction}
                type="button"
                variant="outline"
                disabled={!editable || !change}
                aria-label={`${direction === 'in' ? 'Nest' : direction === 'out' ? 'Unnest' : `Move ${direction}`} ${placement.title}`}
                onClick={() => {
                  if (change) void controller.organize(change);
                }}
              >
                {direction === 'in' ? 'Nest' : direction === 'out' ? 'Unnest' : `Move ${direction}`}
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
              Use saved version
            </Button>
          ) : null}
        </div>
        {moving ? (
          <MoveForm
            occurrenceId={placement.occurrenceId}
            outline={outline}
            controller={controller}
            disabled={!editable}
            onClose={() => setMoving(false)}
          />
        ) : null}
        <form
          className="studio-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim())
              void controller.organize({ kind: 'rename', occurrenceId: placement.occurrenceId, title: title.trim() });
          }}
        >
          <label htmlFor={renameId}>Placement title</label>
          <Input
            id={renameId}
            value={title}
            disabled={!editable}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={!editable || !title.trim() || title.trim() === placement.title}
          >
            Rename
          </Button>
        </form>
        {removing ? (
          <div className="studio-stack" role="group" aria-label={`Remove ${placement.title}`}>
            <p>
              Remove this placement{hasDescendants ? ' and its nested placements' : ''}? The documents and previous
              publications remain.
            </p>
            <div className="studio-action-row">
              <Button
                type="button"
                variant="destructive"
                disabled={!editable}
                onClick={() => void controller.organize({ kind: 'remove', occurrenceId: placement.occurrenceId })}
              >
                Remove placement
              </Button>
              <Button type="button" variant="outline" onClick={() => setRemoving(false)}>
                Keep placement
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" variant="outline" disabled={!editable} onClick={() => setRemoving(true)}>
            Remove…
          </Button>
        )}
      </details>
    </div>
  );
}
/** Numbering distinguishes repeated titles; submitted values remain exact occurrence IDs. */
function moveRowLabel(row: BookTocRow, outline: BookTocIndex): string {
  const position = [...row.ancestors.map((id) => outline.byId.get(id)!.index + 1), row.index + 1].join('.');
  return `${position} · ${row.placement.title}`;
}

function MoveForm({
  occurrenceId,
  outline,
  controller,
  disabled,
  onClose,
}: {
  occurrenceId: string;
  outline: BookTocIndex;
  controller: StudioController;
  disabled: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const locale = getLocale();
  const destinations = useMemo(() => bookMoveDestinations(occurrenceId, outline), [occurrenceId, outline]);
  const [parent, setParent] = useState<string | null>(() => {
    const current = outline.byId.get(occurrenceId)!.placement.parentOccurrenceId;
    return destinations.includes(current) ? current : (destinations[0] ?? null);
  });
  const positions = useMemo(() => bookMovePositions(occurrenceId, parent, outline), [occurrenceId, parent, outline]);
  const [before, setBefore] = useState<string | null>(() => (positions.includes(null) ? null : (positions[0] ?? null)));
  const parents = destinations.map((value) => ({
    value,
    label: value === null ? m.studio_book_move_root({}, { locale }) : moveRowLabel(outline.byId.get(value)!, outline),
  }));
  const anchors = positions.map((value) => ({
    value,
    label: value === null ? m.studio_book_move_end({}, { locale }) : moveRowLabel(outline.byId.get(value)!, outline),
  }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    const current = controller.snapshot();
    if (
      disabled ||
      !controller.canOrganize() ||
      current.busy ||
      controller.hasUnresolvedCommand() ||
      !current.structure
    )
      return;
    // A retained form may outlive a refresh or quick move. Recheck identities and bounds on the current revision.
    const latest = bookTocIndex(current.structure);
    const change = moveBookOccurrenceTo(occurrenceId, parent, before, latest);
    if (change && (await controller.organize(change))) onClose();
  }
  return (
    <form className="studio-stack studio-move-form" onSubmit={(event) => void submit(event)}>
      {destinations.length ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-parent`}>{m.studio_book_move_destination({}, { locale })}</FieldLabel>
            <Select<string>
              items={parents}
              value={parent}
              disabled={disabled}
              onValueChange={(value) => {
                setParent(value);
                const next = bookMovePositions(occurrenceId, value, outline);
                setBefore(next.includes(null) ? null : (next[0] ?? null));
              }}
            >
              <SelectTrigger id={`${id}-parent`} className="min-h-11 w-full">
                <SelectValue>
                  {parents.find((item) => item.value === parent)?.label ??
                    m.studio_book_move_choose_destination({}, { locale })}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {parents.map(({ value, label }) => (
                    <SelectItem key={value ?? ''} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-before`}>{m.studio_book_move_before({}, { locale })}</FieldLabel>
            <Select<string>
              items={anchors}
              value={before}
              disabled={disabled || !positions.length}
              onValueChange={setBefore}
            >
              <SelectTrigger id={`${id}-before`} className="min-h-11 w-full">
                <SelectValue>
                  {anchors.find((item) => item.value === before)?.label ??
                    m.studio_book_move_choose_position({}, { locale })}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {anchors.map(({ value, label }) => (
                    <SelectItem key={value ?? ''} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </>
      ) : (
        <p className="studio-help">{m.studio_book_move_unavailable({}, { locale })}</p>
      )}
      <div className="studio-action-row">
        <Button type="submit" disabled={disabled || !moveBookOccurrenceTo(occurrenceId, parent, before, outline)}>
          {m.studio_book_move_action({}, { locale })}
        </Button>
        <Button type="button" variant="outline" disabled={disabled} onClick={onClose}>
          {m.action_cancel({}, { locale })}
        </Button>
      </div>
    </form>
  );
}

function PlacementForm({
  structure,
  rows,
  state,
  disabled,
  onChange,
}: {
  structure: BookStructure;
  rows: readonly BookTocRow[];
  state: StudioState;
  disabled: boolean;
  onChange: (change: BookStructureChange) => Promise<boolean>;
}) {
  const id = useId();
  const [kind, setKind] = useState<'part' | 'chapter'>('chapter');
  const [title, setTitle] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const kinds = [
    { value: 'chapter' as const, label: 'Saved document as chapter' },
    { value: 'part' as const, label: 'Part' },
  ];
  const parents = [
    { value: null, label: 'Book root' },
    ...rows
      .filter((row) => row.placement.target.kind === 'part' && row.depth + 1 < structure.limits.maxDepth)
      .map((row) => ({
        value: row.placement.occurrenceId,
        label: `${'— '.repeat(row.depth)}${row.placement.title}`,
      })),
  ];
  const selected = state.selected;
  const canPlace = Boolean(
    selected && !selected.dirty && !selected.snapshotPending && !selected.invalid && !selected.uploading,
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || !title.trim() || (kind === 'chapter' && !canPlace)) return;
    const target =
      kind === 'part'
        ? { kind: 'part' as const }
        : selected
          ? { kind: 'chapter' as const, document: selected.source.revision.exact }
          : null;
    if (!target) return;
    const saved = await onChange({
      kind: 'insert',
      parentOccurrenceId: parent,
      beforeOccurrenceId: null,
      title: title.trim(),
      target,
    });
    if (saved) setTitle('');
  }
  return (
    <details className="studio-placement-form">
      <summary>Add part or chapter</summary>
      <form onSubmit={(event) => void submit(event)} className="studio-stack">
        <Field>
          <FieldLabel htmlFor={`${id}-kind`}>Add</FieldLabel>
          <Select<'part' | 'chapter'>
            items={kinds}
            value={kind}
            disabled={disabled}
            onValueChange={(value) => setKind(value ?? 'chapter')}
          >
            <SelectTrigger
              id={`${id}-kind`}
              aria-describedby={kind === 'chapter' ? `${id}-document` : undefined}
              className="min-h-11 w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {kinds.map(({ value, label }) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {kind === 'chapter' ? (
            <FieldDescription id={`${id}-document`} className="studio-help">
              {selected
                ? `Selected document: ${selected.title}. Save all changes before placing it.`
                : 'Open or create a draft first.'}
            </FieldDescription>
          ) : null}
        </Field>
        <label htmlFor={`${id}-title`}>Placement title</label>
        <Input
          id={`${id}-title`}
          value={title}
          required
          disabled={disabled}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Field>
          <FieldLabel htmlFor={`${id}-parent`}>Place inside</FieldLabel>
          <Select<string> items={parents} value={parent} disabled={disabled} onValueChange={setParent}>
            <SelectTrigger id={`${id}-parent`} className="min-h-11 w-full">
              <SelectValue placeholder="Book root" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {parents.map(({ value, label }) => (
                  <SelectItem key={value ?? ''} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Button type="submit" disabled={disabled || !title.trim() || (kind === 'chapter' && !canPlace)}>
          Add {kind}
        </Button>
      </form>
    </details>
  );
}
