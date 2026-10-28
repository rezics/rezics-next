import { Exposure } from '../../kernel/exposure';
import { requireSignedIn } from '../../session/guard';
import { useSession } from '../../session/query';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { createCollection, readNewCollection } from '../../library/collection-edit';
import { buttonClass, fieldClass, VisibilityField } from '../../library/collection-page';
import type { CollectionVisibility } from '../../library/reads';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';

export const Route = createFileRoute('/collections/new')({
  beforeLoad: requireSignedIn,
  loader: () => readNewCollection(),
  head: ({ match }) =>
    pageHead({ title: m.library_collection_new(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: NewCollectionPage,
});

function NewCollectionPage() {
  const loaded = Route.useLoaderData();
  const { csrfToken } = useSession();
  const [idempotencyKey, setIdempotencyKey] = useState(loaded.idempotencyKey);
  const [visibility, setVisibility] = useState<CollectionVisibility | ''>('');
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  useEffect(() => setHydrated(true), []);
  useEffect(() => setIdempotencyKey(loaded.idempotencyKey), [loaded.idempotencyKey]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || pending || visibility === '') return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure('');
    try {
      const result = await createCollection({
        data: {
          title: String(form.get('title') ?? ''),
          description: String(form.get('description') ?? ''),
          visibility,
          idempotencyKey,
        },
        headers: { 'X-CSRF-Token': csrfToken ?? '' },
      });
      if (result.ok) {
        window.location.assign(`/${getLocale()}/collections/${encodeURIComponent(result.id)}`);
        return;
      }
      // A refused draft is a different request from the one the key was spent on.
      if (result.reason !== 'unavailable') setIdempotencyKey(crypto.randomUUID());
      setFailure(m.error_message());
    } catch {
      setFailure(m.error_message());
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <PageHeading>{m.library_collection_new()}</PageHeading>
      </header>

      <Exposure operation="collection.create">
        <form className="space-y-6" onSubmit={(event) => void create(event)}>
          <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
          <label className="block">
            {m.library_collection_title()}
            <input className={fieldClass} maxLength={512} name="title" required />
          </label>
          <label className="block">
            {m.library_collection_description()}
            <textarea className={fieldClass} name="description" rows={4} />
          </label>
          <VisibilityField onChange={setVisibility} value={visibility} />
          {failure ? <p role="alert">{failure}</p> : null}
          <button className={buttonClass} disabled={!hydrated || pending || visibility === ''} type="submit">
            {m.library_collection_create()}
          </button>
        </form>
      </Exposure>
    </article>
  );
}
