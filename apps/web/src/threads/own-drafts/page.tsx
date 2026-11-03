import { documentText } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import {
  admittedOwnDraftAction,
  documentForInspection,
  indexOwnDraftPage,
  ownDraftIdentityKey,
  ownDraftRequestKey,
  readSelectedOwnDraft,
  type OwnDraftEntry,
  type OwnDraftIdentity,
  type OwnDraftIndex,
  type OwnDraftLocale,
  type OwnDraftPageData,
  type OwnDraftReader,
  type OwnDraftSelection,
} from './model';

type PageState =
  | { requestKey: string; state: 'loading' }
  | { requestKey: string; state: 'unavailable' | 'denied' }
  | { requestKey: string; state: 'ready' | 'preparing'; page: OwnDraftPageData; index: OwnDraftIndex };

type SelectionState =
  | { identityKey: string; entry: OwnDraftEntry; state: 'loading' }
  | { identityKey: string; entry: OwnDraftEntry; state: 'unavailable' | 'concealed' | 'stale' }
  | { identityKey: string; entry: OwnDraftEntry; state: 'ready'; selection: OwnDraftSelection };

const control = 'min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]';

function timestamp(value: string, locale: OwnDraftLocale): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
  } catch {
    return value;
  }
}

function kindLabel(entry: OwnDraftEntry, locale: OwnDraftLocale): string {
  return entry.kind === 'review' ? m.own_drafts_review({}, { locale }) : m.own_drafts_discussion({}, { locale });
}

function documentKindLabel(entry: OwnDraftEntry, locale: OwnDraftLocale): string {
  return entry.documentKind === 'reply' ? m.own_drafts_reply({}, { locale }) : m.own_drafts_opening({}, { locale });
}

