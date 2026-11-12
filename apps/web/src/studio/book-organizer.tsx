import { useId, useMemo, useState, type FormEvent } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { bookTocRows, moveBookOccurrence, type BookTocRow } from './book-toc';
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
    if (!structure) return { rows: [], error: null };
    try {
      return { rows: bookTocRows(structure), error: null };
    } catch (error) {
      return { rows: [], error: error instanceof Error ? error.message : 'The table of contents is unavailable.' };
    }
  }, [structure]);
  if (!structure) return null;
  if (adapter.error) return <p role="alert">{adapter.error}</p>;
  const editable = controller.canOrganize() && !state.busy && !controller.hasUnresolvedCommand();
  return (
    <section aria-label="Book table of contents" className="studio-toc">
      <div className="studio-section-heading">
        <h2>Table of contents</h2>
        <span>
          {adapter.rows.length} / {structure.limits.maxPlacements}
        </span>
      </div>
      <p className="studio-help">Select chapters for the next release. Each placement keeps its own exact version.</p>
      {!controller.canOrganize() ? <p className="studio-help">Organization is unavailable for this visit.</p> : null}
      {adapter.rows.length ? (
        <TocBranch
          parent={null}
          rows={adapter.rows}
          structure={structure}
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
          rows={adapter.rows}
          state={state}
          disabled={!editable || adapter.rows.length >= structure.limits.maxPlacements}
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
  rows,
  ...props
}: {
  parent: string | null;
  rows: readonly BookTocRow[];
  structure: BookStructure;
  state: StudioState;
  controller: StudioController;
  editable: boolean;
  onOpen: (postId: string) => void;
}) {
  const siblings = rows.filter((row) => row.placement.parentOccurrenceId === parent);
  return (
    <ol className="studio-toc-branch">
      {siblings.map((row) => (
        <li key={row.placement.occurrenceId}>
          <TocEntry row={row} rows={rows} {...props} />
          {row.placement.target.kind === 'part' ? (
            <TocBranch parent={row.placement.occurrenceId} rows={rows} {...props} />
          ) : null}
        </li>
      ))}
    </ol>
  );
}
function TocEntry({
  row,
  rows,
  structure,
  state,
  controller,
  editable,
  onOpen,
}: {
  row: BookTocRow;
  rows: readonly BookTocRow[];
  structure: BookStructure;
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
  const descendants = rows.filter((candidate) => candidate.ancestors.includes(placement.occurrenceId));
  const deepest = Math.max(row.depth, ...descendants.map((candidate) => candidate.depth));
  const move = (direction: 'up' | 'down' | 'in' | 'out') => {
    if (direction === 'in' && deepest + 1 >= structure.limits.maxDepth) return null;
    return moveBookOccurrence(row, direction, rows);
  };
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
            const change = move(direction);
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
              Remove this placement{descendants.length ? ' and its nested placements' : ''}? The documents and previous
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
  const [parent, setParent] = useState('');
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
      parentOccurrenceId: parent || null,
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
        <label htmlFor={`${id}-kind`}>Add</label>
        <select
          id={`${id}-kind`}
          value={kind}
          disabled={disabled}
          onChange={(event) => setKind(event.target.value === 'part' ? 'part' : 'chapter')}
        >
          <option value="chapter">Saved document as chapter</option>
          <option value="part">Part</option>
        </select>
        {kind === 'chapter' ? (
          <p className="studio-help">
            {selected
              ? `Selected document: ${selected.title}. Save all changes before placing it.`
              : 'Open or create a draft first.'}
          </p>
        ) : null}
        <label htmlFor={`${id}-title`}>Placement title</label>
        <Input
          id={`${id}-title`}
          value={title}
          required
          disabled={disabled}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label htmlFor={`${id}-parent`}>Place inside</label>
        <select
          id={`${id}-parent`}
          value={parent}
          disabled={disabled}
          onChange={(event) => setParent(event.target.value)}
        >
          <option value="">Book root</option>
          {rows
            .filter((row) => row.placement.target.kind === 'part' && row.depth + 1 < structure.limits.maxDepth)
            .map((row) => (
              <option
                key={row.placement.occurrenceId}
                value={row.placement.occurrenceId}
              >{`${'— '.repeat(row.depth)}${row.placement.title}`}</option>
            ))}
        </select>
        <Button type="submit" disabled={disabled || !title.trim() || (kind === 'chapter' && !canPlace)}>
          Add {kind}
        </Button>
      </form>
    </details>
  );
}
