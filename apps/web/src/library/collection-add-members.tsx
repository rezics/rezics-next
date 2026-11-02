import { collectionTextIssue } from './collection-text-input';
import { CollectionTextInputHelp, collectionTextInputAttributes } from './collection-text-input-field';
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
  const [textSubmitted, setTextSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  const locked = useRef<object | null>(null);
  const receipt = useRef<AddReceipt | null>(null);
  const accepted = receipt.current?.accepted ?? false;
  const frozen = Boolean(receipt.current?.uncertain || accepted);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!currentCsrf() || locked.current || !selected[0]) return;
    if (!receipt.current) {
      setTextSubmitted(true);
      if (collectionTextIssue('note', note)) return;
    }
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
      className="min-w-0 space-y-3 rounded-2xl border border-border bg-card p-4 [overflow-wrap:anywhere]"
      onSubmit={(event) => void add(event)}
      aria-label={m.library_collection_add_items()}
      aria-describedby={failure ? `${noteId}-error` : undefined}
    >
      <h2 className="min-w-0 font-semibold">{m.library_collection_add_items()}</h2>
      <EntityPicker
        className="[&_[data-slot=input-group]]:min-h-11 [&_input]:min-h-11 [&_input]:min-w-0"
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
      {selected[0] ? <p className="min-w-0 whitespace-pre-wrap font-medium">{selected[0].title}</p> : null}
      {selected.length ? (
        <details className="min-w-0" open={textSubmitted && !!collectionTextIssue('note', note) ? true : undefined}>
          <summary className="min-h-11 cursor-pointer rounded-sm py-2 text-sm text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {m.library_member_note()}
          </summary>
          <Field className="min-w-0">
            <FieldLabel htmlFor={noteId} className="min-w-0 whitespace-normal">
              {m.library_member_note()}
            </FieldLabel>
            <Textarea
              id={noteId}
              className="min-w-0 max-w-full resize-y"
              value={note}
              {...collectionTextInputAttributes({ id: noteId, field: 'note', value: note, submitted: textSubmitted })}
              disabled={!ready || pending || frozen}
              onChange={(event) => {
                if (!currentCsrf() || locked.current || receipt.current?.accepted || receipt.current?.uncertain) return;
                receipt.current = null;
                setNote(event.target.value);
              }}
            />
            <CollectionTextInputHelp id={noteId} field="note" value={note} submitted={textSubmitted} />
          </Field>
        </details>
      ) : null}
      {failure ? (
        <p id={`${noteId}-error`} role="alert" className="min-w-0">
          {failure}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          type="submit"
          className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2"
          disabled={!ready || pending || selected.length === 0}
          aria-busy={pending}
          aria-describedby={failure ? `${noteId}-error` : undefined}
        >
          {accepted ? m.library_collection_reload() : m.library_collection_add_selected()}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2"
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
