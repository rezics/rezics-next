import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import {
  bookMoveDestinations,
  bookMovePositions,
  bookTocIndex,
  moveBookOccurrenceTo,
  type BookTocIndex,
  type BookTocRow,
} from './book-toc';
import { sameExact, type BookStructureChange, type ExactDocument } from './contract';
import type { StudioController, StudioState } from './controller';

export type BookOrganizationRequest = { kind: 'add' } | { kind: 'rename' | 'move' | 'remove'; occurrenceId: string };
type OrganizationDraft = {
  request: BookOrganizationRequest;
  catalogueId: string;
  title: string;
  kind: 'part' | 'chapter';
  parent: string | null;
  before: string | null;
  document: { exact: ExactDocument; title: string } | null;
  dirty: boolean;
};
export function sameOrganizationRequest(a: BookOrganizationRequest, b: BookOrganizationRequest) {
  return a.kind === b.kind && (a.kind === 'add' || (b.kind !== 'add' && a.occurrenceId === b.occurrenceId));
}
function outlineFor(state: StudioState) {
  try {
    return state.structure ? bookTocIndex(state.structure) : null;
  } catch {
    return null;
  }
}

/** Visit-owned form state: neither the Menu portal nor a structure revision owns its lifetime. */
export function useBookOrganization(controller: StudioController, state: StudioState) {
  const [draft, setDraft] = useState<OrganizationDraft | null>(null);
  const current = useRef(draft);
  const submitted = useRef<OrganizationDraft | null>(null);
  const [pending, setPending] = useState(false);
  const outline = useMemo(() => outlineFor(state), [state.structure]);
  function replace(next: OrganizationDraft | null) {
    current.current = next;
    setDraft(next);
  }
  function acknowledge(attempt: OrganizationDraft) {
    if (submitted.current !== attempt) return;
    submitted.current = null;
    setPending(false);
    if (current.current !== attempt) return;
    replace(attempt.request.kind === 'add' ? { ...attempt, title: '', dirty: false } : null);
  }
  useEffect(() => {
    const attempt = submitted.current;
    if (!attempt || state.operation || !controller.current()) return;
    if (state.result === 'organized') acknowledge(attempt);
    else if (state.issue && !controller.hasUnresolvedCommand()) {
      submitted.current = null;
      setPending(false);
    }
  }, [controller, state.operation, state.result, state.issue]);
  function open(request: BookOrganizationRequest) {
    const live = controller.snapshot();
    if (current.current && sameOrganizationRequest(current.current.request, request)) {
      // Reopening an unsent placement after saving the same editor adopts that deliberate saved selection.
      // A command in flight continues to own its frozen exact version in the controller.
      if (request.kind === 'add' && !submitted.current)
        replace({
          ...current.current,
          document: live.selected ? { exact: live.selected.source.revision.exact, title: live.selected.title } : null,
        });
      return;
    }
    const index = outlineFor(live);
    if (!index || !live.structure || submitted.current) return;
    const row = request.kind === 'add' ? null : index.byId.get(request.occurrenceId);
    if (request.kind !== 'add' && !row) return;
    const parents = request.kind === 'move' ? bookMoveDestinations(request.occurrenceId, index) : [];
    const parent =
      request.kind === 'move'
        ? parents.includes(row!.placement.parentOccurrenceId)
          ? row!.placement.parentOccurrenceId
          : (parents[0] ?? null)
        : null;
    const positions = request.kind === 'move' ? bookMovePositions(request.occurrenceId, parent, index) : [];
    replace({
      request,
      catalogueId: live.structure.catalogueId,
      title: row?.placement.title ?? '',
      kind: 'chapter',
      parent,
      before: positions.includes(null) ? null : (positions[0] ?? null),
      document: live.selected ? { exact: live.selected.source.revision.exact, title: live.selected.title } : null,
      dirty: false,
    });
  }
  function edit(patch: Partial<Pick<OrganizationDraft, 'title' | 'kind' | 'parent' | 'before'>>) {
    if (current.current) replace({ ...current.current, ...patch, dirty: true });
  }
  function discard() {
    if (!submitted.current) replace(null);
  }
  async function submit() {
    const attempt = current.current;
    const live = controller.snapshot();
    if (
      !attempt ||
      submitted.current ||
      live.operation ||
      controller.hasUnresolvedCommand() ||
      !controller.canOrganize()
    )
      return;
    // Re-resolve retained operands against the native owner's current structure, never the rendered options.
    const change = organizationChange(attempt, live, outlineFor(live));
    if (!change) return;
    submitted.current = attempt;
    setPending(true);
    if (await controller.organize(change)) acknowledge(attempt);
    else if (!controller.hasUnresolvedCommand()) {
      submitted.current = null;
      setPending(false);
    }
  }
  return {
    draft,
    outline,
    pending,
    open,
    edit,
    discard,
    submit,
    dirty: Boolean(draft?.dirty),
    canSubmit: Boolean(draft && organizationChange(draft, state, outline)),
  };
}
export type BookOrganization = ReturnType<typeof useBookOrganization>;

