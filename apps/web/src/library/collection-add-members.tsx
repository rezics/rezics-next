import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { QueryClientContext } from '@tanstack/react-query';
import {
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { operationIsAdmitted, useOperation } from '../kernel/exposure';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { exposureQuery, sessionQuery, useSession } from '../session/query';
import { searchContentSubjects } from '../threads/content-subject-search';
import { addCollectionMember } from './collection-edit';

type CollectionAddMembersProps = {
  collectionId: string;
  onAdded: () => Promise<void>;
  onClose: () => void;
};

/** Each explicit add creates an occurrence, including when the subject is already a member. */
export function CollectionAddMembers(props: CollectionAddMembersProps) {
  const session = useSession();
  const admitted = useOperation('collection_member.create');
  const client = useContext(QueryClientContext);
  const observation = useMemo(() => {
    let snapshot = { subject: null as string | null, generation: 0 };
    function read() {
      const actual = client?.getQueryState<ReturnType<typeof useSession>>(sessionQuery.queryKey);
      const exposure = client?.getQueryState<readonly string[]>(exposureQuery.queryKey);
      const viewer = actual?.data;
      const subject =
        actual?.status === 'success' &&
        viewer?.state === 'signed-in' &&
        viewer.subject &&
        viewer.csrfToken &&
        exposure?.status === 'success' &&
        operationIsAdmitted('collection_member.create', exposure.data)
          ? viewer.subject
          : null;
      if (subject !== snapshot.subject) snapshot = { subject, generation: snapshot.generation + 1 };
      return snapshot;
    }
    return {
      read,
      subscribe: (notify: () => void) => {
        // QueryCache notifications are synchronous, including away/back transitions batched before a React commit.
        const unsubscribe = client?.getQueryCache().subscribe(() => {
          read();
          notify();
        });
        read();
        return () => unsubscribe?.();
      },
    };
  }, [client]);
  const snapshot = useSyncExternalStore(observation.subscribe, observation.read, observation.read);
  const ready = Boolean(
    snapshot.subject &&
    session.state === 'signed-in' &&
    session.subject === snapshot.subject &&
    session.csrfToken &&
    admitted &&
    props.collectionId,
  );
  const signature = JSON.stringify([snapshot.generation, props.collectionId, ready]);
  const boundary = useRef({ signature, observation, generation: 0, mounted: false, retired: false });
  if (boundary.current.signature !== signature || boundary.current.observation !== observation) {
    boundary.current.retired = true;
    boundary.current = {
      signature,
      observation,
      generation: boundary.current.generation + 1,
      mounted: false,
      retired: false,
    };
  }
  const origin = boundary.current;
  useLayoutEffect(() => {
    origin.mounted = true;
    return () => {
      // A dispatched write can still commit; only its UI completion is retired.
      origin.mounted = false;
    };
  }, [origin]);
  function currentCsrf() {
    if (observation.read() !== snapshot) origin.retired = true;
    if (!ready || !origin.mounted || origin.retired) return null;
    const actual = client?.getQueryData(sessionQuery.queryKey);
    return actual?.state === 'signed-in' && actual.subject === snapshot.subject && actual.csrfToken
      ? actual.csrfToken
      : null;
  }
  function close() {
    if (!currentCsrf()) return;
    origin.retired = true;
    props.onClose();
  }
  if (!ready) return null;
  // A nonempty token rotation preserves the occurrence; viewer/admission/address replacement retires it.
  return (
    <CollectionAddMembersForm key={origin.generation} {...props} currentCsrf={currentCsrf} onClose={close} />
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
  currentCsrf,
}: CollectionAddMembersProps & { currentCsrf: () => string | null }) {
  const noteId = useId();
  const [selected, setSelected] = useState<EntityPickerSubject[]>([]);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [failure, setFailure] = useState('');
  const locked = useRef(false);
  const receipt = useRef<AddReceipt | null>(null);
  const frozen = Boolean(receipt.current?.uncertain || accepted);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!currentCsrf() || locked.current || !selected[0]) return;
    locked.current = true;
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
        setAccepted(true);
      }
      if (!currentCsrf()) return;
      await onAdded();
      if (!currentCsrf()) return;
      onClose();
    } catch {
      if (currentCsrf()) setFailure(m.error_message());
    } finally {
      if (currentCsrf()) {
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
          if (!currentCsrf() || locked.current || receipt.current?.accepted || receipt.current?.uncertain) return;
          receipt.current = null;
          setSelected(value);
        }}
        disabled={pending || frozen}
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
              disabled={pending || frozen}
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
        <Button type="submit" disabled={pending || selected.length === 0} aria-busy={pending}>
          {accepted ? m.library_collection_reload() : m.library_collection_add_selected()}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => {
            if (currentCsrf() && !locked.current) onClose();
          }}
        >
          {m.library_collection_cancel()}
        </Button>
      </div>
    </form>
  );
}
