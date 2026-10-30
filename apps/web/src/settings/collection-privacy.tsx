import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useOperation } from '../kernel/exposure';
import { useSession } from '../session/query';
import type { CollectionVisibility } from '../library/reads';
import { csrfHeaders } from '../threads/composer';
import { readOwnedCollection, readOwnedCollectionsPage, saveCollectionVisibility } from './actions';
import type { OwnedCollection } from './preferences';
import type { CollectionPrivacyFailure } from './collection-privacy-data';
import {
  CollectionPrivacyEditor,
  CollectionPrivacyPager,
  type CollectionPrivacyIO,
  type CollectionPrivacyPageRead,
} from './collection-privacy-recovery';

const visibilityOptions = ['private', 'unlisted', 'public'] as const;
const nativeIO: CollectionPrivacyIO = {
  save: (data) => saveCollectionVisibility({ data, headers: csrfHeaders() }),
  read: (data) => readOwnedCollection({ data }),
};
const nativePageRead: CollectionPrivacyPageRead = (data) => readOwnedCollectionsPage({ data });

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
function failureText(failure: CollectionPrivacyFailure | 'invalid' | undefined | null) {
  return failure === 'closed'
    ? m.settings_privacy_closed()
    : failure === 'forbidden'
      ? m.settings_privacy_forbidden()
      : failure === 'invalid'
        ? m.settings_privacy_refused()
        : m.settings_privacy_unavailable();
}

export function CollectionRow({
  collection,
  io = nativeIO,
}: {
  collection: OwnedCollection;
  io?: CollectionPrivacyIO;
}) {
  const { csrfToken } = useSession();
  const canSave = useOperation('collection.update');
  const canRead = useOperation('collection.get');
  const [editor] = useState(() => new CollectionPrivacyEditor(collection, io));
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  useEffect(() => () => editor.dispose(), [editor]);
  const id = useId();
  const busy = state.phase === 'saving' || state.phase === 'reloading';
  const { current, desired, phase } = state;
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
        <p id={`${id}-current`} className="mt-1 text-sm text-muted-foreground">
          {m.settings_privacy_current({ visibility: label(current.visibility) })}
        </p>
      </div>
      <ListRowControl>
        <Field>
          <FieldLabel htmlFor={id}>{m.settings_privacy_visibility_label()}</FieldLabel>
          <NativeSelect
            id={id}
            value={desired}
            aria-describedby={`${id}-current`}
            disabled={!csrfToken || !canSave}
            onChange={(event) => {
              const value = visibilityOptions.find((option) => option === event.target.value);
              if (value) void editor.edit(value);
            }}
          >
            {visibilityOptions.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {label(value)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </ListRowControl>
      <ListRowControl className="sm:col-span-2">
        <div aria-live="polite" aria-atomic="true" className="space-y-3">
          {busy ? (
            <p role="status" className="text-sm text-muted-foreground">
              {phase === 'saving' ? m.settings_saving() : m.settings_privacy_reading()}
            </p>
          ) : null}
          {phase === 'saved' ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m.settings_saved()}
            </p>
          ) : null}
          {['uncertain', 'conflict', 'refused', 'review'].includes(phase) ? (
            <Alert variant={phase === 'uncertain' || phase === 'refused' ? 'destructive' : 'default'}>
              <AlertTitle>
                {phase === 'uncertain'
                  ? m.settings_privacy_uncertain_title()
                  : phase === 'conflict'
                    ? m.settings_privacy_conflict_title()
                    : phase === 'review'
                      ? m.settings_privacy_review_title()
                      : m.settings_failed_title()}
              </AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  {phase === 'uncertain'
                    ? m.settings_privacy_uncertain_text()
                    : phase === 'conflict'
                      ? m.settings_privacy_conflict_text()
                      : phase === 'review'
                        ? m.settings_privacy_review_text()
                        : failureText(state.failure)}
                </p>
                {state.failure && phase !== 'refused' ? <p>{failureText(state.failure)}</p> : null}
                <div className="flex flex-wrap gap-2">
                  {phase === 'uncertain' ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!csrfToken || !canSave || busy}
                      onClick={() => void editor.retry()}
                    >
                      {m.settings_privacy_retry_original()}
                    </Button>
                  ) : null}
                  {phase === 'review' && desired !== current.visibility ? (
                    <Button
                      type="button"
                      disabled={!csrfToken || !canSave || busy}
                      onClick={() => void editor.submit()}
                    >
                      {m.settings_privacy_save_choice()}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!canRead || busy}
                    onClick={() => void editor.reload()}
                  >
                    {m.settings_privacy_reload_row()}
                  </Button>
                </div>
                <p>{m.settings_privacy_reload_discards()}</p>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </ListRowControl>
    </ListRow>
  );
}

/** Mounts afresh whenever the prepared account or operation admission changes. */
export function CollectionPrivacySection() {
  const admitted = useOperation('account.collections');
  const { state, subject } = useSession();
  return admitted && state === 'signed-in' && subject ? <CollectionPrivacyView key={subject} /> : null;
}

export function CollectionPrivacyView({
  read = nativePageRead,
  io = nativeIO,
}: {
  read?: CollectionPrivacyPageRead;
  io?: CollectionPrivacyIO;
}) {
  const [pager] = useState(() => new CollectionPrivacyPager(read));
  const state = useSyncExternalStore(pager.subscribe, pager.snapshot, pager.snapshot);
  useEffect(() => {
    void pager.load();
    return pager.dispose;
  }, [pager]);
  return (
    <section id="privacy" aria-labelledby="settings-privacy-heading" className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id="settings-privacy-heading">{m.settings_privacy_heading()}</h2>
          </CardTitle>
          <CardDescription>
            {m.settings_privacy_text()} {m.settings_privacy_members()}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.loading ? <p role="status">{m.settings_privacy_loading()}</p> : null}
          {state.failure ? (
            <Alert variant="destructive">
              <AlertTitle>{m.settings_failed_title()}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{failureText(state.failure)}</p>
                <Button type="button" variant="outline" disabled={state.loading} onClick={() => void pager.load()}>
                  {m.settings_retry()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {state.loaded && !state.failure && state.collections.length === 0 && state.next === null ? (
            <p className="text-sm text-muted-foreground">{m.settings_privacy_empty()}</p>
          ) : null}
          <ul className="space-y-3">
            {state.collections.map((collection) => (
              <CollectionRow key={collection.id} collection={collection} io={io} />
            ))}
          </ul>
          {state.next !== null && !state.failure ? (
            <Button type="button" variant="outline" disabled={state.loading} onClick={() => void pager.load()}>
              {state.loading ? m.settings_privacy_loading() : m.settings_privacy_load_more()}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