function organizationChange(
  draft: OrganizationDraft,
  state: StudioState,
  outline: BookTocIndex | null,
): BookStructureChange | null {
  const structure = state.structure;
  if (!outline || !structure || structure.catalogueId !== draft.catalogueId) return null;
  const { request } = draft;
  if (request.kind === 'move') return moveBookOccurrenceTo(request.occurrenceId, draft.parent, draft.before, outline);
  if (request.kind !== 'add') {
    const row = outline.byId.get(request.occurrenceId);
    if (!row) return null;
    if (request.kind === 'remove') return { kind: 'remove', occurrenceId: request.occurrenceId };
    return draft.title.trim() && draft.title.trim() !== row.placement.title
      ? { kind: 'rename', occurrenceId: request.occurrenceId, title: draft.title.trim() }
      : null;
  }
  const parent = draft.parent === null ? null : outline.byId.get(draft.parent);
  if (
    !draft.title.trim() ||
    outline.rows.length >= structure.limits.maxPlacements ||
    (draft.parent !== null &&
      (!parent || parent.placement.target.kind !== 'part' || parent.depth + 1 >= structure.limits.maxDepth))
  )
    return null;
  const selected = state.selected;
  if (
    draft.kind === 'chapter' &&
    (!draft.document ||
      !selected ||
      selected.dirty ||
      selected.snapshotPending ||
      selected.invalid ||
      selected.uploading ||
      !sameExact(draft.document.exact, selected.source.revision.exact))
  )
    return null;
  return {
    kind: 'insert',
    parentOccurrenceId: draft.parent,
    beforeOccurrenceId: null,
    title: draft.title.trim(),
    target: draft.kind === 'part' ? { kind: 'part' } : { kind: 'chapter', document: draft.document!.exact },
  };
}
function rowLabel(row: BookTocRow, outline: BookTocIndex) {
  const position = [...row.ancestors.map((id) => outline.byId.get(id)!.index + 1), row.index + 1].join('.');
  return m.studio_book_outline_position({ position, title: row.placement.title }, { locale: getLocale() });
}

