import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useOperation } from '../kernel/exposure';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import { searchContentSubjects } from '../threads/content-subject-search';
import { addCollectionMember } from './collection-edit';

type CollectionAddMembersProps = {
  collectionId: string;
  onAdded: () => Promise<void>;
  onClose: () => void;
};

/** Each explicit add creates an occurrence, including when the subject is already a member. */
export function CollectionAddMembers(props: CollectionAddMembersProps) {
  const { state, subject, csrfToken } = useSession();
  const admitted = useOperation('collection_member.create');
  if (state !== 'signed-in' || !subject || !csrfToken || !admitted || !props.collectionId) return null;
  // Losing admission unmounts the draft; returning to the same viewer starts a new lifetime.
  // An ordinary refresh or nonempty CSRF rotation preserves the captured intent.
  return (
    <CollectionAddMembersForm key={JSON.stringify([subject, props.collectionId])} {...props} csrfToken={csrfToken} />
  );
}

type AddReceipt = {
  data: { collectionId: string; subjectId: string; note: string | null; idempotencyKey: string };
  accepted: boolean;
};

function CollectionAddMembersForm({
  collectionId,
  onAdded,
  onClose,
  csrfToken,
}: CollectionAddMembersProps & { csrfToken: string }) {
  const noteId = useId();
  const [selected, setSelected] = useState<EntityPickerSubject[]>([]);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [failure, setFailure] = useState('');
  const locked = useRef(false);
  const receipt = useRef<AddReceipt | null>(null);
  const lifetime = useRef({ active: false });
  useLayoutEffect(() => {
    const current = { active: true };
    lifetime.current = current;
    return () => {
      // A dispatched write can still commit; only its UI completion is retired.
      current.active = false;
    };
  }, []);

  async function add(event: FormEvent) {
    event.preventDefault();
    const current = lifetime.current;
    if (!current.active || locked.current || !selected[0]) return;
    locked.current = true;
    setPending(true);
    setFailure('');
    try {
      const captured = (receipt.current ??= {
        data: { collectionId, subjectId: selected[0].id, note: note || null, idempotencyKey: crypto.randomUUID() },
        accepted: false,
      });
      if (!captured.accepted) {
        const result = await addCollectionMember({
          data: captured.data,
          headers: { 'X-CSRF-Token': csrfToken },
        });
        if (!current.active) return;
        if (!result.ok) {
          setFailure(
            result.reason === 'full'
              ? m.library_collection_full()
              : result.reason === 'conflict'
                ? m.library_collection_conflict()
                : m.error_message(),
          );
          return;
        }
        captured.accepted = true;
        setAccepted(true);
      }
      await onAdded();
      if (!current.active) return;
      onClose();
    } catch {
      if (current.active) setFailure(m.error_message());
    } finally {
      if (current.active) {
        locked.current = false;
        setPending(false);
      }
    }
  }

  return (
    <form
      className="min-w-0 space-y-3 rounded-2xl border border-border bg-card p-4"
      onSubmit={(event) => void add(event)}
      aria-label={m.library_collection_add_items()}
    >
      <h2 className="font-semibold">{m.library_collection_add_items()}</h2>
      <EntityPicker
        label={m.library_collection_find_subject()}
        search={searchContentSubjects}
        src={coverSrc}
        value={selected}
        onValueChange={(value) => {
          if (locked.current || receipt.current?.accepted) return;
          receipt.current = null;
          setSelected(value);
        }}
        disabled={pending || accepted}
      />
      {selected.length ? (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-primary">{m.library_member_note()}</summary>
          <Field>
            <FieldLabel htmlFor={noteId}>{m.library_member_note()}</FieldLabel>
            <Textarea
              id={noteId}
              value={note}
              maxLength={20_000}
              disabled={pending || accepted}
              onChange={(event) => {
                if (locked.current || receipt.current?.accepted) return;
                receipt.current = null;
                setNote(event.target.value);
              }}
            />
          </Field>
        </details>
      ) : null}
      {failure ? <p role="alert">{failure}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || selected.length === 0} aria-busy={pending}>
          {accepted ? m.library_collection_reload() : m.library_collection_add_selected()}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
          {m.library_collection_cancel()}
        </Button>
      </div>
    </form>
  );
}
