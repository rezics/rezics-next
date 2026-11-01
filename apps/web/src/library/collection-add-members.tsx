import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useCollectionCurrentAdmission } from './collection-current-admission';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import { searchContentSubjects } from '../threads/content-subject-search';
import { addCollectionMember } from './collection-edit';

type CollectionAddMembersProps = {
  collectionId: string;
  onAdded: () => Promise<void>;
  onClose: () => void;
  /** Rejection from the enclosing page's native action/read lifetime. */
  isCurrent?: () => boolean;
};

/** Each explicit add creates an occurrence, including when the subject is already a member. */
export function CollectionAddMembers(props: CollectionAddMembersProps) {
  useSession();
  const admission = useCollectionCurrentAdmission(JSON.stringify([props.collectionId]));
  const currentCsrf = () => ((props.isCurrent?.() ?? true) ? admission.csrf('collection_member.create') : null);
  const ready = !!props.collectionId && !!currentCsrf();
  return (
    <CollectionAddMembersForm
      key={admission.owner}
      {...props}
      ready={ready}
      retained={admission.retained}
      currentCsrf={currentCsrf}
    />
  );
}

type AddReceipt = {
  data: { collectionId: string; subjectId: string; note: string | null; idempotencyKey: string };
  accepted: boolean;
  uncertain: boolean;
};

function CollectionAddMembersForm({
  collectionId,
  onAdded,
  onClose,
  currentCsrf: admittedCsrf,
  retained,
  ready,
}: CollectionAddMembersProps & { currentCsrf: () => string | null; retained: () => boolean; ready: boolean }) {
  const closed = useRef(false);
  const currentCsrf = () => (closed.current ? null : admittedCsrf());
  function close() {
    if (!currentCsrf()) return;
    closed.current = true;
    onClose();
  }
  const noteId = useId();
  const [selected, setSelected] = useState<EntityPickerSubject[]>([]);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  const locked = useRef<object | null>(null);
  const receipt = useRef<AddReceipt | null>(null);
  const accepted = receipt.current?.accepted ?? false;
  const frozen = Boolean(receipt.current?.uncertain || accepted);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!currentCsrf() || locked.current || !selected[0]) return;
    const request = {};
    locked.current = request;
    setPending(true);
    setFailure('');
    try {
      const captured = (receipt.current ??= {
        data: { collectionId, subjectId: selected[0].id, note: note || null, idempotencyKey: crypto.randomUUID() },
        accepted: false,
        uncertain: true,
      });
      if (!captured.accepted) {
        const csrfToken = currentCsrf();
        if (!csrfToken) return;
        captured.uncertain = true;
        const result = await addCollectionMember({
          data: captured.data,
          headers: { 'X-CSRF-Token': csrfToken },
        });
        if (!retained()) return;
        // A dispatched native success remains acknowledged during a permission gap. Publishing,
        // reload and close still require the originating permission episode below.
        if (result.ok) {
          captured.accepted = true;
          captured.uncertain = false;
        }
        if (!currentCsrf()) return;
        if (!result.ok) {
          // Only a known refusal permits correcting this command. An unknown outcome keeps its exact input/key.
          captured.uncertain = result.reason === 'unavailable';
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
        captured.uncertain = false;
      }
      if (!currentCsrf()) return;
      await onAdded();
      if (!currentCsrf()) return;
      close();
    } catch {
      if (currentCsrf()) setFailure(m.error_message());
    } finally {
      if (locked.current === request) {
        locked.current = null;
        if (retained()) setPending(false);
      }
    }
  }

  return (
    <form
      hidden={!ready}
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
          if (!currentCsrf() || locked.current || receipt.current?.accepted || receipt.current?.uncertain) return;
          receipt.current = null;
          setSelected(value);
        }}
        disabled={!ready || pending || frozen}
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
              disabled={!ready || pending || frozen}
              onChange={(event) => {
                if (!currentCsrf() || locked.current || receipt.current?.accepted || receipt.current?.uncertain) return;
                receipt.current = null;
                setNote(event.target.value);
              }}
            />
          </Field>
        </details>
      ) : null}
      {failure ? <p role="alert">{failure}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!ready || pending || selected.length === 0} aria-busy={pending}>
          {accepted ? m.library_collection_reload() : m.library_collection_add_selected()}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => {
            if (currentCsrf() && !locked.current) close();
          }}
        >
          {m.library_collection_cancel()}
        </Button>
      </div>
    </form>
  );
}
