import { useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import { updateCollection } from './collection-edit';
import { useCollectionOwnerCurrent } from './collection-owner-current';
import type { DynamicCollectionPage } from './dynamic-collection';
import {
  createGuardedCommand,
  dispatchGuardedCommand,
  type GuardedCommand,
  type GuardedSender,
} from './configured-profile-controls/commands';
import type { CollectionWriteResult } from './collection-records';

type Visibility = NonNullable<DynamicCollectionPage['visibility']>;
type Draft = { title: string; description: string; visibility: Visibility };
type Patch = Draft & { collectionId: string; revision: number; idempotencyKey: string };
const sender: GuardedSender<Patch, CollectionWriteResult> = updateCollection;

export function BuiltinCollectionMetadata({
  collectionId,
  revision,
  title,
  description,
  visibility,
  readCurrent,
  onRead,
}: {
  collectionId: string;
  revision: number;
  title: string;
  description: string | null;
  visibility: Visibility;
  readCurrent: () => Promise<DynamicCollectionPage>;
  onRead: (page: DynamicCollectionPage) => void;
}) {
  const owner = useCollectionOwnerCurrent(`builtin-metadata:${collectionId}`);
  const titleId = useId();
  const descriptionId = useId();
  const [draft, setDraft] = useState<(Draft & { revision: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'uncertain' | 'conflict' | 'refused' | 'confirmed' | 'read-failed' | null>(null);
  const intent = useRef<GuardedCommand<Patch, CollectionWriteResult> | null>(null);
  const acknowledged = useRef<number | null>(null);
  const running = useRef(false);
  const locked = busy || intent.current !== null || acknowledged.current !== null;
  const addressCurrent = owner.isOwnerCurrent;
  const validDraft =
    draft !== null &&
    draft.title.trim().length > 0 &&
    Array.from(draft.title.trim()).length <= 200 &&
    Array.from(draft.description).length <= 2000;
  const changed =
    draft !== null &&
    (draft.title.trim() !== title || draft.description !== (description ?? '') || draft.visibility !== visibility);

  async function refresh(minimumRevision: number) {
    const page = await readCurrent();
    if (!addressCurrent()) return;
    if (
      page.id !== collectionId ||
      page.curatorAccountId !== owner.subject ||
      page.revision === undefined ||
      page.revision < minimumRevision
    )
      throw new Error('Collection observation changed');
    acknowledged.current = null;
    setDraft(null);
    setState(null);
    onRead(page);
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || running.current || acknowledged.current !== null || !addressCurrent()) return;
    if (!intent.current) {
      const authorization = owner.credential();
      if (!authorization || !owner.operationCurrent('collection.update', true)) return;
      if (draft.revision !== revision) {
        setState('conflict');
        return;
      }
      if (!validDraft || !changed) return;
      intent.current = createGuardedCommand(sender, authorization, {
        collectionId,
        revision: draft.revision,
        title: draft.title.trim(),
        description: draft.description,
        visibility: draft.visibility,
        idempotencyKey: crypto.randomUUID(),
      });
    }

    running.current = true;
    setBusy(true);
    try {
      const result = await dispatchGuardedCommand(intent.current, addressCurrent);
      if (!result) return;
      if (!result.ok) {
        if (result.reason === 'unavailable' || (state === 'uncertain' && result.reason !== 'conflict')) {
          setState('uncertain');
        } else {
          intent.current = null;
          setState(result.reason === 'conflict' ? 'conflict' : 'refused');
        }
        return;
      }
      if (result.id !== collectionId || result.revision !== draft.revision + 1) {
        setState('uncertain');
        return;
      }
      intent.current = null;
      acknowledged.current = result.revision;
      setState('confirmed');
      await refresh(result.revision);
    } catch {
      if (addressCurrent()) setState(acknowledged.current === null ? 'uncertain' : 'read-failed');
    } finally {
      running.current = false;
      if (addressCurrent()) setBusy(false);
    }
  }

  async function reread() {
    if (running.current || !addressCurrent()) return;
    const minimum = acknowledged.current ?? revision;
    running.current = true;
    setBusy(true);
    try {
      await refresh(minimum);
    } catch {
      if (addressCurrent()) setState(acknowledged.current === null ? 'conflict' : 'read-failed');
    } finally {
      running.current = false;
      if (addressCurrent()) setBusy(false);
    }
  }

  if (!draft)
    return (
      <Button
        type="button"
        variant="outline"
        className="mt-3 h-auto min-h-7 whitespace-normal"
        disabled={!owner.operationCurrent('collection.update', true)}
        onClick={() => setDraft({ revision, title, description: description ?? '', visibility })}
      >
        {m.library_collection_edit()}
      </Button>
    );

  return (
    <form className="mt-3 grid max-w-xl gap-3 rounded-lg border p-4" onSubmit={(event) => void send(event)}>
      <Field>
        <FieldLabel htmlFor={titleId}>{m.library_collection_title()}</FieldLabel>
        <Input
          id={titleId}
          value={draft.title}
          disabled={locked}
          required
          maxLength={400}
          onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={descriptionId}>{m.library_collection_description()}</FieldLabel>
        <Textarea
          id={descriptionId}
          value={draft.description}
          disabled={locked}
          maxLength={4000}
          onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })}
        />
      </Field>
      {visibility !== 'private' ? (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={draft.visibility === 'private'}
            disabled={locked}
            onChange={(event) => setDraft({ ...draft, visibility: event.currentTarget.checked ? 'private' : visibility })}
          />
          <span>{m.library_visibility_private_note()}</span>
        </label>
      ) : null}
      {state === 'uncertain' ? <p role="alert">{m.collection_save_unknown_help()}</p> : null}
      {state === 'conflict' ? <p role="alert">{m.library_collection_conflict()}</p> : null}
      {state === 'refused' || state === 'read-failed' ? <p role="alert">{m.error_message()}</p> : null}
      <div className="flex flex-wrap gap-2">
        {state === 'conflict' || acknowledged.current !== null ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void reread()}>
            {m.library_collection_reload()}
          </Button>
        ) : (
          <Button type="submit" disabled={busy || (!intent.current && (!validDraft || !changed))}>
            {busy
              ? m.library_collection_save_pending()
              : state === 'uncertain'
                ? m.library_configured_retry()
                : m.library_collection_save()}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() => {
            setDraft(null);
            setState(null);
          }}
        >
          {m.library_collection_cancel()}
        </Button>
      </div>
    </form>
  );
}
