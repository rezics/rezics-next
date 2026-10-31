import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { useId, useRef, useState, type FormEvent } from 'react';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { searchContentSubjects } from '../threads/content-subject-search';
import { csrfHeaders } from '../threads/composer';
import { addCollectionMember } from './collection-edit';

/** Each explicit add creates an occurrence, including when the subject is already a member. */
export function CollectionAddMembers({
  collectionId,
  onAdded,
  onClose,
}: {
  collectionId: string;
  onAdded: () => Promise<void>;
  onClose: () => void;
}) {
  const noteId = useId();
  const [selected, setSelected] = useState<EntityPickerSubject[]>([]);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [failure, setFailure] = useState('');
  const locked = useRef(false);
  const receipt = useRef<{ fingerprint: string; key: string } | null>(null);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (locked.current || !selected[0]) return;
    locked.current = true;
    setPending(true);
    setFailure('');
    try {
      if (!accepted) {
        const data = { collectionId, subjectId: selected[0].id, note: note || null };
        const fingerprint = JSON.stringify(data);
        if (receipt.current?.fingerprint !== fingerprint) receipt.current = { fingerprint, key: crypto.randomUUID() };
        const result = await addCollectionMember({
          data: { ...data, idempotencyKey: receipt.current.key },
          headers: csrfHeaders(),
        });
        if (!result.ok) {
          setFailure(
            result.reason === 'full'
              ? m.library_collection_full()
              : result.reason === 'conflict'
                ? m.library_collection_conflict()
                : result.reason === 'forbidden' || result.reason === 'unauthorized'
                  ? m.library_collection_not_owner()
                  : m.error_message(),
          );
          return;
        }
        setAccepted(true);
      }
      await onAdded();
      onClose();
    } catch {
      setFailure(m.error_message());
    } finally {
      locked.current = false;
      setPending(false);
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
        onValueChange={setSelected}
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
              onChange={(event) => setNote(event.target.value)}
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
