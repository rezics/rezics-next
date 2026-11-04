import { documentText } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type { SavedWriting } from '../local-writing-draft';
import { OwnDraftEditor } from './editor';
import {
  admittedOwnDraftAction,
  documentForInspection,
  indexOwnDraftPage,
  ownDraftIdentityKey,
  ownDraftRequestKey,
  readSelectedOwnDraft,
  type OwnDraftEntry,
  type OwnDraftCommands,
  type OwnDraftIdentity,
  type OwnDraftIndex,
  type OwnDraftLocalWritingReader,
  type OwnDraftLocale,
  type OwnDraftPageData,
  type OwnDraftReadback,
  type OwnDraftReader,
  type OwnDraftSelection,
} from './model';

type PageState =
  | { requestKey: string; state: 'loading' }
  | { requestKey: string; state: 'unavailable' | 'denied' | 'concealed' | 'stale' }
  | { requestKey: string; state: 'ready' | 'preparing'; page: OwnDraftPageData; index: OwnDraftIndex };

type SelectionState =
  | { identityKey: string; entry: OwnDraftEntry; state: 'loading' }
  | { identityKey: string; entry: OwnDraftEntry; state: 'unavailable' }
  | { identityKey: string; state: 'concealed' | 'stale' }
  | { identityKey: string; entry: OwnDraftEntry; state: 'ready'; selection: OwnDraftSelection };

type LocalWritingState =
  | null
  | { key: string; state: 'loading' | 'none' | 'unavailable' }
  | { key: string; state: 'ready'; writing: SavedWriting };
type EraseIntent = Readonly<{
  postId: string;
  threadId: string;
  opening: boolean;
  revisionId: string;
  idempotencyKey: string;
  title: string;
}>;
type EraseState =
  | { state: 'review' | 'sending' | 'uncertain'; intent: EraseIntent }
  | { state: 'refused'; reason: string };
type CommandFeedback = {
  action: 'save' | 'publish' | 'erase';
  postId: string;
  state: 'acknowledged' | 'reading' | 'readback';
  readback?: OwnDraftReadback;
};

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

function OwnDraftCommandFeedback({
  feedback,
  id,
  locale,
  onReadback,
}: {
  feedback: CommandFeedback;
  id: string;
  locale: OwnDraftLocale;
  onReadback: () => void;
}) {
  const acknowledgement =
    feedback.action === 'save'
      ? m.own_drafts_ack_save({}, { locale })
      : feedback.action === 'publish'
        ? m.own_drafts_ack_publish({}, { locale })
        : m.own_drafts_ack_erase({}, { locale });
  return (
    <section id={id} tabIndex={-1} className="space-y-2 rounded-lg border border-border p-4" aria-live="polite">
      {feedback.state === 'acknowledged' ? <p role="status">{acknowledgement}</p> : null}
      {feedback.state === 'reading' ? <p role="status">{m.own_drafts_readback_reading({}, { locale })}</p> : null}
      {feedback.state === 'acknowledged' ? (
        <Button type="button" className={control} onClick={onReadback}>
          {m.own_drafts_readback({}, { locale })}
        </Button>
      ) : null}
      {feedback.state === 'readback' &&
      typeof feedback.readback === 'object' &&
      feedback.readback.state === 'available' ? (
        <>
          <p role="status">
            {(feedback.readback.visibility === 'published'
              ? m.own_drafts_readback_published
              : feedback.readback.visibility === 'draft'
                ? m.own_drafts_readback_draft
                : m.own_drafts_readback_other)({ revision: feedback.readback.revision }, { locale })}
          </p>
          {feedback.readback.body ? (
            <article className="rounded-md border border-border/60 p-3 [overflow-wrap:anywhere]">
              <pre className="whitespace-pre-wrap font-sans">{documentText(feedback.readback.body)}</pre>
            </article>
          ) : null}
        </>
      ) : null}
      {feedback.state === 'readback' &&
      !(typeof feedback.readback === 'object' && feedback.readback.state === 'available') ? (
        <p role="status">{m.own_drafts_readback_no_proof({}, { locale })}</p>
      ) : null}
    </section>
  );
}

