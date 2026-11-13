import { useId, useMemo, useState, type FormEvent } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { bookTocIndex, moveBookOccurrence, type BookTocIndex, type BookTocRow } from './book-toc';
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
  const editable = controller.canOrganize() && !state.busy && !controller.hasUnresolvedCommand();
  return (
    <section aria-label="Book table of contents" className="studio-toc">
      <div className="studio-section-heading">
        <h2>Table of contents</h2>
        <span>
          {outline.rows.length} / {structure.limits.maxPlacements}
        </span>
      </div>
      <p className="studio-help">Select chapters for the next release. Each placement keeps its own exact version.</p>
      {!controller.canOrganize() ? <p className="studio-help">Organization is unavailable for this visit.</p> : null}
      {outline.rows.length ? (
        <TocBranch
          parent={null}
          outline={outline}
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
function TocBranch({
  parent,
  outline,
  ...props
}: {
  parent: string | null;
  outline: BookTocIndex;
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
  state,
  controller,
  editable,
  onOpen,
}: {
  row: BookTocRow;
  outline: BookTocIndex;
  state: StudioState;
  controller: StudioController;
  editable: boolean;
  onOpen: (postId: string) => void;
}) {
  const { placement } = row;
  const [title, setTitle] = useState(placement.title);
  const [removing, setRemoving] = useState(false);
  const renameId = useId();
  const target = placement.target;
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
        {target.kind === 'chapter' ? (
          <>
            <label className="studio-release-choice">
              <input
                type="checkbox"
                checked={state.selectedOccurrences.has(placement.occurrenceId)}
                disabled={Boolean(state.busy) || controller.hasUnresolvedCommand() || !controller.input.canPublish}
                onChange={(event) => controller.toggleOccurrence(placement.occurrenceId, event.target.checked)}
              />
              <span className="studio-sr-only">Include {placement.title} in the next release</span>
            </label>
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
          </>
        ) : (
          <strong className="studio-part-title">{placement.title}</strong>
        )}
      </div>
      {target.kind === 'chapter' ? (
        <p className="studio-help studio-break">Pinned version: {target.document.revisionId}</p>
      ) : null}
      <details className="studio-toc-actions">
        <summary>
          Organize <span className="studio-sr-only">{placement.title}</span>
        </summary>
        <div className="studio-action-row">
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
