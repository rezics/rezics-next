import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { EntityPicker, type EntityPickerSearch } from '@rezics/ui/entity-picker';
import { Cover } from '@rezics/ui/cover';
import { Button } from '@rezics/ui/shadcn/button';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import {
  createPublicationDraft,
  publicationSubjectSearch,
  type PublicationSend,
  type PublicationTarget,
} from './publication-subject-picker';
import type { PublicationChange } from './publication-controls';
import type { PublishedSubject } from './space';

export type { PublicationSend, PublicationTarget } from './publication-subject-picker';

export function usePublicationControls(
  realmId: string,
  send: PublicationSend,
  saved: (input: PublicationChange, target: PublicationTarget, head: string) => void,
  currentSubjects: PublishedSubject[] = [],
  enabled = true,
  reader = '',
) {
  const locale = getLocale();
  const bindings = useRef({ send, saved, currentSubjects });
  bindings.current = { send, saved, currentSubjects };
  const draft = useMemo(
    () =>
      createPublicationDraft(
        realmId,
        (input) => bindings.current.send(input),
        (input, subject, head) => bindings.current.saved(input, subject, head),
        () => bindings.current.currentSubjects,
        enabled,
      ),
    [realmId, enabled, reader, locale],
  );
  useEffect(() => {
    if (enabled) draft.activate();
    else draft.retire();
    return () => draft.retire();
  }, [draft, enabled]);
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  return {
    ...state,
    locked: !enabled || state.busy || state.outcome?.kind === 'unavailable',
    choose: draft.choose,
    change: draft.change,
    retry: draft.retry,
    review: draft.review,
    scope: `${realmId}:${reader}:${locale}`,
  };
}

export function PublicationControls({
  control,
  refresh,
  search,
}: {
  search?: EntityPickerSearch;
  control: ReturnType<typeof usePublicationControls>;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const locale = getLocale();
  const searchSubjects = useMemo(() => search ?? publicationSubjectSearch(locale), [search, locale]);
  const selected = control.target;
  return (
    <div className="space-y-3">
      <Button variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {m.realm_publication_curate()}
      </Button>
      {open ? (
        <div className="max-w-xl space-y-3 rounded-xl bg-muted/40 p-4">
          <p className="text-sm text-muted-foreground">{m.realm_publication_scope()}</p>
          <fieldset disabled={control.locked} className="space-y-3">
            {selected ? (
              <div role="group" className="flex min-w-0 items-start gap-3" aria-label={m.realm_publication_selected()}>
                <Cover
                  subject={{ id: selected.id, title: selected.title, types: selected.types }}
                  cover={selected.cover}
                  src={coverSrc}
                  size="xs"
                  decorative
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium [overflow-wrap:anywhere]">{selected.title}</p>
                  {selected.typeName ? <p className="text-xs text-muted-foreground">{selected.typeName}</p> : null}
                  <p className="text-sm text-muted-foreground">{m.realm_publication_confirm()}</p>
                </div>
                <Button variant="ghost" onClick={() => control.choose(null)}>
                  {m.realm_publication_clear()}
                </Button>
              </div>
            ) : (
              <EntityPicker
                key={control.scope}
                disabled={control.locked}
                label={m.realm_publication_choose()}
                value={[]}
                search={searchSubjects}
                src={coverSrc}
                onValueChange={(items) => {
                  const subject = items[0];
                  control.choose(
                    subject
                      ? {
                          id: subject.id,
                          title: subject.title,
                          labels: { [locale]: subject.title },
                          label: subject.title,
                          types: [...subject.types],
                          typeName: subject.typeLabel,
                          cover: subject.cover,
                        }
                      : null,
                  );
                }}
              />
            )}
            <Button disabled={!selected || control.locked} onClick={() => void control.change('publish')}>
              {m.realm_publication_publish()}
            </Button>
          </fieldset>
        </div>
      ) : null}
      {control.busy ? <p role="status">{m.realm_publication_saving()}</p> : null}
      {!control.busy && control.outcome ? (
        <div role="status" className="space-y-2 text-sm">
          {control.outcome.kind === 'saved' ? (
            <p>
              {control.action === 'publish'
                ? m.realm_publication_saved()
                : control.action === 'reject'
                  ? m.realm_publication_rejected()
                  : m.realm_publication_removed()}
            </p>
          ) : null}
          {control.outcome.kind === 'denied' ? <p>{m.realm_publication_denied()}</p> : null}
          {control.outcome.kind === 'invalid' ? <p>{m.realm_publication_invalid()}</p> : null}
          {control.outcome.kind === 'unavailable' ? (
            <>
              <p>{m.realm_publication_uncertain()}</p>
              <Button variant="outline" onClick={() => void control.retry()}>
                {m.realm_publication_retry()}
              </Button>
            </>
          ) : null}
          {control.outcome.kind === 'conflict' ? (
            <>
              <p>{m.realm_publication_conflict()}</p>
              {control.outcome.currentHead ? (
                <Button variant="outline" onClick={() => void control.review()}>
                  {control.action === 'withdraw'
                    ? m.realm_publication_review_withdraw()
                    : control.action === 'reject'
                      ? m.realm_publication_review_reject()
                      : m.realm_publication_review()}
                </Button>
              ) : (
                <p>{m.realm_publication_head_unavailable()}</p>
              )}
              <Button variant="outline" onClick={() => void refresh()}>
                {m.realm_shelf_restart()}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ShelfContinuation({
  next,
  busy,
  failure,
  load,
  label,
}: {
  next: string | null;
  busy: boolean;
  failure: 'denied' | 'unavailable' | 'stale' | null;
  load: (restart?: boolean) => Promise<void>;
  label: string;
}) {
  return (
    <div className="space-y-2" aria-busy={busy}>
      {failure ? (
        <p role="status" className="text-sm text-muted-foreground">
          {failure === 'denied'
            ? m.realm_shelf_denied()
            : failure === 'stale'
              ? m.realm_shelf_stale()
              : m.realm_shelf_unavailable()}
        </p>
      ) : null}
      {failure === 'stale' || failure === 'denied' ? (
        <Button variant="outline" disabled={busy} onClick={() => void load(true)}>
          {m.realm_shelf_restart()}
        </Button>
      ) : next ? (
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          {busy ? m.realm_shelf_loading() : label}
        </Button>
      ) : null}
    </div>
  );
}
