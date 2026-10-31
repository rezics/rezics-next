import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { Menu } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { ArrowDownIcon, ArrowUpIcon, EllipsisIcon, GripVerticalIcon, Trash2Icon } from 'lucide-react';
import type { DragEvent, ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { pageText } from '../features/pages/shared';
import { libraryTitleValue } from './title';
import { CollectionMemberDetails } from './collection-member-row';
import { SubjectCover } from './subject-row';
import { collectionMemberRatio } from './collection-presentation';
import type { CollectionListPresentations, CollectionTypeOption } from './collection-presentation';
import type { CollectionMember, LibrarySubject } from './reads';

const dragType = 'application/x-rezics-collection-member';

/** Shared read-only ListRows for dynamic results, which have no curated member ids or notes. */
export function CollectionSubjectList({
  subjects,
  onCopy,
  typeRatios,
  listPresentations,
}: {
  typeRatios?: Readonly<Record<string, string>> | undefined;
  listPresentations?: CollectionListPresentations | undefined;
  subjects: readonly (LibrarySubject | null)[];
  onCopy?: (subject: LibrarySubject) => void | Promise<void>;
}) {
  return (
    <ul className="min-w-0 space-y-3" data-collection-members>
      {subjects.map((subject, index) => {
        const localizedTitle = subject ? pageText(libraryTitleValue(subject.label), getLocale()) : null;
        const title = localizedTitle?.text ?? m.library_subject_unavailable();
        const href = subject ? subjectHref({ id: subject.id, label: title }, getLocale()) : null;
        const actionsLabel = `${m.library_collection_actions()}: ${m.library_member_occurrence({ title, position: index + 1 })}`;
        return (
          <ListRow key={subject?.id ?? `unavailable-${index}`} className="flex min-w-0 items-start gap-4 py-2">
            {href ? <ListRowLink href={href.href}>{title}</ListRowLink> : null}
            <div className="w-[72px] shrink-0 sm:w-24">
              <SubjectCover
                subject={subject}
                ratio={collectionMemberRatio(subject, typeRatios, listPresentations)}
                size="fill"
              />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="line-clamp-2 font-medium leading-snug">
                <span aria-hidden={href ? true : undefined}>{title}</span>
              </div>
              <CollectionMemberDetails member={{ subject }} listPresentations={listPresentations} />
            </div>
            {subject && onCopy ? (
              <ListRowControl>
                <Menu
                  title={actionsLabel}
                  trigger={
                    <Button
                      type="button"
                      aria-label={actionsLabel}
                      title={actionsLabel}
                      size="icon-lg"
                      className="size-11 sm:size-9"
                      variant="ghost"
                    >
                      <EllipsisIcon aria-hidden="true" />
                    </Button>
                  }
                  entries={[{ type: 'item', label: m.library_collection_copy(), onSelect: () => onCopy(subject) }]}
                />
              </ListRowControl>
            ) : null}
          </ListRow>
        );
      })}
    </ul>
  );
}

export type CollectionMemberEditOperation =
  | { kind: 'move'; memberId: string; after: string | null }
  | { kind: 'note'; memberId: string; note: string | null }
  | { kind: 'remove'; memberId: string };

/** Bounded per-member writes derived from the loaded page only; the native API still owns each CAS and receipt. */
export function buildCollectionMemberEditPlan(
  initial: readonly CollectionMember[],
  desired: readonly CollectionMember[],
  firstPage: boolean,
): CollectionMemberEditOperation[] {
  if (initial.length > 100 || desired.length > 100) throw new RangeError('Collection edit selection exceeds one page');
  const initialIds = new Set(initial.map((member) => member.id));
  const desiredIds = new Set(desired.map((member) => member.id));
  if (
    initialIds.size !== initial.length ||
    desiredIds.size !== desired.length ||
    desired.some((member) => !initialIds.has(member.id))
  )
    throw new RangeError('Collection edits must name distinct loaded occurrences');
  if (!firstPage && desired.length && desired[0]?.id !== initial.find((member) => desiredIds.has(member.id))?.id)
    throw new RangeError('A later page cannot move a member before its loaded boundary');
  const operations: CollectionMemberEditOperation[] = [];
  for (const member of initial)
    if (!desiredIds.has(member.id)) operations.push({ kind: 'remove', memberId: member.id });
  const initialById = new Map(initial.map((member) => [member.id, member]));
  for (const member of desired) {
    const original = initialById.get(member.id);
    if (original && original.note !== member.note)
      operations.push({ kind: 'note', memberId: member.id, note: member.note });
  }
  const working = initial.filter((member) => desiredIds.has(member.id));
  const target = desired.filter((member) => initialById.has(member.id));
  for (let index = 0; index < target.length; index++) {
    if (working[index]?.id === target[index]!.id) continue;
    if (index === 0 && !firstPage) continue;
    const member = target[index]!;
    const after = index === 0 ? null : target[index - 1]!.id;
    operations.push({ kind: 'move', memberId: member.id, after });
    const from = working.findIndex((item) => item.id === member.id);
    if (from < 0) continue;
    working.splice(from, 1);
    working.splice(index, 0, member);
  }
  return operations;
}

/** Applies independently receipted native writes in order and stops at the first refusal. */
export async function applyCollectionMemberEditPlan(
  operations: readonly CollectionMemberEditOperation[],
  write: (operation: CollectionMemberEditOperation) => Promise<{ ok: true } | { ok: false; reason: string }>,
): Promise<{ completed: number; failed?: { operation: CollectionMemberEditOperation; reason: string } }> {
  if (operations.length > 300) throw new RangeError('Collection edit plan exceeds its per-page bound');
  let completed = 0;
  for (const operation of operations) {
    const result = await write(operation).catch(() => ({ ok: false as const, reason: 'unavailable' }));
    if (!result.ok) return { completed, failed: { operation, reason: result.reason } };
    completed += 1;
  }
  return { completed };
}

export function CollectionMemberList({
  members,
  editing,
  firstPage,
  busy = false,
  selectedIds = new Set(),
  onSelectionChange,
  onMove,
  onBoundaryMove,
  boundaryBlocked = false,
  onNoteChange,
  onRemove,
  onCopy,
  typeRatios,
  listPresentations,
}: {
  typeRatios?: Readonly<Record<string, string>> | undefined;
  listPresentations?: CollectionListPresentations | undefined;
  members: readonly CollectionMember[];
  editing: boolean;
  firstPage: boolean;
  busy?: boolean;
  selectedIds?: ReadonlySet<string>;
  onSelectionChange?: (memberId: string, selected: boolean) => void;
  onMove?: (memberId: string, after: string | null) => void;
  onBoundaryMove?: ((memberId: string, placement: 'start' | 'end') => void) | undefined;
  boundaryBlocked?: boolean;
  onNoteChange?: (memberId: string, note: string) => void;
  onRemove?: (memberId: string) => void;
  onCopy?: (memberId: string) => void | Promise<void>;
  children?: ReactNode;
}) {
  return (
    <ul className="min-w-0 space-y-3" data-collection-members aria-busy={busy}>
      {members.map((member, index) => {
        const localizedTitle = member.subject ? pageText(libraryTitleValue(member.subject.label), getLocale()) : null;
        const title = localizedTitle?.text ?? m.library_subject_unavailable();
        const href = member.subject ? subjectHref({ id: member.subject.id, label: title }, getLocale()) : null;
        const actionContext = m.library_member_occurrence({ title, position: index + 1 });
        const actionLabel = (action: string) => `${action}: ${actionContext}`;
        const noteId = `collection-member-note-${member.id}`;
        const rowRatio = collectionMemberRatio(member.subject, typeRatios, listPresentations);
        const landscape = rowRatio === '16:9' || rowRatio === '4:3';
        const columns = editing
          ? landscape
            ? 'grid-cols-[auto_128px_minmax(0,1fr)] sm:grid-cols-[auto_192px_minmax(0,1fr)]'
            : 'grid-cols-[auto_72px_minmax(0,1fr)] sm:grid-cols-[auto_96px_minmax(0,1fr)]'
          : landscape
            ? 'grid-cols-[128px_minmax(0,1fr)] sm:grid-cols-[192px_minmax(0,1fr)]'
            : 'grid-cols-[72px_minmax(0,1fr)] sm:grid-cols-[96px_minmax(0,1fr)]';
        const moveUpAfter = index === 1 && firstPage ? null : index >= 2 ? members[index - 2]!.id : undefined;
        const nextAfter = index < members.length - 1 ? members[index + 1]!.id : undefined;
        const beginDrag = (event: DragEvent<HTMLElement>) => {
          event.dataTransfer.setData(dragType, member.id);
          event.dataTransfer.effectAllowed = 'move';
        };
        return (
          <ListRow
            key={member.id}
            className={`grid min-w-0 items-start gap-x-3 gap-y-2 py-2 ${columns}`}
            data-member={member.id}
            onDragOver={editing && !busy ? (event) => event.preventDefault() : undefined}
            onDrop={
              editing && !busy && onMove
                ? (event) => {
                    event.preventDefault();
                    const movedId = event.dataTransfer.getData(dragType);
                    const from = members.findIndex((item) => item.id === movedId);
                    if (!movedId || from < 0 || movedId === member.id) return;
                    const targetIndex = members.findIndex((item) => item.id === member.id);
                    const placeAfter =
                      from < targetIndex
                        ? member.id
                        : targetIndex === 0
                          ? firstPage
                            ? null
                            : undefined
                          : members[targetIndex - 1]!.id;
                    if (placeAfter !== undefined) onMove(movedId, placeAfter);
                  }
                : undefined
            }
          >
            {href ? <ListRowLink href={href.href}>{title}</ListRowLink> : null}
            {editing ? (
              <ListRowControl className="flex flex-col items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-flex size-8 cursor-grab items-center justify-center text-muted-foreground"
                  data-drag-handle
                  draggable={!busy}
                  onDragStart={beginDrag}
                >
                  <GripVerticalIcon />
                </span>
                <Checkbox
                  checked={selectedIds.has(member.id)}
                  disabled={busy || !onSelectionChange}
                  aria-label={m.library_collection_select_member({ title: actionContext })}
                  onCheckedChange={(checked) => onSelectionChange?.(member.id, checked === true)}
                />
              </ListRowControl>
            ) : null}
            <div className="min-w-0 [&_button]:relative [&_button]:z-10">
              <SubjectCover subject={member.subject} ratio={rowRatio} size="fill" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="line-clamp-2 font-medium leading-snug">
                <span aria-hidden={href ? true : undefined}>{title}</span>
              </div>
              <CollectionMemberDetails member={member} listPresentations={listPresentations} />
            </div>
            {editing && member.subject ? (
              <ListRowControl className="col-span-2 col-start-2">
                <details className="min-w-0" data-collection-note-editor>
                  <summary
                    className="min-h-11 cursor-pointer py-2 text-sm text-primary"
                    aria-label={actionLabel(m.library_member_note())}
                  >
                    {m.library_member_note()}
                  </summary>
                  <Field className="min-w-0 gap-1">
                    <FieldLabel htmlFor={noteId}>{m.library_member_note()}</FieldLabel>
                    <Textarea
                      id={noteId}
                      aria-label={`${m.library_member_note()}: ${title}`}
                      className="min-h-16"
                      disabled={busy}
                      maxLength={20_000}
                      value={member.note ?? ''}
                      onChange={(event) => onNoteChange?.(member.id, event.target.value)}
                    />
                  </Field>
                </details>
                {member.note ? (
                  <p className="line-clamp-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">{member.note}</p>
                ) : null}
              </ListRowControl>
            ) : member.subject && member.note ? (
              <p data-slot="collection-member-note" className="col-start-2 line-clamp-2 text-sm text-muted-foreground">
                {member.note}
              </p>
            ) : null}
            <ListRowControl className={`col-start-2 flex flex-wrap items-center gap-2 ${editing ? 'col-span-2' : ''}`}>
              {member.subject && (onCopy || (editing && onBoundaryMove)) ? (
                <Menu
                  title={actionLabel(m.library_collection_actions())}
                  trigger={
                    <Button
                      type="button"
                      aria-label={actionLabel(m.library_collection_actions())}
                      aria-description={editing && onBoundaryMove ? m.library_collection_boundary_help() : undefined}
                      title={actionLabel(m.library_collection_actions())}
                      size="icon-lg"
                      className="size-11 sm:size-9"
                      variant="ghost"
                    >
                      <EllipsisIcon aria-hidden="true" />
                    </Button>
                  }
                  entries={[
                    ...(onCopy
                      ? [
                          {
                            type: 'item' as const,
                            label: m.library_collection_copy(),
                            onSelect: () => onCopy(member.id),
                          },
                        ]
                      : []),
                    ...(editing && onBoundaryMove
                      ? [
                          {
                            type: 'item' as const,
                            label: m.library_collection_boundary_start(),
                            disabled: busy || boundaryBlocked,
                            onSelect: () => onBoundaryMove(member.id, 'start'),
                          },
                          {
                            type: 'item' as const,
                            label: m.library_collection_boundary_end(),
                            disabled: busy || boundaryBlocked,
                            onSelect: () => onBoundaryMove(member.id, 'end'),
                          },
                        ]
                      : []),
                  ]}
                />
              ) : null}
              {editing ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-lg"
                    className="size-11 sm:size-9"
                    aria-label={actionLabel(m.library_member_move_up())}
                    title={actionLabel(m.library_member_move_up())}
                    disabled={busy || moveUpAfter === undefined}
                    onClick={() => moveUpAfter !== undefined && onMove?.(member.id, moveUpAfter)}
                  >
                    <ArrowUpIcon aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-lg"
                    className="size-11 sm:size-9"
                    aria-label={actionLabel(m.library_member_move_down())}
                    title={actionLabel(m.library_member_move_down())}
                    disabled={busy || nextAfter === undefined || (!firstPage && index === 0)}
                    onClick={() => nextAfter !== undefined && onMove?.(member.id, nextAfter)}
                  >
                    <ArrowDownIcon aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-lg"
                    className="ms-2 size-11 sm:size-9"
                    aria-label={actionLabel(m.library_member_remove())}
                    title={actionLabel(m.library_member_remove())}
                    disabled={busy}
                    onClick={() => onRemove?.(member.id)}
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </>
              ) : null}
            </ListRowControl>
          </ListRow>
        );
      })}
    </ul>
  );
}

