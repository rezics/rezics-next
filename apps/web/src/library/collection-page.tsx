import { Exposure, useOperation } from '../kernel/exposure';
import type { CoverRatio } from '@rezics/ui/cover';
import { ContentActions } from '@rezics/ui/content-actions';
import { CoverCard, CoverGrid } from '@rezics/ui/cover-card';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { sharedRatio } from '@rezics/ui/cover';
import { RelativeTime } from '@rezics/ui/relative-time';
import { Link, useRouter } from '@tanstack/react-router';
import { EllipsisIcon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import { AccountRef } from './account-ref';
import { coverSrc } from '../media/cover-src';
import { subjectHref } from '../subject/subject-href';
import {
  deleteCollection,
  moveCollectionMember,
  removeCollectionMember,
  setCollectionFollow,
  updateCollection,
  updateMemberNote,
  type CollectionWriteResult,
} from './collection-edit';
import type { EditableCollectionPage } from './collection-load';
import type { CollectionMember, CollectionVisibility } from './reads';
import { rowRatio, SubjectIdentity } from './subject-row';

/** The kernel holds at most this many members in one collection. */
const COLLECTION_LIMIT = 5000;

const visibilities = ['private', 'unlisted', 'public'] as const;

function visibilityLabel(visibility: CollectionVisibility): string {
  if (visibility === 'public') return m.library_visibility_public();
  if (visibility === 'unlisted') return m.library_visibility_unlisted();
  return m.library_visibility_private();
}

function visibilityNote(visibility: CollectionVisibility): string {
  if (visibility === 'public') return m.library_visibility_public_note();
  if (visibility === 'unlisted') return m.library_visibility_unlisted_note();
  return m.library_visibility_private_note();
}

export const fieldClass =
  'mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary';
export const buttonClass =
  'inline-flex min-h-10 items-center rounded-lg border border-border px-3 text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60';

function collectionHref(id: string): string {
  return `/${getLocale()}/collections/${encodeURIComponent(id)}`;
}

function failureText(result: Extract<CollectionWriteResult, { ok: false }>): string {
  return result.reason === 'full' ? m.library_collection_full() : m.error_message();
}

/** The radio group both the editor and the create page use: each visibility with one plain sentence. */
export function VisibilityField({
  value,
  onChange,
  disabled = false,
}: {
  value: CollectionVisibility | '';
  onChange: (value: CollectionVisibility) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend>{m.library_collection_visibility()}</legend>
      {visibilities.map((option) => (
        <label className="flex items-start gap-2" key={option}>
          <input
            checked={value === option}
            className="mt-1"
            name="visibility"
            onChange={() => onChange(option)}
            type="radio"
            value={option}
          />
          <span>
            <strong className="font-medium">{visibilityLabel(option)}</strong> {visibilityNote(option)}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Where a member lands when moved one place up, one place down or to the top, as the `after` member id. */
function placementAfter(
  kind: 'up' | 'down' | 'top',
  index: number,
  members: CollectionMember[],
  firstPage: boolean,
): string | null | undefined {
  if (kind === 'top') return index === 0 && firstPage ? undefined : null;
  if (kind === 'up') {
    if (index === 1 && firstPage) return null;
    return index >= 2 ? members[index - 2]!.id : undefined;
  }
  return index < members.length - 1 ? members[index + 1]!.id : undefined;
}

function moveWithin(members: CollectionMember[], memberId: string, after: string | null): CollectionMember[] {
  const moved = members.find((member) => member.id === memberId);
  if (!moved) return members;
  const rest = members.filter((member) => member.id !== memberId);
  const at = after === null ? 0 : rest.findIndex((member) => member.id === after) + 1;
  if (after !== null && at === 0) return members;
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

export function CollectionPage({ page }: { page: EditableCollectionPage }) {
  const router = useRouter();
  const admitted = useOperation('collection.update');
  const owner = page.visibility !== null && admitted;
  const [hydrated, setHydrated] = useState(false);
  const [members, setMembers] = useState(page.members);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(page.title);
  const [description, setDescription] = useState(page.description ?? '');
  const [visibility, setVisibility] = useState<CollectionVisibility>(page.visibility ?? 'public');
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState('');
  const [following, setFollowing] = useState(page.following);
  const [pending, setPending] = useState(false);
  const membersRef = useRef(members);
  membersRef.current = members;
  const snapshot = [
    page.id,
    page.revision,
    page.title,
    page.description ?? '',
    page.following,
    page.members.map((member) => `${member.id}:${member.note ?? ''}`).join('\n'),
  ].join('\n');

  useEffect(() => setHydrated(true), []);

  // A new read of the collection replaces whatever the person was looking at, including an open editor.
  useEffect(() => {
    setMembers(page.members);
    setEditing(false);
    setConflict(false);
    setFailure('');
    setTitle(page.title);
    setDescription(page.description ?? '');
    setFollowing(page.following);
    if (page.visibility) setVisibility(page.visibility);
  }, [snapshot]);

  /** One write at a time, so the next control always starts from the state the last one left. */
  async function write(run: () => Promise<CollectionWriteResult>): Promise<CollectionWriteResult> {
    setPending(true);
    setFailure('');
    try {
      return await run();
    } catch {
      return { ok: false, reason: 'unavailable' };
    } finally {
      setPending(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || pending) return;
    const result = await write(() =>
      updateCollection({
        data: {
          collectionId: page.id,
          revision: page.revision,
          title,
          description,
          visibility,
          idempotencyKey: crypto.randomUUID(),
        },
        headers: csrfHeaders(),
      }),
    );
    if (result.ok) {
      await router.invalidate();
      return;
    }
    if (result.reason === 'conflict') setConflict(true);
    else setFailure(failureText(result));
  }

  async function removeCollection() {
    const result = await deleteCollection({
      data: { collectionId: page.id, revision: page.revision, idempotencyKey: crypto.randomUUID() },
      headers: csrfHeaders(),
    });
    if (!result.ok) throw new Error(m.error_message());
    window.location.assign(`/${getLocale()}/library/collections`);
  }

  async function moveMember(memberId: string, after: string | null) {
    if (!hydrated || pending) return;
    const before = membersRef.current;
    setMembers(moveWithin(before, memberId, after));
    const result = await write(() =>
      moveCollectionMember({
        data: { collectionId: page.id, memberId, after, idempotencyKey: crypto.randomUUID() },
        headers: csrfHeaders(),
      }),
    );
    if (!result.ok) {
      setMembers(before);
      setFailure(failureText(result));
    }
  }

  async function saveNote(memberId: string, note: string) {
    if (!hydrated || pending) return;
    const result = await write(() =>
      updateMemberNote({
        data: {
          collectionId: page.id,
          memberId,
          note: note.length > 0 ? note : null,
          idempotencyKey: crypto.randomUUID(),
        },
        headers: csrfHeaders(),
      }),
    );
    if (result.ok) {
      setMembers((current) =>
        current.map((member) => (member.id === memberId ? { ...member, note: note.length > 0 ? note : null } : member)),
      );
    } else setFailure(failureText(result));
  }

  async function removeMember(memberId: string) {
    if (!hydrated || pending) return;
    const result = await write(() =>
      removeCollectionMember({
        data: { collectionId: page.id, memberId, idempotencyKey: crypto.randomUUID() },
        headers: csrfHeaders(),
      }),
    );
    if (result.ok) {
      setMembers((current) => current.filter((member) => member.id !== memberId));
      await router.invalidate();
    } else setFailure(failureText(result));
  }

  async function toggleFollow() {
    if (!hydrated || pending || following === null) return;
    const result = await write(() =>
      setCollectionFollow({
        data: { collectionId: page.id, follow: !following, idempotencyKey: crypto.randomUUID() },
        headers: csrfHeaders(),
      }),
    );
    if (result.ok) setFollowing(!following);
    else setFailure(failureText(result));
  }

  function dropMember(memberId: string, event: PointerEvent<HTMLLIElement>) {
    const current = membersRef.current;
    let targetId = '';
    for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
      const id = element.closest('[data-member]')?.getAttribute('data-member');
      if (id && id !== memberId) {
        targetId = id;
        break;
      }
    }
    const from = current.findIndex((member) => member.id === memberId);
    const to = current.findIndex((member) => member.id === targetId);
    if (from < 0 || to < 0) return;
    // Dropping on a row puts the member where that row was: before it when moving up, after it when moving down.
    if (from < to) return void moveMember(memberId, targetId);
    if (to > 0) return void moveMember(memberId, current[to - 1]!.id);
    if (page.firstPage) void moveMember(memberId, null);
  }

  const atLimit = page.memberCount >= COLLECTION_LIMIT;
  const ratio = rowRatio(members.map((member) => member.subject));
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <PageHeading>{page.title}</PageHeading>
          {owner ? (
            hydrated ? (
              <ContentActions
                ownsContent
                labels={{
                  moreActions: m.library_collection_actions(),
                  copyLink: m.library_collection_copy(),
                  edit: m.library_collection_edit(),
                  delete: m.library_collection_delete(),
                  confirmDelete: m.library_collection_delete_confirm(),
                  deleteTitle: m.library_collection_delete_title(),
                  deleteDescription: m.library_collection_delete_description(),
                  cancel: m.library_collection_cancel(),
                }}
                onCopyLink={() => {
                  void navigator.clipboard.writeText(`${location.origin}${collectionHref(page.id)}`).catch(() => {});
                }}
                onEdit={() => {
                  setFailure('');
                  setEditing(true);
                }}
                onDelete={removeCollection}
              />
            ) : (
              <button
                aria-label={m.library_collection_actions()}
                className="inline-flex size-8 items-center justify-center rounded-lg hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                disabled
                type="button"
              >
                <EllipsisIcon aria-hidden="true" className="size-4" />
              </button>
            )
          ) : null}
        </div>
        {page.description !== null ? <p className="whitespace-pre-wrap">{page.description}</p> : null}
        <p className="flex flex-wrap items-baseline gap-x-1">
          <span>{m.library_curator()}</span>{' '}
          {page.curator ? (
            <>
              <a
                href={`/${getLocale()}/@${encodeURIComponent(page.curator.handle ?? '')}`}
                className="text-primary underline-offset-4 hover:underline"
              >
                {page.curator.displayName ?? page.curator.handle}
              </a>
              {page.curator.handle ? (
                <span className="text-sm text-muted-foreground">@{page.curator.handle}</span>
              ) : null}
            </>
          ) : (
            <AccountRef account={null} />
          )}
        </p>
        <p>{m.library_member_count({ count: page.memberCount })}</p>
        {atLimit ? <p>{m.library_collection_full()}</p> : null}
        <p>
          {m.library_collection_updated()} <RelativeTime value={page.updatedAt} locale={getLocale()} />
        </p>
        {page.visibility ? <p data-visibility={page.visibility}>{visibilityLabel(page.visibility)}</p> : null}
        {following !== null ? (
          <Exposure operation="follow.put">
            <div className="flex flex-wrap items-center gap-3">
              {following ? <p>{m.library_following()}</p> : null}
              <button
                className={buttonClass}
                disabled={!hydrated || pending}
                onClick={() => void toggleFollow()}
                type="button"
              >
                {following ? m.library_follow_unfollow() : m.library_follow()}
              </button>
            </div>
          </Exposure>
        ) : null}
        {owner && editing ? (
          <form className="space-y-4" onSubmit={(event) => void save(event)}>
            <label className="block">
              {m.library_collection_title()}
              <input className={fieldClass} onChange={(event) => setTitle(event.target.value)} required value={title} />
            </label>
            <label className="block">
              {m.library_collection_description()}
              <textarea
                className={fieldClass}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                value={description}
              />
            </label>
            <VisibilityField onChange={setVisibility} value={visibility} />
            {conflict ? (
              <p role="alert">
                {m.library_collection_conflict()}{' '}
                <a
                  className="text-primary underline-offset-4 hover:underline"
                  href={collectionHref(page.id)}
                  onClick={(event) => {
                    event.preventDefault();
                    void router.invalidate();
                  }}
                >
                  {m.library_collection_reload()}
                </a>
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button className={buttonClass} disabled={!hydrated || pending} type="submit">
                {m.library_collection_save()}
              </button>
              <button className={buttonClass} onClick={() => setEditing(false)} type="button">
                {m.library_collection_cancel()}
              </button>
            </div>
          </form>
        ) : null}
        {failure ? <p role="alert">{failure}</p> : null}
      </header>
      <section className="space-y-4" aria-labelledby="collection-members-heading">
        <h2 id="collection-members-heading" className="text-xl font-semibold">
          {m.library_collection_members()}
        </h2>
        {members.length ? (
          <CoverGrid ratio={ratio}>
            {members.map((member, index) => {
              const subject = member.subject;
              const title = subject?.label ?? m.library_subject_unavailable();
              const href = subject ? subjectHref({ id: subject.id, label: title }, getLocale()).href : undefined;
              return (
                <ListRow key={member.id} className="space-y-3 rounded-xl p-2">
                  <ListRowLink href={href ?? '#'}>{title}</ListRowLink>
                  <CoverCard
                    {...(href ? { href } : {})}
                    title={title}
                    cover={{
                      subject: subject
                        ? { id: subject.id, title, types: subject.types }
                        : { id: 'unavailable', title, types: [] },
                      cover: subject?.cover ?? null,
                      src: coverSrc,
                      labels: {
                        withheld: m.thread_cover_withheld(),
                        reveal: m.thread_cover_reveal(),
                        credit: m.thread_cover_credit(),
                        via: m.thread_cover_via(),
                      },
                    }}
                    secondary={subject?.typeLabel}
                    linkLabel={title}
                  />
                  {member.note ? (
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">{member.note}</p>
                  ) : null}
                  {owner ? (
                    <ListRowControl className="space-y-2">
                      <MemberRowControls
                        member={member}
                        index={index}
                        members={members}
                        firstPage={page.firstPage}
                        busy={!hydrated || pending}
                        moveMember={moveMember}
                        saveNote={saveNote}
                        removeMember={removeMember}
                      />
                    </ListRowControl>
                  ) : null}
                </ListRow>
              );
            })}
          </CoverGrid>
        ) : (
          <p className="text-muted-foreground">{m.library_collection_empty()}</p>
        )}
        {page.next ? (
          <Exposure operation="collection_member.list">
            <nav aria-label={m.library_collection_members()}>
              <Link
                to="/collections/$id"
                params={{ id: page.id }}
                search={{ cursor: page.next }}
                className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
              >
                {m.library_collection_more()}
              </Link>
            </nav>
          </Exposure>
        ) : null}
      </section>
    </article>
  );
}

function MemberRowControls({
  member,
  index,
  members,
  firstPage,
  busy,
  moveMember,
  saveNote,
  removeMember,
}: {
  member: CollectionMember;
  index: number;
  members: CollectionMember[];
  firstPage: boolean;
  busy: boolean;
  moveMember: (memberId: string, after: string | null) => Promise<void>;
  saveNote: (memberId: string, note: string) => Promise<void>;
  removeMember: (memberId: string) => Promise<void>;
}) {
  const [note, setNote] = useState(member.note ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const up = placementAfter('up', index, members, firstPage);
  const down = placementAfter('down', index, members, firstPage);
  const top = placementAfter('top', index, members, firstPage);
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {up !== undefined ? (
          <button className={buttonClass} disabled={busy} onClick={() => void moveMember(member.id, up)} type="button">
            {m.library_member_move_up()}
          </button>
        ) : null}
        {down !== undefined ? (
          <button
            className={buttonClass}
            disabled={busy}
            onClick={() => void moveMember(member.id, down)}
            type="button"
          >
            {m.library_member_move_down()}
          </button>
        ) : null}
        {top !== undefined ? (
          <button className={buttonClass} disabled={busy} onClick={() => void moveMember(member.id, top)} type="button">
            {m.library_member_move_to_top()}
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-48 flex-1">
          {m.library_member_note()}
          <textarea
            className={fieldClass}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            value={note}
          />
        </label>
        <button className={buttonClass} disabled={busy} onClick={() => void saveNote(member.id, note)} type="button">
          {m.library_member_note_save()}
        </button>
      </div>
      <label className="flex items-center gap-2">
        <input
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmed(event.target.checked)}
          type="checkbox"
        />
        {m.library_member_remove_confirm()}
      </label>
      <button
        className={buttonClass}
        disabled={busy || !confirmed}
        onClick={() => void removeMember(member.id)}
        type="button"
      >
        {m.library_member_remove()}
      </button>
    </>
  );
}

function MemberRow({
  member,
  index,
  members,
  firstPage,
  owner,
  ratio,
  busy,
  moveMember,
  saveNote,
  removeMember,
  dropMember,
}: {
  member: CollectionMember;
  index: number;
  members: CollectionMember[];
  firstPage: boolean;
  owner: boolean;
  ratio: CoverRatio;
  busy: boolean;
  moveMember: (memberId: string, after: string | null) => Promise<void>;
  saveNote: (memberId: string, note: string) => Promise<void>;
  removeMember: (memberId: string) => Promise<void>;
  dropMember: (memberId: string, event: PointerEvent<HTMLLIElement>) => void;
}) {
  const [note, setNote] = useState(member.note ?? '');
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setNote(member.note ?? ''), [member.note]);
  const up = placementAfter('up', index, members, firstPage);
  const down = placementAfter('down', index, members, firstPage);
  const top = placementAfter('top', index, members, firstPage);
  return (
    <li
      className="space-y-3 py-4"
      data-member={member.id}
      onPointerDown={
        owner && !busy
          ? (event) => {
              const target = event.target;
              if (!(target instanceof Element) || !target.closest('[data-drag-handle]')) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              event.currentTarget.dataset.dragging = member.id;
            }
          : undefined
      }
      onPointerUp={
        owner
          ? (event) => {
              if (event.currentTarget.dataset.dragging !== member.id) return;
              delete event.currentTarget.dataset.dragging;
              dropMember(member.id, event);
            }
          : undefined
      }
    >
      <div className="flex items-center gap-3">
        {owner ? (
          <span
            aria-hidden="true"
            className="inline-block h-10 w-6 shrink-0 cursor-grab touch-none select-none rounded-sm border border-border/70"
            data-drag-handle=""
          />
        ) : null}
        <SubjectIdentity subject={member.subject} ratio={ratio} />
      </div>
      {member.note ? <p className="whitespace-pre-wrap">{member.note}</p> : null}
      {owner ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {up !== undefined ? (
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() => void moveMember(member.id, up)}
                type="button"
              >
                {m.library_member_move_up()}
              </button>
            ) : null}
            {down !== undefined ? (
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() => void moveMember(member.id, down)}
                type="button"
              >
                {m.library_member_move_down()}
              </button>
            ) : null}
            {top !== undefined ? (
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() => void moveMember(member.id, top)}
                type="button"
              >
                {m.library_member_move_to_top()}
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block min-w-48 flex-1">
              {m.library_member_note()}
              <textarea
                className={fieldClass}
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                value={note}
              />
            </label>
            <button
              className={buttonClass}
              disabled={busy}
              onClick={() => void saveNote(member.id, note)}
              type="button"
            >
              {m.library_member_note_save()}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              <input
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.target.checked)}
                type="checkbox"
              />
              {m.library_member_remove_confirm()}
            </label>
            <button
              className={buttonClass}
              disabled={busy || !confirmed}
              onClick={() => void removeMember(member.id)}
              type="button"
            >
              {m.library_member_remove()}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
