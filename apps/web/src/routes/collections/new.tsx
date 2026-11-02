import { collectionTextIssue } from '../../library/collection-text-input';
import { CollectionTextInputHelp, collectionTextInputAttributes } from '../../library/collection-text-input-field';
import { useOperation } from '../../kernel/exposure';
import { requireSignedIn } from '../../session/guard';
import { useSession } from '../../session/query';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createCollection, readNewCollection } from '../../library/collection-edit';
import { buttonClass, fieldClass, VisibilityField } from '../../library/collection-page';
import type { CollectionVisibility } from '../../library/reads';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { CollectionPresentationFields } from '../../library/collection-editor';
import { PageHeading } from '../../shell/page-heading';
import type { CollectionTypeOption } from '../../library/collection-presentation';

export const Route = createFileRoute('/collections/new')({
  beforeLoad: requireSignedIn,
  loader: () => readNewCollection(),
  head: ({ match }) =>
    pageHead({ title: m.library_collection_new(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: NewCollectionPage,
});

function NewCollectionPage() {
  const loaded = Route.useLoaderData();
  const { state, subject, csrfToken } = useSession();
  const admitted = useOperation('collection.create');

  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <PageHeading>{m.library_collection_new()}</PageHeading>
      </header>
      {state === 'signed-in' && subject && csrfToken && admitted ? (
        <NewCollectionForm key={subject} csrfToken={csrfToken} types={loaded.types} sender={createCollection} />
      ) : null}
    </article>
  );
}

type CreateIntent = {
  sender: typeof createCollection;
  headers: { 'X-CSRF-Token': string };
  data: {
    title: string;
    description: string;
    visibility: CollectionVisibility;
    presentationKind: string | null;
    idempotencyKey: string;
  };
};

export function NewCollectionForm({
  csrfToken,
  types,
  sender,
}: {
  csrfToken: string;
  types: CollectionTypeOption[] | null;
  sender: typeof createCollection;
}) {
  // The loader UUID is public, not a viewer lifetime. Every admitted mount gets a fresh command key.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [visibility, setVisibility] = useState<CollectionVisibility | ''>('');
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [kind, setKind] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  const [textSubmitted, setTextSubmitted] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const lifetime = useRef({ active: false, locked: false, intent: null as CreateIntent | null });
  useLayoutEffect(() => {
    const current = { active: true, locked: false, intent: null as CreateIntent | null };
    lifetime.current = current;
    return () => {
      // Native IO may still commit. Its callbacks and private intent no longer belong to any current UI.
      current.active = false;
      current.locked = false;
      current.intent = null;
    };
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = lifetime.current;
    // This mounted lifetime exists only while the observed subject, CSRF and operation are admitted.
    if (!current.active || current.locked || !csrfToken || visibility === '') return;
    current.locked = true;
    setPending(true);
    setFailure('');
    let navigating = false;
    try {
      if (!current.intent) {
        const form = new FormData(event.currentTarget);
        const title = String(form.get('title') ?? '');
        const description = String(form.get('description') ?? '');
        setTextSubmitted(true);
        if (collectionTextIssue('title', title) || collectionTextIssue('description', description)) return;
        current.intent = {
          sender,
          headers: { 'X-CSRF-Token': csrfToken },
          data: {
            title,
            description,
            visibility,
            presentationKind: kind,
            idempotencyKey,
          },
        };
      }
      const intent = current.intent;
      const result = await intent.sender({ data: intent.data, headers: intent.headers });
      if (!current.active) return;
      if (result.ok) {
        navigating = true;
        window.location.assign(`/${getLocale()}/collections/${encodeURIComponent(result.id)}`);
        return;
      }
      if (result.reason === 'unavailable') {
        setUncertain(true);
        setFailure(m.library_publication_unknown());
      } else {
        // A definite refusal permits correction; an uncertain request must first recover its exact outcome.
        current.intent = null;
        setUncertain(false);
        setIdempotencyKey(crypto.randomUUID());
        setFailure(m.error_message());
      }
    } catch {
      if (current.active) {
        setUncertain(true);
        setFailure(m.library_publication_unknown());
      }
    } finally {
      if (current.active && !navigating) {
        current.locked = false;
        setPending(false);
      }
    }
  }

  return (
    <form noValidate className="space-y-6" onSubmit={(event) => void create(event)}>
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <fieldset className="space-y-6" disabled={pending || uncertain}>
        <label className="block">
          {m.library_collection_title()}
          <input
            className={fieldClass}
            name="title"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            {...collectionTextInputAttributes({
              id: 'collection-new-title',
              field: 'title',
              value: title,
              submitted: textSubmitted,
            })}
          />
        </label>
        <CollectionTextInputHelp id="collection-new-title" field="title" value={title} submitted={textSubmitted} />
        <label className="block">
          {m.library_collection_description()}
          <textarea
            className={fieldClass}
            name="description"
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            {...collectionTextInputAttributes({
              id: 'collection-new-description',
              field: 'description',
              value: description,
              submitted: textSubmitted,
            })}
          />
        </label>
        <CollectionTextInputHelp
          id="collection-new-description"
          field="description"
          value={description}
          submitted={textSubmitted}
        />
        <CollectionPresentationFields
          types={types}
          kind={kind}
          onKindChange={setKind}
          coverMediaId={null}
          disabled={pending || uncertain}
        />
        <VisibilityField onChange={setVisibility} value={visibility} disabled={pending || uncertain} />
      </fieldset>
      {failure ? <p role="alert">{failure}</p> : null}
      <button className={buttonClass} disabled={pending || visibility === ''} aria-busy={pending} type="submit">
        {uncertain ? m.library_publication_retry() : m.library_collection_create()}
      </button>
    </form>
  );
}