export function OwnDraftsPage({
  identity,
  active,
  reader,
}: {
  identity: OwnDraftIdentity;
  active: boolean;
  reader: OwnDraftReader;
}) {
  const locale = identity.locale;
  const identityKey = ownDraftIdentityKey(identity);
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;
  const previousIdentity = useRef(identityKey);
  const listController = useRef<AbortController | null>(null);
  const selectionController = useRef<AbortController | null>(null);
  const selectionGeneration = useRef(0);
  const returnFocus = useRef<{ key: string; button: HTMLButtonElement } | null>(null);
  const [cursor, setCursor] = useState<{ key: string; value: string | null }>({ key: identityKey, value: null });
  const currentCursor = cursor.key === identityKey ? cursor.value : null;
  const requestKey = ownDraftRequestKey(identityKey, currentCursor);
  const [retry, setRetry] = useState(0);
  const [pageState, setPageState] = useState<PageState | null>(null);
  const [selectionState, setSelectionState] = useState<SelectionState | null>(null);
  const page = active && pageState?.requestKey === requestKey ? pageState : null;
  const selection = active && selectionState?.identityKey === identityKey ? selectionState : null;

  useLayoutEffect(() => {
    if (previousIdentity.current === identityKey) return;
    previousIdentity.current = identityKey;
    listController.current?.abort();
    selectionController.current?.abort();
    selectionGeneration.current++;
    returnFocus.current = null;
    setCursor({ key: identityKey, value: null });
    setRetry(0);
    setPageState(null);
    setSelectionState(null);
  }, [identityKey]);

  useEffect(() => {
    if (!active) {
      listController.current?.abort();
      setPageState(null);
      setSelectionState(null);
      return;
    }
    const controller = new AbortController();
    listController.current?.abort();
    selectionController.current?.abort();
    selectionGeneration.current++;
    listController.current = controller;
    setPageState({ requestKey, state: 'loading' });
    setSelectionState(null);
    void reader
      .list(
        { accountId: identity.accountId, ...(currentCursor === null ? {} : { cursor: currentCursor }) },
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted || identityRef.current !== identityKey) return;
        if (typeof result === 'string') {
          setPageState({ requestKey, state: result === 'denied' ? 'denied' : 'unavailable' });
          return;
        }
        if (result.viewer.accountId !== identity.accountId || result.viewer.authnEpoch !== identity.authnEpoch) {
          setPageState({ requestKey, state: 'denied' });
          return;
        }
        setPageState({ requestKey, state: result.state, page: result, index: indexOwnDraftPage(result) });
      })
      .catch(() => {
        if (!controller.signal.aborted && identityRef.current === identityKey)
          setPageState({ requestKey, state: 'unavailable' });
      });
    return () => controller.abort();
  }, [active, currentCursor, identity.accountId, identity.authnEpoch, identityKey, reader, requestKey, retry]);

  useLayoutEffect(() => {
    const pending = returnFocus.current;
    if (!selection && pending?.key === identityKey) {
      returnFocus.current = null;
      pending.button.focus();
    }
  }, [identityKey, selection]);

  const open = (entry: OwnDraftEntry, button: HTMLButtonElement) => {
    if (!admittedOwnDraftAction(entry, identity.accountId, 'resume')) return;
    listController.current?.abort();
    selectionController.current?.abort();
    const controller = new AbortController();
    selectionController.current = controller;
    const generation = ++selectionGeneration.current;
    returnFocus.current = { key: identityKey, button };
    setSelectionState({ identityKey, entry, state: 'loading' });
    void readSelectedOwnDraft(reader, identity, entry, controller.signal)
      .then((result) => {
        if (
          controller.signal.aborted ||
          identityRef.current !== identityKey ||
          selectionGeneration.current !== generation
        )
          return;
        if (typeof result === 'string') {
          if (result === 'denied') {
            setSelectionState(null);
            setPageState({ requestKey, state: 'denied' });
            return;
          }
          setSelectionState({
            identityKey,
            entry,
            state: result === 'unavailable' || result === 'stale' ? result : 'concealed',
          });
          return;
        }
        setSelectionState({ identityKey, entry, state: 'ready', selection: result });
      })
      .catch(() => {
        if (
          !controller.signal.aborted &&
          identityRef.current === identityKey &&
          selectionGeneration.current === generation
        )
          setSelectionState({ identityKey, entry, state: 'unavailable' });
      });
  };

  const closeSelection = () => {
    selectionController.current?.abort();
    selectionGeneration.current++;
    setSelectionState(null);
  };

  const retrySelection = () => {
    if (!selection || selection.state === 'loading') return;
    const button = returnFocus.current?.button;
    if (button) open(selection.entry, button);
  };

  const continuePage = () => {
    if (!page || (page.state !== 'ready' && page.state !== 'preparing')) return;
    if (page.page.next === null) return;
    selectionController.current?.abort();
    selectionGeneration.current++;
    setSelectionState(null);
    setCursor({ key: identityKey, value: page.page.next });
  };

  const restart = () => {
    selectionController.current?.abort();
    selectionGeneration.current++;
    setSelectionState(null);
    setCursor({ key: identityKey, value: null });
    setRetry((value) => value + 1);
  };

  const retryPage = () => setRetry((value) => value + 1);

  if (!active) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6">
        <h1 className="text-2xl font-semibold">{m.own_drafts_title({}, { locale })}</h1>
        <p role="status">{m.own_drafts_sign_in({}, { locale })}</p>
      </main>
    );
  }

  if (selection) {
    const title = selection.entry.title ?? m.own_drafts_no_title({}, { locale });
    return (
      <main className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6" aria-busy={selection.state === 'loading'}>
        <Button type="button" variant="outline" className={control} onClick={closeSelection}>
          {m.own_drafts_return({}, { locale })}
        </Button>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {kindLabel(selection.entry, locale)} · {documentKindLabel(selection.entry, locale)} ·{' '}
          <a className="underline" href={`/boards/${selection.entry.board.id}`}>
            {selection.entry.board.title ?? m.own_drafts_board_unavailable({}, { locale })}
          </a>
        </p>
        <p className="text-sm text-muted-foreground">
          {m.own_drafts_language({}, { locale })}: {selection.entry.language ?? m.own_drafts_language_unknown({}, { locale })}
          {' · '}{m.own_drafts_licence({}, { locale })}: {selection.entry.licence}
        </p>
        <p className="text-sm text-muted-foreground">
          {m.own_drafts_revision({}, { locale })}: {selection.entry.revisionId}
        </p>
        {selection.state === 'loading' ? <p role="status">{m.own_drafts_opening_selection({}, { locale })}</p> : null}
        {selection.state === 'concealed' ? <p role="status">{m.own_drafts_selection_unavailable({}, { locale })}</p> : null}
        {selection.state === 'stale' ? (
          <div className="space-y-2" role="status">
            <p>{m.own_drafts_stale_selection({}, { locale })}</p>
            <Button type="button" className={control} onClick={restart}>{m.own_drafts_restart({}, { locale })}</Button>
          </div>
        ) : null}
        {selection.state === 'unavailable' ? (
          <div className="space-y-2" role="alert">
            <p>{m.own_drafts_read_failed({}, { locale })}</p>
            <Button type="button" className={control} onClick={retrySelection}>
              {m.own_drafts_retry_selection({}, { locale })}
            </Button>
          </div>
        ) : null}
        {selection.state === 'ready' ? (
          <article className="min-w-0 rounded-lg border border-border p-4 [overflow-wrap:anywhere]">
            <h2 className="sr-only">{m.own_drafts_body_heading({}, { locale })}</h2>
            <pre className="whitespace-pre-wrap font-sans">{documentText(documentForInspection(selection.selection))}</pre>
            <section className="mt-5 space-y-2" aria-label={m.own_drafts_subjects({}, { locale })}>
              <h3 className="font-medium">{m.own_drafts_subjects({}, { locale })}</h3>
              {selection.entry.subjectIds.length ? (
                <ul className="flex flex-wrap gap-2">
                  {selection.entry.subjectIds.map((id) => (
                    <li key={id}><a className="underline" href={`/subjects/${id}`}>{id}</a></li>
                  ))}
                </ul>
              ) : <p>{m.own_drafts_no_references({}, { locale })}</p>}
            </section>
            <section className="mt-4 space-y-2" aria-label={m.own_drafts_media({}, { locale })}>
              <h3 className="font-medium">{m.own_drafts_media({}, { locale })}</h3>
              {selection.entry.mediaIds.length ? (
                <ul className="flex flex-wrap gap-2">
                  {selection.entry.mediaIds.map((id) => <li key={id}>{id}</li>)}
                </ul>
              ) : <p>{m.own_drafts_no_references({}, { locale })}</p>}
            </section>
          </article>
        ) : null}
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6" aria-busy={!page || page.state === 'loading'}>
      <h1 className="text-2xl font-semibold">{m.own_drafts_title({}, { locale })}</h1>
      {!page || page.state === 'loading' ? <p role="status">{m.own_drafts_loading({}, { locale })}</p> : null}
      {page?.state === 'denied' ? <p role="status">{m.own_drafts_denied({}, { locale })}</p> : null}
      {page?.state === 'unavailable' ? (
        <div className="space-y-2" role="alert">
          <p>{m.own_drafts_unavailable({}, { locale })}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" className={control} onClick={retryPage}>{m.own_drafts_retry({}, { locale })}</Button>
            <Button type="button" variant="outline" className={control} onClick={restart}>{m.own_drafts_restart({}, { locale })}</Button>
          </div>
        </div>
      ) : null}
      {page && (page.state === 'ready' || page.state === 'preparing') ? (
        <>
          {page.state === 'preparing' ? <p role="status">{m.own_drafts_preparing({}, { locale })}</p> : null}
          {page.index.rows.length === 0 && page.page.next === null && page.state === 'ready' ? (
            <p>{m.own_drafts_empty({}, { locale })}</p>
          ) : null}
          {page.index.rows.length ? (
            <ol className="space-y-3" aria-label={m.own_drafts_title({}, { locale })}>
              {page.index.rows.map((entry) => (
                <li key={entry.id} className="min-w-0 rounded-lg border border-border p-4 [overflow-wrap:anywhere]">
                  <h2 className="text-lg font-medium">
                    <a className="underline" href={`/threads/${entry.threadId}`}>
                      {entry.title ?? m.own_drafts_no_title({}, { locale })}
                    </a>
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {kindLabel(entry, locale)} · {documentKindLabel(entry, locale)} ·{' '}
                    <a className="underline" href={`/boards/${entry.board.id}`}>
                      {entry.board.title ?? m.own_drafts_board_unavailable({}, { locale })}
                    </a>
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {m.own_drafts_language({}, { locale })}: {entry.language ?? m.own_drafts_language_unknown({}, { locale })}
                    {' · '}{m.own_drafts_licence({}, { locale })}: {entry.licence}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {m.own_drafts_saved_at({}, { locale })}{' '}
                    <time dateTime={entry.savedAt}>{timestamp(entry.savedAt, locale)}</time>
                  </p>
                  <Button
                    type="button"
                    className={`${control} mt-3`}
                    disabled={!admittedOwnDraftAction(entry, identity.accountId, 'resume')}
                    onClick={(event: MouseEvent<HTMLButtonElement>) => open(entry, event.currentTarget)}
                  >
                    {m.own_drafts_inspect({}, { locale })}
                  </Button>
                </li>
              ))}
            </ol>
          ) : null}
          {page.page.next !== null ? (
            <Button type="button" variant="outline" className={control} onClick={continuePage}>
              {m.own_drafts_continue({}, { locale })}
            </Button>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
