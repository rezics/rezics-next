import { CollectionPresentationSummary } from '../../library/showcase-collection/presentation';
import { useCollectionDraftNavigation } from '../../library/collection-draft-navigation';
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
import { VisibilityField } from '../../library/collection-page';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
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
    <article className="w-full min-w-0 max-w-6xl space-y-6 text-foreground">
      <header className="space-y-3">
        <PageHeading>{m.library_collection_new()}</PageHeading>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.collection_workbench_create_help()}
        </p>
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
  const [retired, setRetired] = useState(false);
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

  function retire() {
    const current = lifetime.current;
    current.active = false;
    current.locked = false;
    current.intent = null;
    setRetired(true);
  }
  const draftNavigation = useCollectionDraftNavigation({
    dirty: !retired && (Boolean(title.trim() || description.trim()) || visibility !== '' || kind !== null),
    locked: !retired && (pending || uncertain),
    isCurrent: () => lifetime.current.active,
    creation: { commandMayHaveApplied: pending || uncertain, discard: retire },
  });

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = lifetime.current;
    // This mounted lifetime exists only while the observed subject, CSRF and operation are admitted.
    if (!current.active || current.locked || !csrfToken || visibility === '') return;
    current.locked = true;
    setPending(true);
    setFailure('');
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
        // Retire synchronously before navigation so beforeunload and an older departure cannot compete.
        retire();
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
      if (current.active) {
        current.locked = false;
        setPending(false);
      }
    }
  }

  return (
    <form
      noValidate
      className="min-w-0 space-y-5"
      onSubmit={(event) => void create(event)}
      data-collection-create-workbench
    >
      {draftNavigation}
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <fieldset
        className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]"
        disabled={retired || pending || uncertain}
      >
        <section
          className="min-w-0 space-y-5 rounded-2xl border border-border bg-card p-4 sm:p-6"
          aria-labelledby="collection-create-details"
        >
          <h2 id="collection-create-details" className="text-lg font-semibold">
            {m.library_collection_details()}
          </h2>
          <Field className="min-w-0 gap-2">
            <FieldLabel htmlFor="collection-new-title">{m.library_collection_title()}</FieldLabel>
            <Input
              id="collection-new-title"
              className="min-h-11"
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
            <CollectionTextInputHelp id="collection-new-title" field="title" value={title} submitted={textSubmitted} />
          </Field>
          <Field className="min-w-0 gap-2">
            <FieldLabel htmlFor="collection-new-description">{m.library_collection_description()}</FieldLabel>
            <Textarea
              id="collection-new-description"
              className="min-h-28"
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
            <CollectionTextInputHelp
              id="collection-new-description"
              field="description"
              value={description}
              submitted={textSubmitted}
            />
          </Field>
          <VisibilityField onChange={setVisibility} value={visibility} disabled={retired || pending || uncertain} />
          <div className="space-y-2 border-t border-border pt-4" data-collection-create-members>
            <h3 className="font-medium">{m.library_collection_members()}</h3>
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
              {m.collection_workbench_empty_help()}
            </p>
          </div>
        </section>
        <aside className="min-w-0 space-y-4" aria-label={m.collection_choice_heading()}>
          <details
            className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-5"
            data-collection-presentation-settings
          >
            <summary className="min-h-11 cursor-pointer py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {m.collection_choice_heading()}
            </summary>
            <div className="pt-3">
              <CollectionPresentationFields
                types={types}
                kind={kind}
                onKindChange={setKind}
                coverMediaId={null}
                disabled={retired || pending || uncertain}
              />
            </div>
          </details>
        </aside>
      </fieldset>
      {title.trim() ? (
        <section
          className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4 [overflow-wrap:anywhere]"
          data-collection-create-review
        >
          <h2 className="font-semibold">{m.collection_review_heading()}</h2>
          <p className="whitespace-pre-wrap font-medium">{title}</p>
          {description ? <p className="whitespace-pre-wrap text-muted-foreground">{description}</p> : null}
          <CollectionPresentationSummary kind={kind} types={types} />
          <p className="text-sm text-muted-foreground">{m.collection_review_native_help()}</p>
        </section>
      ) : null}
      {failure ? <p role="alert">{failure}</p> : null}
      <div className="sticky bottom-3 z-20 flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm">
        <Button
          className="h-auto min-h-11 max-w-full whitespace-normal px-5 py-3"
          disabled={retired || pending || visibility === ''}
          aria-busy={pending}
          type="submit"
        >
          {uncertain ? m.library_publication_retry() : m.library_collection_create()}
        </Button>
        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
          {m.collection_workbench_save_help()}
        </p>
      </div>
    </form>
  );
}
