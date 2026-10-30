import { ListRow, ListRowControl } from '@rezics/ui/list-row';
import { Menu } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { Link } from '@tanstack/react-router';
import { ArrowUpIcon, EllipsisIcon, GripVerticalIcon } from 'lucide-react';
import type { DragEvent, ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { pageText } from '../features/pages/shared';
import { libraryTitleValue } from './title';
import { SubjectCover } from './subject-row';
import { collectionMemberRatio } from './collection-presentation';
import type { CollectionMember, LibrarySubject } from './reads';

const dragType = 'application/x-rezics-collection-member';

/** Shared read-only ListRows for dynamic results, which have no curated member ids or notes. */
export function CollectionSubjectList({
  subjects,
  onCopy,
  typeRatios,
}: {
  typeRatios?: Readonly<Record<string, string>> | undefined;
  subjects: readonly (LibrarySubject | null)[];
  onCopy?: (subject: LibrarySubject) => void | Promise<void>;
}) {
  return (
    <ul className="min-w-0 space-y-3" data-collection-members>
      {subjects.map((subject, index) => {
        const localizedTitle = subject ? pageText(libraryTitleValue(subject.label), getLocale()) : null;
        const title = localizedTitle?.text ?? m.library_subject_unavailable();
        const href = subject ? subjectHref({ id: subject.id, label: title }, getLocale()) : null;
        return (
          <ListRow
            key={subject?.id ?? `unavailable-${index}`}
            className="flex min-w-0 items-center gap-3 rounded-xl p-3 sm:gap-4 sm:p-4"
          >
            <div className="w-24 shrink-0 sm:w-40">
              <SubjectCover subject={subject} ratio={collectionMemberRatio(subject, typeRatios)} size="fill" />
            </div>
            <div className="min-w-24 flex-1 space-y-1">
              <div className="line-clamp-2 font-medium leading-snug">
                {href ? (
                  <Link to={href.to} params={href.params} className="text-primary underline-offset-4 hover:underline">
                    {title}
                  </Link>
                ) : (
                  title
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {m.library_column_type()}: {subject?.typeLabel ?? m.library_other()}
              </p>
            </div>
            {subject && onCopy ? (
              <ListRowControl>
                <Menu
                  title={m.library_collection_actions()}
                  trigger={
                    <Button type="button" aria-label={m.library_collection_actions()} size="icon-sm" variant="ghost">
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
  onNoteChange,
  onRemove,
  onCopy,
  typeRatios,
}: {
  typeRatios?: Readonly<Record<string, string>> | undefined;
  members: readonly CollectionMember[];
  editing: boolean;
  firstPage: boolean;
  busy?: boolean;
  selectedIds?: ReadonlySet<string>;
  onSelectionChange?: (memberId: string, selected: boolean) => void;
  onMove?: (memberId: string, after: string | null) => void;
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
        const rowRatio = collectionMemberRatio(member.subject, typeRatios);
        const moveUpAfter = index === 1 && firstPage ? null : index >= 2 ? members[index - 2]!.id : undefined;
        const nextAfter = index < members.length - 1 ? members[index + 1]!.id : undefined;
        const beginDrag = (event: DragEvent<HTMLElement>) => {
          event.dataTransfer.setData(dragType, member.id);
          event.dataTransfer.effectAllowed = 'move';
        };
        return (
          <ListRow
            key={member.id}
            className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl p-2 sm:flex-nowrap sm:gap-4 sm:p-4"
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
            {editing ? (
              <ListRowControl className="shrink-0">
                <Checkbox
                  checked={selectedIds.has(member.id)}
                  disabled={busy || !onSelectionChange}
                  aria-label={m.library_collection_select_member({ title })}
                  onCheckedChange={(checked) => onSelectionChange?.(member.id, checked === true)}
                />
              </ListRowControl>
            ) : null}
            <div className="w-24 shrink-0 sm:w-40">
              <SubjectCover subject={member.subject} ratio={rowRatio} size="fill" />
            </div>
            <div className="min-w-24 flex-1 space-y-1">
              <div className="line-clamp-2 font-medium leading-snug">
                {href ? (
                  <Link to={href.to} params={href.params} className="text-primary underline-offset-4 hover:underline">
                    {title}
                  </Link>
                ) : (
                  <span>{title}</span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {m.library_column_type()}: {member.subject?.typeLabel ?? m.library_other()}
              </p>
              {editing && member.subject ? (
                <Textarea
                  aria-label={`${m.library_member_note()}: ${title}`}
                  className="min-h-16"
                  disabled={busy}
                  maxLength={20_000}
                  value={member.note ?? ''}
                  onChange={(event) => onNoteChange?.(member.id, event.target.value)}
                />
              ) : member.subject && member.note ? (
                <p data-slot="collection-member-note" className="line-clamp-2 text-sm text-muted-foreground">
                  {member.note}
                </p>
              ) : null}
            </div>
            <ListRowControl className="flex shrink-0 flex-col items-end gap-1">
              {onCopy && member.subject ? (
                <Menu
                  title={m.library_collection_actions()}
                  trigger={
                    <Button type="button" aria-label={m.library_collection_actions()} size="icon-sm" variant="ghost">
                      <EllipsisIcon aria-hidden="true" />
                    </Button>
                  }
                  entries={[{ type: 'item', label: m.library_collection_copy(), onSelect: () => onCopy(member.id) }]}
                />
              ) : null}
              {editing ? (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-flex size-8 cursor-grab items-center justify-center text-muted-foreground"
                    data-drag-handle
                    draggable={!busy}
                    onDragStart={beginDrag}
                  >
                    <GripVerticalIcon />
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={m.library_member_move_up()}
                    disabled={busy || moveUpAfter === undefined}
                    onClick={() => moveUpAfter !== undefined && onMove?.(member.id, moveUpAfter)}
                  >
                    <ArrowUpIcon aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={m.library_member_move_down()}
                    disabled={busy || nextAfter === undefined || (!firstPage && index === 0)}
                    onClick={() => nextAfter !== undefined && onMove?.(member.id, nextAfter)}
                  >
                    {m.library_member_move_down()}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={m.library_member_remove()}
                    disabled={busy}
                    onClick={() => onRemove?.(member.id)}
                  >
                    {m.library_member_remove()}
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