/** One central canvas owns all Book organization fields; hidden forms cannot receive commands or keyboard focus. */
export function BookOrganizationCanvas({
  organization,
  active,
  disabled,
  onCancel,
}: {
  organization: BookOrganization;
  active: boolean;
  disabled: boolean;
  onCancel: () => void;
}) {
  const id = useId();
  const [kindOpen, setKindOpen] = useState(false);
  const locale = getLocale();
  useEffect(() => {
    if (!active) setKindOpen(false);
  }, [active]);
  const { draft, outline, edit } = organization;
  if (!draft) return null;
  const { request } = draft;
  const row = request.kind === 'add' ? null : outline?.byId.get(request.occurrenceId);
  const unavailable = !outline || (request.kind !== 'add' && !row);
  const fieldsDisabled = !active || unavailable || (disabled && !organization.pending);
  const destinations = request.kind === 'move' && outline ? bookMoveDestinations(request.occurrenceId, outline) : [];
  const positions =
    request.kind === 'move' && outline ? bookMovePositions(request.occurrenceId, draft.parent, outline) : [];
  const parents = [
    { value: null, label: m.studio_book_move_root({}, { locale }) },
    ...(outline?.rows
      .filter((entry) => entry.placement.target.kind === 'part' && entry.depth + 1 < outline.maxDepth)
      .map((entry) => ({
        value: entry.placement.occurrenceId,
        label: m.studio_book_indented_title(
          { indent: '— '.repeat(entry.depth), title: entry.placement.title },
          { locale },
        ),
      })) ?? []),
  ];
  const moveParents = destinations.map((value) => ({
    value,
    label: value === null ? m.studio_book_move_root({}, { locale }) : rowLabel(outline!.byId.get(value)!, outline!),
  }));
  const anchors = positions.map((value) => ({
    value,
    label: value === null ? m.studio_book_move_end({}, { locale }) : rowLabel(outline!.byId.get(value)!, outline!),
  }));
  const heading =
    request.kind === 'add'
      ? m.studio_book_add_heading({}, { locale })
      : request.kind === 'move'
        ? m.studio_book_move_to({}, { locale })
        : request.kind === 'rename'
          ? m.studio_book_rename({}, { locale })
          : m.studio_book_remove_title({ title: row?.placement.title ?? draft.title }, { locale });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (active && !disabled) await organization.submit();
  }
  return (
    <form
      className={`studio-stack studio-organization-form ${request.kind === 'add' ? 'studio-placement-form' : request.kind === 'move' ? 'studio-move-form' : ''}`}
      aria-label={heading}
      onSubmit={(event) => void submit(event)}
    >
      <h3>{heading}</h3>
      {row ? <p className="studio-help">{rowLabel(row, outline!)}</p> : null}
      {row?.placement.target.kind === 'chapter' ? (
        <p className="studio-help studio-break">
          {m.studio_book_pinned_version({ revision: row.placement.target.document.revisionId }, { locale })}
        </p>
      ) : null}
      {unavailable ? <p role="alert">{m.studio_book_outline_unavailable({}, { locale })}</p> : null}
      {request.kind === 'add' ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-kind`}>{m.studio_book_add_kind({}, { locale })}</FieldLabel>
            <Select<'part' | 'chapter'>
              open={kindOpen && !fieldsDisabled}
              onOpenChange={setKindOpen}
              items={[
                { value: 'chapter', label: m.studio_book_saved_chapter({}, { locale }) },
                { value: 'part', label: m.book_reader_part({}, { locale }) },
              ]}
              value={draft.kind}
              disabled={fieldsDisabled}
              onValueChange={(value) => edit({ kind: value ?? 'chapter' })}
            >
              <SelectTrigger
                id={`${id}-kind`}
                aria-describedby={draft.kind === 'chapter' ? `${id}-document` : undefined}
                className="min-h-11 w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="chapter">{m.studio_book_saved_chapter({}, { locale })}</SelectItem>
                  <SelectItem value="part">{m.book_reader_part({}, { locale })}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            {draft.kind === 'chapter' ? (
              <FieldDescription id={`${id}-document`} className="studio-help">
                {draft.document
                  ? m.studio_book_selected_document({ title: draft.document.title }, { locale })
                  : m.studio_book_open_draft({}, { locale })}
              </FieldDescription>
            ) : null}
          </Field>
        </>
      ) : null}
      {request.kind === 'add' || request.kind === 'rename' ? (
        <>
          <label htmlFor={`${id}-title`}>{m.studio_book_placement_title({}, { locale })}</label>
          <Input
            id={`${id}-title`}
            value={draft.title}
            required
            disabled={fieldsDisabled}
            onChange={(event) => edit({ title: event.target.value })}
          />
        </>
      ) : null}
      {request.kind === 'add' || request.kind === 'move' ? (
        <>
          <OrganizationSelect
            id={`${id}-parent`}
            label={
              request.kind === 'add'
                ? m.studio_book_place_inside({}, { locale })
                : m.studio_book_move_destination({}, { locale })
            }
            value={draft.parent}
            items={request.kind === 'add' ? parents : moveParents}
            disabled={fieldsDisabled}
            placeholder={m.studio_book_move_choose_destination({}, { locale })}
            onChange={(parent) => {
              const next =
                request.kind === 'move' && outline ? bookMovePositions(request.occurrenceId, parent, outline) : [];
              edit({ parent, before: next.includes(null) ? null : (next[0] ?? null) });
            }}
          />
          {request.kind === 'move' ? (
            <OrganizationSelect
              id={`${id}-before`}
              label={m.studio_book_move_before({}, { locale })}
              value={draft.before}
              items={anchors}
              disabled={fieldsDisabled || !positions.length}
              placeholder={m.studio_book_move_choose_position({}, { locale })}
              onChange={(before) => edit({ before })}
            />
          ) : null}
          {request.kind === 'move' && !destinations.length ? (
            <p className="studio-help">{m.studio_book_move_unavailable({}, { locale })}</p>
          ) : null}
        </>
      ) : null}
      {request.kind === 'remove' ? (
        <div role="group" aria-label={heading}>
          <p>
            {row && outline!.maxDescendantDepth.get(row.placement.occurrenceId)! > row.depth
              ? m.studio_book_remove_nested_confirmation({}, { locale })
              : m.studio_book_remove_confirmation({}, { locale })}
          </p>
        </div>
      ) : null}
      <div className="studio-action-row">
        <Button
          type="submit"
          variant={request.kind === 'remove' ? 'destructive' : 'default'}
          disabled={!active || disabled || organization.pending || !organization.canSubmit}
        >
          {request.kind === 'add'
            ? draft.kind === 'part'
              ? m.studio_book_add_part({}, { locale })
              : m.studio_book_add_chapter({}, { locale })
            : request.kind === 'move'
              ? m.studio_book_move_action({}, { locale })
              : request.kind === 'rename'
                ? m.studio_book_rename({}, { locale })
                : m.studio_book_remove_action({}, { locale })}
        </Button>
        <Button type="button" variant="outline" disabled={organization.pending} onClick={onCancel}>
          {request.kind === 'remove' ? m.studio_book_keep_action({}, { locale }) : m.action_cancel({}, { locale })}
        </Button>
      </div>
    </form>
  );
}
function OrganizationSelect({
  id,
  label,
  value,
  items,
  disabled,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string | null;
  items: { value: string | null; label: string }[];
  disabled: boolean;
  placeholder: string;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select<string>
        open={open && !disabled}
        onOpenChange={setOpen}
        items={items}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
      >
        <SelectTrigger id={id} className="min-h-11 w-full">
          <SelectValue>{items.find((item) => item.value === value)?.label ?? placeholder}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value ?? ''} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}
