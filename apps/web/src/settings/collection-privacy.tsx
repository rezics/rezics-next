import { queryOptions, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import type { CollectionVisibility } from '../library/reads';
import { csrfHeaders } from '../threads/composer';
import { readOwnedCollection, readOwnedCollectionsPage, saveCollectionVisibility } from './actions';
import type { OwnedCollection } from './preferences';

const visibilityOptions = ['private', 'unlisted', 'public'] as const;
type Page = { collections: OwnedCollection[]; next: string | null };

const pageQuery = (cursor: string | null, admitted: boolean) =>
  queryOptions({
    ...personalRead,
    queryKey: ['settings', 'collections', cursor],
    queryFn: () => readOwnedCollectionsPage({ data: cursor }),
    retry: false,
    enabled: personalRead.enabled && admitted,
  });

function label(value: CollectionVisibility) {
  return value === 'private'
    ? m.settings_privacy_private()
    : value === 'unlisted'
      ? m.settings_privacy_unlisted()
      : m.settings_privacy_public();
}
function explanation(value: CollectionVisibility) {
  return value === 'private'
    ? m.settings_privacy_private_text()
    : value === 'unlisted'
      ? m.settings_privacy_unlisted_text()
      : m.settings_privacy_public_text();
}

export function CollectionRow({ collection }: { collection: OwnedCollection }) {
  const { csrfToken } = useSession();
  const [current, setCurrent] = useState(collection);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<'conflict' | 'failed' | 'saving' | null>(null);
  async function change(visibility: CollectionVisibility) {
    if (!csrfToken || busy || visibility === current.visibility) return;
    setBusy(true);
    setMessage('saving');
    try {
      const answer = await saveCollectionVisibility({
        data: { collectionId: current.id, revision: current.revision, visibility, idempotencyKey: crypto.randomUUID() },
        headers: csrfHeaders(),
      });
      if (answer.ok) {
        setCurrent(answer.collection);
        setMessage(null);
      } else setMessage(answer.reason === 'conflict' ? 'conflict' : 'failed');
    } catch {
      setMessage('failed');
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setBusy(true);
    try {
      setCurrent(await readOwnedCollection({ data: current.id }));
      setMessage(null);
    } catch {
      setMessage('failed');
    } finally {
      setBusy(false);
    }
  }
  const href = `/${getLocale()}/collections/${encodeURIComponent(current.id)}`;
  return (
    <ListRow className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)] sm:items-center">
      <div className="min-w-0">
        <ListRowLink href={href}>{current.title}</ListRowLink>
        <span
          aria-hidden="true"
          className="break-words font-medium text-primary underline-offset-4 group-hover:underline group-focus-within:underline"
        >
          {current.title}
        </span>
        <p className="mt-1 text-sm text-muted-foreground">{explanation(current.visibility)}</p>
      </div>
      <ListRowControl>
        <label className="grid gap-1 text-sm font-medium">
          {m.settings_privacy_visibility_label()}
          <select
            className="min-h-10 w-full rounded-md border border-input bg-background px-3 text-foreground"
            value={current.visibility}
            disabled={!csrfToken || busy}
            onChange={(event) => void change(event.target.value as CollectionVisibility)}
          >
            {visibilityOptions.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        </label>
      </ListRowControl>
      <ListRowControl className="sm:col-span-2">
        <div aria-live="polite">
          {message === 'saving' ? <p className="text-sm text-muted-foreground">{m.settings_saving()}</p> : null}
          {message === 'conflict' ? (
            <Alert>
              <AlertTitle>{m.settings_privacy_conflict_title()}</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>{m.settings_privacy_conflict_text()}</span>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}>
                  {m.settings_privacy_reload_row()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {message === 'failed' ? (
            <Alert variant="destructive">
              <AlertTitle>{m.settings_failed_title()}</AlertTitle>
              <AlertDescription>{m.settings_failed_text()}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </ListRowControl>
    </ListRow>
  );
}

export function CollectionPrivacySection() {
  const admitted = useOperation('account.collections');
  const [pages, setPages] = useState<Page[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const { data, isPending, isError } = useQuery(pageQuery(null, admitted));
  if (!admitted) return null;
  const visiblePages = data ? [data, ...pages] : pages;
  async function more() {
    const next = visiblePages.at(-1)?.next;
    if (!next || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await readOwnedCollectionsPage({ data: next });
      setPages((current) => [...current, page]);
    } finally {
      setLoadingMore(false);
    }
  }
  return (
    <section id="privacy" aria-labelledby="settings-privacy-heading" className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id="settings-privacy-heading">{m.settings_privacy_heading()}</h2>
          </CardTitle>
          <CardDescription>{m.settings_privacy_text()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isPending ? <p role="status">{m.settings_privacy_loading()}</p> : null}
          {isError ? (
            <Alert variant="destructive">
              <AlertTitle>{m.settings_failed_title()}</AlertTitle>
              <AlertDescription>{m.settings_failed_text()}</AlertDescription>
            </Alert>
          ) : null}
          {!isPending && !isError && visiblePages.every((page) => page.collections.length === 0) ? (
            <p className="text-sm text-muted-foreground">{m.settings_privacy_empty()}</p>
          ) : null}
          {visiblePages.map((page, index) => (
            <ul key={index} className="space-y-3">
              {page.collections.map((collection) => (
                <CollectionRow key={collection.id} collection={collection} />
              ))}
            </ul>
          ))}
          {visiblePages.at(-1)?.next ? (
            <Button type="button" variant="outline" disabled={loadingMore} onClick={() => void more()}>
              {loadingMore ? m.settings_privacy_loading() : m.settings_privacy_load_more()}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

// The generated client type is represented by this owner projection at the settings boundary.