/** Select exact released Types and already imported, authorized member covers from this loaded page. */
export function CollectionPresentationFields({
  types,
  kind,
  onKindChange,
  coverMediaId,
  onCoverChange,
  members = [],
  disabled = false,
}: {
  types: readonly CollectionTypeOption[] | null | undefined;
  kind: string | null;
  onKindChange: (kind: string | null) => void;
  coverMediaId: string | null;
  onCoverChange?: (id: string | null) => void;
  members?: readonly CollectionMember[];
  disabled?: boolean;
}) {
  const covers = new Map(
    members.flatMap(({ subject }) => {
      const cover = subject?.cover;
      return subject &&
        cover &&
        !cover.withheld &&
        cover.variants.some((v) => v.format === 'avif' || v.format === 'webp')
        ? [[cover.media, pageText(libraryTitleValue(subject.label), getLocale()).text] as const]
        : [];
    }),
  );
  return (
    <div className="grid max-w-3xl gap-4 sm:grid-cols-2" data-collection-presentation-fields>
      <label className="space-y-1">
        <span>{m.library_collection_kind()}</span>
        <select
          className="block min-h-10 w-full rounded-lg border border-border bg-background px-3"
          value={kind ?? ''}
          disabled={disabled}
          onChange={(event) => onKindChange(event.target.value || null)}
        >
          <option value="">{m.library_collection_auto()}</option>
          {kind && !types?.some((type) => type.id === kind) ? <option value={kind}>{kind}</option> : null}
          {types?.map((type) => (
            <option key={type.id} value={type.id}>
              {type.label}
            </option>
          ))}
        </select>
        {types == null ? (
          <span role="status" className="block text-sm text-muted-foreground">
            {m.library_collection_types_unavailable()}
          </span>
        ) : null}
      </label>
      {onCoverChange ? (
        <label className="space-y-1">
          <span>{m.subject_cover()}</span>
          <select
            className="block min-h-10 w-full rounded-lg border border-border bg-background px-3"
            value={coverMediaId ?? ''}
            disabled={disabled}
            onChange={(event) => onCoverChange(event.target.value || null)}
          >
            <option value="">{m.library_collection_auto()}</option>
            {coverMediaId && !covers.has(coverMediaId) ? (
              <option value={coverMediaId}>{m.library_collection_current_cover()}</option>
            ) : null}
            {[...covers].map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <span className="block text-sm text-muted-foreground">{m.library_collection_cover_existing()}</span>
        </label>
      ) : null}
    </div>
  );
}