export function OwnDraftsPage({
  identity,
  active,
  reader,
  localWritingReader,
  commands,
}: {
  identity: OwnDraftIdentity;
  active: boolean;
  reader: OwnDraftReader;
  localWritingReader?: OwnDraftLocalWritingReader;
  commands?: OwnDraftCommands;
}) {
  const binding = useRef({ reader, localWritingReader, commands, active, generation: 0 });
  if (
    binding.current.reader !== reader ||
    binding.current.localWritingReader !== localWritingReader ||
    binding.current.commands !== commands ||
    binding.current.active !== active
  )
    binding.current = { reader, localWritingReader, commands, active, generation: binding.current.generation + 1 };
  return (
    <BoundOwnDraftsPage
      key={JSON.stringify([ownDraftIdentityKey(identity), binding.current.generation])}
      identity={identity}
      active={active}
      reader={reader}
      {...(localWritingReader ? { localWritingReader } : {})}
      {...(commands ? { commands } : {})}
    />
  );
}

function BoundOwnDraftsPage({
  identity,
  active,
  reader,
  localWritingReader,
  commands,
}: {
  identity: OwnDraftIdentity;
  active: boolean;
  reader: OwnDraftReader;
  localWritingReader?: OwnDraftLocalWritingReader;
  commands?: OwnDraftCommands;
}) {
  const locale = identity.locale;
  const identityKey = ownDraftIdentityKey(identity);
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;
  const listController = useRef<AbortController | null>(null);
  const selectionController = useRef<AbortController | null>(null);
  const localWritingController = useRef<AbortController | null>(null);
  const commandController = useRef<AbortController | null>(null);
  const eraseController = useRef<AbortController | null>(null);
  const selectionGeneration = useRef(0);
  const controlId = useId();
  const selectionHeading = useRef<HTMLHeadingElement>(null);
  const inventoryHeading = useRef<HTMLHeadingElement>(null);
  const recoveryFocus = useRef<string | null>(null);
  const returnFocus = useRef<{ key: string; id: string } | null>(null);
  const [cursor, setCursor] = useState<{ key: string; value: string | null }>({ key: identityKey, value: null });
  const currentCursor = cursor.key === identityKey ? cursor.value : null;
  const requestKey = ownDraftRequestKey(identityKey, currentCursor);
  const [retry, setRetry] = useState(0);
  const [pageState, setPageState] = useState<PageState | null>(null);
  const [selectionState, setSelectionState] = useState<SelectionState | null>(null);
  const [localWritingState, setLocalWritingState] = useState<LocalWritingState>(null);
  const [editingSource, setEditingSource] = useState<'server' | 'browser' | null>(null);
  const [eraseState, setEraseState] = useState<EraseState | null>(null);
  const [commandFeedback, setCommandFeedback] = useState<CommandFeedback | null>(null);
  const erasePending = useRef(false);
  const page = active && pageState?.requestKey === requestKey ? pageState : null;
  const selection = active && page && selectionState?.identityKey === identityKey ? selectionState : null;
  const admission = useRef({ active, reader, localWritingReader, commands, requestKey });
  admission.current = { active, reader, localWritingReader, commands, requestKey };
  const retired = useRef(false);
  // Command authority follows the private reader boundary, never its inventory cursor.
  const commandCurrent = () =>
    !retired.current &&
    identityRef.current === identityKey &&
    admission.current.active &&
    admission.current.reader === reader &&
    admission.current.localWritingReader === localWritingReader &&
    admission.current.commands === commands;
  const current = () => commandCurrent() && admission.current.requestKey === requestKey;
  const nativeEpoch = useRef<{ identityKey: string; value: number | null }>({ identityKey, value: null });
  if (nativeEpoch.current.identityKey !== identityKey) nativeEpoch.current = { identityKey, value: null };

  useLayoutEffect(() => {
    admission.current.active = active;
    return () => {
      // Retirement must abort a selected read even when only its promise remains mounted.
      admission.current.active = false;
      listController.current?.abort();
      selectionController.current?.abort();
      localWritingController.current?.abort();
      commandController.current?.abort();
      eraseController.current?.abort();
      erasePending.current = false;
      selectionGeneration.current++;
      returnFocus.current = null;
    };
  }, [active]);

  useEffect(() => {
    if (!active) {
      listController.current?.abort();
      selectionController.current?.abort();
      localWritingController.current?.abort();
      commandController.current?.abort();
      eraseController.current?.abort();
      erasePending.current = false;
      selectionGeneration.current++;
      returnFocus.current = null;
      setPageState(null);
      setSelectionState(null);
      setLocalWritingState(null);
      setEditingSource(null);
      setEraseState(null);
      setCommandFeedback(null);
      return;
    }
    const controller = new AbortController();
    listController.current?.abort();
    selectionController.current?.abort();
    localWritingController.current?.abort();
    selectionGeneration.current++;
    listController.current = controller;
    setPageState({ requestKey, state: 'loading' });
    setSelectionState(null);
    setLocalWritingState(null);
    setEditingSource(null);
    clearResolvedErase();
    void reader
      .list(
        { accountId: identity.accountId, ...(currentCursor === null ? {} : { cursor: currentCursor }) },
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted || !current() || identityRef.current !== identityKey) return;
        if (typeof result === 'string') {
          if (result === 'denied') retireCommands();
          setPageState({ requestKey, state: result });
          return;
        }
        if (
          result.viewer.accountId !== identity.accountId ||
          (identity.authnEpoch !== 0 && result.viewer.authnEpoch !== identity.authnEpoch) ||
          (nativeEpoch.current.value !== null && result.viewer.authnEpoch !== nativeEpoch.current.value)
        ) {
          retireCommands();
          selectionGeneration.current++;
          returnFocus.current = null;
          setSelectionState(null);
          setLocalWritingState(null);
          setEditingSource(null);
          setPageState({ requestKey, state: 'denied' });
          return;
        }
        nativeEpoch.current = { identityKey, value: result.viewer.authnEpoch };
        setPageState({ requestKey, state: result.state, page: result, index: indexOwnDraftPage(result) });
      })
      .catch(() => {
        if (!controller.signal.aborted && current() && identityRef.current === identityKey)
          setPageState({ requestKey, state: 'unavailable' });
      });
    return () => controller.abort();
  }, [active, currentCursor, identity.accountId, identity.authnEpoch, identityKey, reader, requestKey, retry]);

  const readySelection = selection?.state === 'ready' ? selection : null;
  const editorAdmission = useRef({ selection: readySelection?.selection, source: editingSource });
  editorAdmission.current = { selection: readySelection?.selection, source: editingSource };
  const localWritingKey = readySelection
    ? JSON.stringify([identityKey, readySelection.entry.id, readySelection.selection.revision])
    : null;
  const localWriting = localWritingState?.key === localWritingKey ? localWritingState : null;
  useEffect(() => {
    if (!readySelection || !localWritingReader || !active) {
      localWritingController.current?.abort();
      setLocalWritingState(null);
      return;
    }
    const controller = new AbortController();
    localWritingController.current?.abort();
    localWritingController.current = controller;
    const key = localWritingKey!;
    setLocalWritingState({ key, state: 'loading' });
    void localWritingReader
      .load({ identity, entry: readySelection.entry, selection: readySelection.selection }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || !current() || identityRef.current !== identityKey) return;
        setLocalWritingState(
          result === 'unavailable'
            ? { key, state: 'unavailable' }
            : result
              ? { key, state: 'ready', writing: result }
              : { key, state: 'none' },
        );
      })
      .catch(() => {
        if (!controller.signal.aborted && current() && identityRef.current === identityKey)
          setLocalWritingState({ key, state: 'unavailable' });
      });
    return () => controller.abort();
  }, [active, identity, identityKey, localWritingKey, localWritingReader, readySelection]);

  useLayoutEffect(() => {
    const pending = returnFocus.current;
    if (!selection && pending?.key === identityKey) {
      returnFocus.current = null;
      (document.getElementById(pending.id) ?? inventoryHeading.current)?.focus();
    }
  }, [identityKey, selection]);

  useLayoutEffect(() => {
    if (eraseState?.state === 'review') document.getElementById(`${controlId}-erase-cancel`)?.focus();
    else if (recoveryFocus.current) {
      document.getElementById(recoveryFocus.current)?.focus();
      recoveryFocus.current = null;
    }
  }, [editingSource, eraseState, commandFeedback, controlId]);

  const clearResolvedErase = () => {
    setEraseState((previous) => (previous?.state === 'sending' || previous?.state === 'uncertain' ? previous : null));
  };

  const retireCommands = () => {
    retired.current = true;
    selectionController.current?.abort();
    localWritingController.current?.abort();
    commandController.current?.abort();
    eraseController.current?.abort();
    erasePending.current = false;
    setEraseState(null);
    setCommandFeedback(null);
  };

  const leaveCommandPresentation = () => {
    clearResolvedErase();
    if (commandFeedback?.action !== 'erase') {
      commandController.current?.abort();
      setCommandFeedback(null);
    }
  };

  const cancelErase = () => {
    if (eraseState?.state !== 'review') return;
    recoveryFocus.current = `${controlId}-erase`;
    setEraseState(null);
  };

  const selectedId = selection && 'entry' in selection ? selection.entry.id : null;
  useLayoutEffect(() => {
    if (selection) selectionHeading.current?.focus();
  }, [selectedId]);

  const open = (entry: OwnDraftEntry) => {
    if (!admittedOwnDraftAction(entry, identity.accountId, 'resume')) return;
    listController.current?.abort();
    selectionController.current?.abort();
    localWritingController.current?.abort();
    const controller = new AbortController();
    selectionController.current = controller;
    const generation = ++selectionGeneration.current;
    returnFocus.current = { key: identityKey, id: `${controlId}-${entry.id}` };
    setSelectionState({ identityKey, entry, state: 'loading' });
    setLocalWritingState(null);
    setEditingSource(null);
    leaveCommandPresentation();
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
            retireCommands();
            setSelectionState(null);
            setPageState({ requestKey, state: 'denied' });
            return;
          }
          if (result === 'unavailable') {
            setSelectionState({ identityKey, entry, state: 'unavailable' });
          } else {
            // A changed or concealed head retires its metadata and action advice as well as its bytes.
            setPageState({ requestKey, state: 'unavailable' });
            setSelectionState({ identityKey, state: result === 'stale' ? 'stale' : 'concealed' });
          }
          return;
        }
        setSelectionState({ identityKey, entry, state: 'ready', selection: result });
      })
      .catch(() => {
        if (
          !controller.signal.aborted &&
          current() &&
          identityRef.current === identityKey &&
          selectionGeneration.current === generation
        )
          setSelectionState({ identityKey, entry, state: 'unavailable' });
      });
  };

  const closeSelection = () => {
    selectionController.current?.abort();
    localWritingController.current?.abort();
    selectionGeneration.current++;
    setSelectionState(null);
    setLocalWritingState(null);
    setEditingSource(null);
    leaveCommandPresentation();
  };

  const retrySelection = () => {
    if (selection?.state === 'unavailable') open(selection.entry);
  };

  const continuePage = () => {
    if (!page || (page.state !== 'ready' && page.state !== 'preparing')) return;
    if (page.page.next === null) return;
    selectionController.current?.abort();
    localWritingController.current?.abort();
    selectionGeneration.current++;
    setSelectionState(null);
    setLocalWritingState(null);
    setEditingSource(null);
    leaveCommandPresentation();
    setCursor({ key: identityKey, value: page.page.next });
  };

  const restart = () => {
    selectionController.current?.abort();
    localWritingController.current?.abort();
    selectionGeneration.current++;
    setSelectionState(null);
    setLocalWritingState(null);
    setEditingSource(null);
    leaveCommandPresentation();
    setCursor({ key: identityKey, value: null });
    setRetry((value) => value + 1);
  };

  const retryPage = () => setRetry((value) => value + 1);

  const retireRevision = () => {
    closeSelection();
    setPageState({ requestKey, state: 'unavailable' });
    setSelectionState({ identityKey, state: 'stale' });
    setCommandFeedback(null);
  };

  const startEditor = (source: 'server' | 'browser') => {
    if (
      !readySelection ||
      !commands ||
      !commandCurrent() ||
      eraseState?.state === 'uncertain' ||
      eraseState?.state === 'sending'
    )
      return;
    if (!admittedOwnDraftAction(readySelection.entry, identity.accountId, 'edit')) return;
    if (source === 'browser' && (localWritingState?.state !== 'ready' || localWritingState.writing.state !== 'unsent'))
      return;
    setEditingSource(source);
  };

  const acknowledged = (action: 'save' | 'publish') => {
    const entry = readySelection?.entry;
    if (!entry || !current()) return;
    selectionController.current?.abort();
    localWritingController.current?.abort();
    selectionGeneration.current++;
    setEditingSource(null);
    setSelectionState(null);
    setLocalWritingState(null);
    setEraseState(null);
    setPageState({ requestKey, state: 'unavailable' });
    setCommandFeedback({ action, postId: entry.id, state: 'acknowledged' });
  };

  const checkCurrent = () => {
    if (!commands || !commandFeedback || !commandCurrent()) return;
    commandController.current?.abort();
    const controller = new AbortController();
    commandController.current = controller;
    const { postId } = commandFeedback;
    setCommandFeedback({ ...commandFeedback, state: 'reading' });
    void commands
      .readback(postId, controller.signal)
      .then((readback) => {
        if (controller.signal.aborted || !commandCurrent() || identityRef.current !== identityKey) return;
        setCommandFeedback((previous) =>
          previous?.postId === postId ? { ...previous, state: 'readback', readback } : previous,
        );
      })
      .catch(() => {
        if (!controller.signal.aborted && commandCurrent() && identityRef.current === identityKey)
          setCommandFeedback((previous) =>
            previous?.postId === postId ? { ...previous, state: 'readback', readback: 'unavailable' } : previous,
          );
      });
  };

  const beginEraseReview = () => {
    if (
      !readySelection ||
      !commands ||
      !commandCurrent() ||
      !admittedOwnDraftAction(readySelection.entry, identity.accountId, 'erase') ||
      eraseState?.state === 'uncertain' ||
      eraseState?.state === 'sending'
    )
      return;
    commandController.current?.abort();
    setCommandFeedback(null);
    setEraseState({
      state: 'review',
      intent: {
        postId: readySelection.entry.id,
        threadId: readySelection.entry.threadId,
        opening: readySelection.entry.documentKind === 'opening',
        revisionId: readySelection.selection.revision,
        idempotencyKey: crypto.randomUUID(),
        title: readySelection.entry.title ?? m.own_drafts_no_title({}, { locale }),
      },
    });
  };

  const submitErase = () => {
    if (
      !commands ||
      !eraseState ||
      (eraseState.state !== 'review' && eraseState.state !== 'uncertain') ||
      erasePending.current ||
      !commandCurrent()
    )
      return;
    const intent = eraseState.intent;
    erasePending.current = true;
    eraseController.current?.abort();
    const controller = new AbortController();
    eraseController.current = controller;
    recoveryFocus.current = `${controlId}-command-result`;
    setEraseState({ state: 'sending', intent });
    void commands
      .erase(
        {
          postId: intent.postId,
          threadId: intent.threadId,
          opening: intent.opening,
          revisionId: intent.revisionId,
          idempotencyKey: intent.idempotencyKey,
        },
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted || !commandCurrent() || identityRef.current !== identityKey) return;
        if ([`${controlId}-erase-confirm`, `${controlId}-erase-retry`].includes(document.activeElement?.id ?? ''))
          recoveryFocus.current = `${controlId}-command-result`;
        if (result.ok) {
          listController.current?.abort();
          selectionController.current?.abort();
          localWritingController.current?.abort();
          selectionGeneration.current++;
          setSelectionState(null);
          setLocalWritingState(null);
          setEditingSource(null);
          setEraseState(null);
          setPageState({ requestKey: admission.current.requestKey, state: 'unavailable' });
          setCommandFeedback({ action: 'erase', postId: intent.postId, state: 'acknowledged' });
        } else if (result.reason === 'unavailable') {
          setEraseState({ state: 'uncertain', intent });
        } else {
          setEraseState({ state: 'refused', reason: result.reason });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && commandCurrent() && identityRef.current === identityKey)
          setEraseState({ state: 'uncertain', intent });
      })
      .finally(() => {
        if (!controller.signal.aborted && commandCurrent() && identityRef.current === identityKey)
          erasePending.current = false;
      });
  };

  const eraseRecovery =
    eraseState && eraseState.state !== 'review' ? (
      <section
        id={`${controlId}-command-result`}
        tabIndex={-1}
        aria-labelledby={`${controlId}-erase-recovery`}
        className="space-y-2 rounded-lg border border-border p-4"
      >
        <h2 id={`${controlId}-erase-recovery`} className="font-semibold">
          {m.own_drafts_erase({}, { locale })}
          {'intent' in eraseState ? `: ${eraseState.intent.title}` : null}
        </h2>
        {'intent' in eraseState ? (
          <p className="text-sm [overflow-wrap:anywhere]">
            {m.own_drafts_revision({}, { locale })}: {eraseState.intent.revisionId}
          </p>
        ) : null}
        {eraseState.state === 'sending' ? (
          <p role="status">{m.own_drafts_erase_sending({}, { locale })}</p>
        ) : eraseState.state === 'uncertain' ? (
          <div role="alert" className="space-y-2">
            <p>{m.own_drafts_command_unknown({}, { locale })}</p>
            <Button id={`${controlId}-erase-retry`} type="button" className={control} onClick={submitErase}>
              {m.own_drafts_retry_erase({}, { locale })}
            </Button>
          </div>
        ) : eraseState.state === 'refused' ? (
          <div role="alert" className="space-y-2">
            <p>
              {eraseState.reason === 'conflict'
                ? m.own_drafts_command_conflict({}, { locale })
                : m.thread_delete_failure({}, { locale })}
            </p>
            {eraseState.reason === 'conflict' ? (
              <Button type="button" variant="outline" className={control} onClick={restart}>
                {m.own_drafts_restart({}, { locale })}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
    ) : null;
  const feedback =
    commandFeedback && commands ? (
      <OwnDraftCommandFeedback
        id={`${controlId}-command-result`}
        feedback={commandFeedback}
        locale={locale}
        onReadback={checkCurrent}
      />
    ) : null;

  if (!active) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6">
        <h1 ref={inventoryHeading} tabIndex={-1} className="text-2xl font-semibold">
          {m.own_drafts_title({}, { locale })}
        </h1>
        <p role="status">{m.own_drafts_sign_in({}, { locale })}</p>
      </main>
    );
  }

  if (selection) {
    const title =
      selection.state === 'ready'
        ? (selection.entry.title ?? m.own_drafts_no_title({}, { locale }))
        : m.own_drafts_title({}, { locale });
    return (
      <main className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6" aria-busy={selection.state === 'loading'}>
        <Button type="button" variant="outline" className={control} onClick={closeSelection}>
          {m.own_drafts_return({}, { locale })}
        </Button>
        <h1 ref={selectionHeading} tabIndex={-1} className="text-2xl font-semibold">
          {title}
        </h1>
        {eraseRecovery}
        {feedback}
        {selection.state === 'ready' ? (
          <>
            <p className="text-sm text-muted-foreground">
              {kindLabel(selection.entry, locale)} · {documentKindLabel(selection.entry, locale)} ·{' '}
              <a className="underline" href={`/boards/${selection.entry.board.id}`}>
                {selection.entry.board.title ?? m.own_drafts_board_unavailable({}, { locale })}
              </a>
            </p>
            <p className="text-sm text-muted-foreground">
              {m.own_drafts_language({}, { locale })}:{' '}
              {selection.entry.language ?? m.own_drafts_language_unknown({}, { locale })}
              {' · '}
              {m.own_drafts_licence({}, { locale })}: {selection.entry.licence}
            </p>
            <p className="text-sm text-muted-foreground">
              {m.own_drafts_revision({}, { locale })}: {selection.entry.revisionId}
            </p>
          </>
        ) : null}
        {selection.state === 'loading' ? <p role="status">{m.own_drafts_opening_selection({}, { locale })}</p> : null}
        {selection.state === 'concealed' ? (
          <p role="status">{m.own_drafts_selection_unavailable({}, { locale })}</p>
        ) : null}
        {selection.state === 'stale' ? (
          <div className="space-y-2" role="status">
            <p>{m.own_drafts_stale_selection({}, { locale })}</p>
            <Button type="button" className={control} onClick={restart}>
              {m.own_drafts_restart({}, { locale })}
            </Button>
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
          <>
            {editingSource && commands ? (
              <OwnDraftEditor
                identity={identity}
                entry={selection.entry}
                selection={selection.selection}
                source={editingSource}
                browserWriting={localWriting?.state === 'ready' ? localWriting.writing : null}
                commands={commands}
                authority={selection.selection}
                current={() =>
                  current() &&
                  editorAdmission.current.selection === selection.selection &&
                  editorAdmission.current.source === editingSource
                }
                onRevisionReplacement={retireRevision}
                onCancel={() => {
                  recoveryFocus.current = `${controlId}-${editingSource}-source`;
                  setEditingSource(null);
                }}
                onAcknowledged={acknowledged}
              />
            ) : (
              <>
                <article className="min-w-0 rounded-lg border border-border p-4 [overflow-wrap:anywhere]">
                  <h2 className="sr-only">{m.own_drafts_body_heading({}, { locale })}</h2>
                  <pre className="whitespace-pre-wrap font-sans">
                    {documentText(documentForInspection(selection.selection))}
                  </pre>
                  <section className="mt-5 space-y-2" aria-label={m.own_drafts_subjects({}, { locale })}>
                    <h3 className="font-medium">{m.own_drafts_subjects({}, { locale })}</h3>
                    {selection.entry.subjectIds.length ? (
                      <ul className="flex flex-wrap gap-2">
                        {selection.entry.subjectIds.map((id) => (
                          <li key={id}>
                            <a className="underline" href={`/subjects/${id}`}>
                              {id}
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>{m.own_drafts_no_references({}, { locale })}</p>
                    )}
                  </section>
                  <section className="mt-4 space-y-2" aria-label={m.own_drafts_media({}, { locale })}>
                    <h3 className="font-medium">{m.own_drafts_media({}, { locale })}</h3>
                    {selection.entry.mediaIds.length ? (
                      <ul className="flex flex-wrap gap-2">
                        {selection.entry.mediaIds.map((id) => (
                          <li key={id}>{id}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>{m.own_drafts_no_references({}, { locale })}</p>
                    )}
                  </section>
                </article>
                <section className="space-y-3 rounded-lg border border-border p-4">
                  <h2 className="font-medium">{m.own_drafts_choose_body({}, { locale })}</h2>
                  <p className="text-sm text-muted-foreground">{m.own_drafts_body_choice_hint({}, { locale })}</p>
                  {commands && admittedOwnDraftAction(selection.entry, identity.accountId, 'edit') ? (
                    <Button
                      type="button"
                      className={control}
                      disabled={eraseState?.state === 'uncertain' || eraseState?.state === 'sending'}
                      id={`${controlId}-server-source`}
                      onClick={() => startEditor('server')}
                    >
                      {m.own_drafts_use_server({}, { locale })}
                    </Button>
                  ) : null}
                  {localWriting?.state === 'loading' ? (
                    <p role="status">{m.own_drafts_browser_loading({}, { locale })}</p>
                  ) : null}
                  {localWriting?.state === 'unavailable' ? (
                    <p role="status">{m.own_drafts_browser_unavailable({}, { locale })}</p>
                  ) : null}
                  {localWriting?.state === 'ready' ? (
                    <div className="space-y-2 rounded-md bg-muted/40 p-3">
                      <p className="font-medium">{m.own_drafts_browser_source({}, { locale })}</p>
                      <p className="text-sm text-muted-foreground">
                        {m.thread_draft_dated(
                          { date: timestamp(new Date(localWriting.writing.updated).toISOString(), locale) },
                          { locale },
                        )}
                      </p>
                      {localWriting.writing.state === 'unknown' ? (
                        <p role="status">{m.thread_draft_unknown({}, { locale })}</p>
                      ) : (
                        <>
                          <pre className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                            {localWriting.writing.payload.text}
                          </pre>
                          {localWriting.writing.payload.attachmentRepair ? (
                            <p>{m.thread_draft_attachments({}, { locale })}</p>
                          ) : null}
                          {commands && admittedOwnDraftAction(selection.entry, identity.accountId, 'edit') ? (
                            <Button
                              type="button"
                              className={control}
                              disabled={eraseState?.state === 'uncertain' || eraseState?.state === 'sending'}
                              id={`${controlId}-browser-source`}
                              onClick={() => startEditor('browser')}
                            >
                              {m.own_drafts_use_browser({}, { locale })}
                            </Button>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </section>
              </>
            )}
            {commands && admittedOwnDraftAction(selection.entry, identity.accountId, 'erase') ? (
              eraseState?.state === 'review' ? (
                <section
                  role="alertdialog"
                  aria-modal="true"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelErase();
                    } else if (event.key === 'Tab') {
                      const buttons = event.currentTarget.querySelectorAll('button');
                      const target = event.shiftKey ? buttons[buttons.length - 1] : buttons[0];
                      const boundary = event.shiftKey ? buttons[0] : buttons[buttons.length - 1];
                      if (document.activeElement === boundary) {
                        event.preventDefault();
                        target?.focus();
                      }
                    }
                  }}
                  aria-labelledby={`${controlId}-erase-title`}
                  className="space-y-3 rounded-lg border border-destructive/50 p-4"
                >
                  <h2 id={`${controlId}-erase-title`} className="font-semibold">
                    {m.own_drafts_erase_review({}, { locale })}
                  </h2>
                  <p>{m.own_drafts_erase_description({}, { locale })}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className={control}
                      id={`${controlId}-erase-cancel`}
                      onClick={cancelErase}
                    >
                      {m.thread_delete_cancel({}, { locale })}
                    </Button>
                    <Button id={`${controlId}-erase-confirm`} type="button" className={control} onClick={submitErase}>
                      {m.own_drafts_erase_confirm({}, { locale })}
                    </Button>
                  </div>
                </section>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  disabled={
                    !!editingSource ||
                    eraseState?.state === 'sending' ||
                    eraseState?.state === 'uncertain' ||
                    !commandCurrent()
                  }
                  id={`${controlId}-erase`}
                  onClick={beginEraseReview}
                >
                  {m.own_drafts_erase({}, { locale })}
                </Button>
              )
            ) : null}
          </>
        ) : null}
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6" aria-busy={!page || page.state === 'loading'}>
      <h1 ref={inventoryHeading} tabIndex={-1} className="text-2xl font-semibold">
        {m.own_drafts_title({}, { locale })}
      </h1>
      {eraseRecovery}
      {feedback}
      {!page || page.state === 'loading' ? <p role="status">{m.own_drafts_loading({}, { locale })}</p> : null}
      {page?.state === 'concealed' ? <p role="status">{m.own_drafts_selection_unavailable({}, { locale })}</p> : null}
      {page?.state === 'stale' ? (
        <div role="alert" className="space-y-2">
          <p>{m.own_drafts_restart_required({}, { locale })}</p>
          <Button type="button" className={control} onClick={restart}>
            {m.own_drafts_restart({}, { locale })}
          </Button>
        </div>
      ) : null}
      {page?.state === 'denied' ? <p role="status">{m.own_drafts_denied({}, { locale })}</p> : null}
      {page?.state === 'unavailable' ? (
        <div className="space-y-2" role="alert">
          <p>{m.own_drafts_unavailable({}, { locale })}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" className={control} onClick={retryPage}>
              {m.own_drafts_retry({}, { locale })}
            </Button>
            <Button type="button" variant="outline" className={control} onClick={restart}>
              {m.own_drafts_restart({}, { locale })}
            </Button>
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
                    {m.own_drafts_language({}, { locale })}:{' '}
                    {entry.language ?? m.own_drafts_language_unknown({}, { locale })}
                    {' · '}
                    {m.own_drafts_licence({}, { locale })}: {entry.licence}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {m.own_drafts_saved_at({}, { locale })}{' '}
                    <time dateTime={entry.savedAt}>{timestamp(entry.savedAt, locale)}</time>
                  </p>
                  <Button
                    type="button"
                    className={`${control} mt-3`}
                    id={`${controlId}-${entry.id}`}
                    disabled={!admittedOwnDraftAction(entry, identity.accountId, 'resume')}
                    onClick={() => open(entry)}
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
