import { documentText } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, KeyboardEvent, MouseEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { subjectHref } from '../../subject/subject-href';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../authoring-departure';
import type { SavedWriting } from '../local-writing-draft';
import { threadHref } from '../thread-href';
import { OwnDraftEditor } from './editor';
import {
  admittedOwnDraftAction,
  documentForInspection,
  indexOwnDraftPage,
  isOwnDraftCursor,
  moveOwnDraftCoordinates,
  ownDraftIdentityKey,
  readSelectedOwnDraft,
  type OwnDraftCoordinate,
  type OwnDraftEntry,
  type OwnDraftCommands,
  type OwnDraftIdentity,
  type OwnDraftIndex,
  type OwnDraftLocalWritingReader,
  type OwnDraftLocale,
  type OwnDraftMovement,
  type OwnDraftPageData,
  type OwnDraftReadback,
  type OwnDraftReader,
  type OwnDraftSelection,
} from './model';

type PageOperation = Readonly<{ id: number; target: OwnDraftCoordinate; movement: OwnDraftMovement }>;
type PageState =
  | null
  | { state: 'loading' }
  | { state: 'unavailable' | 'denied' | 'concealed' | 'stale'; target: OwnDraftCoordinate; movement: OwnDraftMovement }
  | { state: 'ready' | 'preparing'; coordinate: OwnDraftCoordinate; page: OwnDraftPageData; index: OwnDraftIndex };

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
  intentId: number;
  action: 'save' | 'publish' | 'erase';
  postId: string;
  state: 'acknowledged' | 'reading' | 'readback';
  readback?: OwnDraftReadback;
};
type FocusHandoff = {
  operationId: number;
  origin: Element | null;
  cancelled: boolean;
  listener: (event: FocusEvent) => void;
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
  visitCurrent,
  reader,
  localWritingReader,
  commands,
}: {
  identity: OwnDraftIdentity;
  active: boolean;
  visitCurrent?: () => boolean;
  reader: OwnDraftReader;
  localWritingReader?: OwnDraftLocalWritingReader;
  commands?: OwnDraftCommands;
}) {
  const binding = useRef({ reader, localWritingReader, commands, active, visitCurrent, generation: 0 });
  if (
    binding.current.reader !== reader ||
    binding.current.localWritingReader !== localWritingReader ||
    binding.current.commands !== commands ||
    binding.current.active !== active ||
    binding.current.visitCurrent !== visitCurrent
  )
    binding.current = {
      reader,
      localWritingReader,
      commands,
      active,
      visitCurrent,
      generation: binding.current.generation + 1,
    };
  const boundaryKey = JSON.stringify([ownDraftIdentityKey(identity), binding.current.generation]);
  return (
    <AuthoringDepartureBoundary key={boundaryKey}>
      <BoundOwnDraftsPage
        identity={identity}
        active={active}
        {...(visitCurrent ? { visitCurrent } : {})}
        reader={reader}
        {...(localWritingReader ? { localWritingReader } : {})}
        {...(commands ? { commands } : {})}
      />
    </AuthoringDepartureBoundary>
  );
}

function BoundOwnDraftsPage({
  identity,
  active,
  visitCurrent,
  reader,
  localWritingReader,
  commands,
}: {
  identity: OwnDraftIdentity;
  active: boolean;
  visitCurrent?: () => boolean;
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
  const departure = useAuthoringDeparture(false, false, JSON.stringify(['own-drafts-return', identityKey]));
  const selectionHeading = useRef<HTMLHeadingElement>(null);
  const inventoryHeading = useRef<HTMLHeadingElement>(null);
  const recoveryFocus = useRef<string | null>(null);
  const returnFocus = useRef<{ key: string; id: string } | null>(null);
  const [coordinates, setCoordinates] = useState<readonly OwnDraftCoordinate[]>([null]);
  const coordinatesRef = useRef<readonly OwnDraftCoordinate[]>([null]);
  const [pageState, setPageState] = useState<PageState | null>(null);
  const [operation, setOperation] = useState<PageOperation | null>(null);
  const operationRef = useRef<PageOperation | null>(null);
  const operationSequence = useRef(0);
  const initialReadStarted = useRef(false);
  const focusHandoff = useRef<FocusHandoff | null>(null);
  const keyboardActivation = useRef<Element | null>(null);
  const [selectionState, setSelectionState] = useState<SelectionState | null>(null);
  const [localWritingState, setLocalWritingState] = useState<LocalWritingState>(null);
  const [editingSource, setEditingSource] = useState<'server' | 'browser' | null>(null);
  const [eraseState, setEraseState] = useState<EraseState | null>(null);
  const [commandFeedback, setCommandFeedback] = useState<CommandFeedback | null>(null);
  const erasePending = useRef(false);
  const page = active && (visitCurrent?.() ?? true) ? pageState : null;
  const selection =
    active && (visitCurrent?.() ?? true) && page && selectionState?.identityKey === identityKey ? selectionState : null;
  const admission = useRef({ active, reader, localWritingReader, commands, visitCurrent });
  admission.current = { active, reader, localWritingReader, commands, visitCurrent };
  const retired = useRef(false);
  const commandFeedbackSequence = useRef(0);
  const readbackSequence = useRef(0);
  // Command authority follows the private reader boundary, never its inventory cursor.
  const commandCurrent = () =>
    !retired.current &&
    identityRef.current === identityKey &&
    admission.current.active &&
    (admission.current.visitCurrent?.() ?? true) &&
    admission.current.reader === reader &&
    admission.current.localWritingReader === localWritingReader &&
    admission.current.commands === commands;
  const current = () => commandCurrent();
  const nativeEpoch = useRef<{ identityKey: string; value: number | null }>({ identityKey, value: null });
  if (nativeEpoch.current.identityKey !== identityKey) nativeEpoch.current = { identityKey, value: null };

  const clearFocusHandoff = (operationId: number, focus = false) => {
    const handoff = focusHandoff.current;
    if (!handoff || handoff.operationId !== operationId) return;
    document.removeEventListener('focusin', handoff.listener, true);
    focusHandoff.current = null;
    if (focus && !handoff.cancelled && operationRef.current?.id === operationId && commandCurrent())
      inventoryHeading.current?.focus();
  };

  const beginPageRead = (target: OwnDraftCoordinate, movement: OwnDraftMovement, keyboard = false) => {
    if (operationRef.current || !commandCurrent()) return false;
    if (target !== null && !isOwnDraftCursor(target)) return false;
    const nextOperation: PageOperation = { id: ++operationSequence.current, target, movement };
    operationRef.current = nextOperation;
    if (keyboard) {
      const handoff: FocusHandoff = {
        operationId: nextOperation.id,
        origin: document.activeElement,
        cancelled: false,
        listener: () => undefined,
      };
      handoff.listener = (event) => {
        if (focusHandoff.current === handoff && event.target !== handoff.origin && event.target !== document.body)
          handoff.cancelled = true;
      };
      focusHandoff.current = handoff;
      document.addEventListener('focusin', handoff.listener, true);
    }
    selectionController.current?.abort();
    localWritingController.current?.abort();
    selectionGeneration.current++;
    returnFocus.current = null;
    setSelectionState(null);
    setLocalWritingState(null);
    setEditingSource(null);
    setPageState({ state: 'loading' });
    setOperation(nextOperation);
    return true;
  };

  const movementKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') keyboardActivation.current = event.currentTarget;
  };
  const movementBlur = (event: ReactFocusEvent<HTMLButtonElement>) => {
    if (keyboardActivation.current === event.currentTarget) keyboardActivation.current = null;
  };
  const keyboardClick = (event: MouseEvent<HTMLButtonElement>) => {
    const keyboard = keyboardActivation.current === event.currentTarget;
    keyboardActivation.current = null;
    return keyboard;
  };
  const movementHandlers = (move: (keyboard: boolean) => void) => ({
    onKeyDown: movementKeyDown,
    onBlur: movementBlur,
    onClick: (event: MouseEvent<HTMLButtonElement>) => move(keyboardClick(event)),
  });
  const retainedCoordinate = () => coordinatesRef.current[coordinatesRef.current.length - 1] ?? null;
  const unavailableCurrentPage = () =>
    setPageState({ state: 'unavailable', target: retainedCoordinate(), movement: 'refresh' });

  useEffect(() => {
    if (!active || initialReadStarted.current) return;
    initialReadStarted.current = true;
    beginPageRead(null, 'initial');
  }, [active]);

  useEffect(() => {
    if (!active || !operation) return;
    const controller = new AbortController();
    listController.current?.abort();
    listController.current = controller;
    const ownsRequest = () => operationRef.current === operation && !controller.signal.aborted;
    const admitsReader = () => ownsRequest() && commandCurrent();
    const finish = () => {
      if (ownsRequest()) setOperation((previous) => (previous?.id === operation.id ? null : previous));
    };
    const fail = (state: 'unavailable' | 'denied' | 'concealed' | 'stale') => {
      setPageState({ state, target: operation.target, movement: operation.movement });
      clearFocusHandoff(operation.id);
    };
    const read = async () => {
      if (!admitsReader()) return;
      let result: Awaited<ReturnType<OwnDraftReader['list']>>;
      try {
        const authnEpoch = nativeEpoch.current.value ?? identity.authnEpoch;
        result = await reader.list(
          {
            accountId: identity.accountId,
            ...(authnEpoch === null ? {} : { authnEpoch }),
            ...(operation.target === null ? {} : { cursor: operation.target }),
          },
          controller.signal,
        );
      } catch {
        if (admitsReader()) fail('unavailable');
        return;
      }
      if (!admitsReader()) return;
      if (typeof result === 'string') {
        if (result === 'denied') retireCommands();
        fail(result);
        return;
      }
      const expectedEpoch = nativeEpoch.current.value ?? identity.authnEpoch;
      if (
        result.viewer.accountId !== identity.accountId ||
        !Number.isSafeInteger(result.viewer.authnEpoch) ||
        result.viewer.authnEpoch <= 0 ||
        (expectedEpoch !== null && result.viewer.authnEpoch !== expectedEpoch) ||
        (nativeEpoch.current.value !== null && result.viewer.authnEpoch !== nativeEpoch.current.value)
      ) {
        retireCommands();
        selectionGeneration.current++;
        returnFocus.current = null;
        setSelectionState(null);
        setLocalWritingState(null);
        setEditingSource(null);
        fail('denied');
        return;
      }
      let index: OwnDraftIndex;
      try {
        index = indexOwnDraftPage(result);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          ![
            'Native own-draft page exceeded its 20-row bound',
            'Native own-draft page repeated a post identity',
          ].includes(error.message)
        )
          throw error;
        fail('unavailable');
        return;
      }
      if (result.next !== null && !isOwnDraftCursor(result.next)) {
        fail('stale');
        return;
      }
      if (!admitsReader()) return;
      nativeEpoch.current = { identityKey, value: result.viewer.authnEpoch };
      const admittedCoordinates = moveOwnDraftCoordinates(coordinatesRef.current, operation.movement, operation.target);
      coordinatesRef.current = admittedCoordinates;
      setCoordinates(admittedCoordinates);
      setPageState({ state: result.state, coordinate: operation.target, page: result, index });
      clearFocusHandoff(operation.id, true);
    };
    void read().finally(finish);
    return () => {
      controller.abort();
      if (listController.current === controller) listController.current = null;
      clearFocusHandoff(operation.id);
      if (operationRef.current === operation) operationRef.current = null;
    };
  }, [active, identity.accountId, identity.authnEpoch, identityKey, operation, reader]);

  useLayoutEffect(() => {
    admission.current.active = active;
    return () => {
      // Retirement must abort a selected read even when only its promise remains mounted.
      admission.current.active = false;
      listController.current?.abort();
      selectionController.current?.abort();
      localWritingController.current?.abort();
      commandController.current?.abort();
      readbackSequence.current++;
      eraseController.current?.abort();
      erasePending.current = false;
      selectionGeneration.current++;
      returnFocus.current = null;
    };
  }, [active]);

  useEffect(() => {
    if (active) return;
    listController.current?.abort();
    selectionController.current?.abort();
    localWritingController.current?.abort();
    commandController.current?.abort();
    readbackSequence.current++;
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
  }, [active]);

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
    returnFocus.current = null;
    selectionController.current?.abort();
    localWritingController.current?.abort();
    commandController.current?.abort();
    readbackSequence.current++;
    eraseController.current?.abort();
    erasePending.current = false;
    setEraseState(null);
    setCommandFeedback(null);
  };

  const leaveCommandPresentation = () => {
    clearResolvedErase();
    if (commandFeedback?.action !== 'erase') {
      commandController.current?.abort();
      readbackSequence.current++;
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
    if (operationRef.current || !commandCurrent() || !admittedOwnDraftAction(entry, identity.accountId, 'resume'))
      return;
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
    const authnEpoch = nativeEpoch.current.value ?? identity.authnEpoch;
    void readSelectedOwnDraft(reader, { ...identity, authnEpoch }, entry, controller.signal, current)
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
            setPageState({ state: 'denied', target: retainedCoordinate(), movement: 'refresh' });
            return;
          }
          if (result === 'unavailable') {
            setSelectionState({ identityKey, entry, state: 'unavailable' });
          } else {
            // A changed or concealed head retires its metadata and action advice as well as its bytes.
            unavailableCurrentPage();
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

  const continuePage = (keyboard = false) => {
    if (!page || (page.state !== 'ready' && page.state !== 'preparing') || !isOwnDraftCursor(page.page.next)) return;
    beginPageRead(page.page.next, 'next', keyboard);
  };

  const previousPage = (keyboard = false) => {
    if (!page || (page.state !== 'ready' && page.state !== 'preparing') || coordinates.length < 2) return;
    beginPageRead(coordinates[coordinates.length - 2]!, 'previous', keyboard);
  };

  const restart = (keyboard = false) => beginPageRead(null, 'first', keyboard);

  const retryPage = (keyboard = false) => {
    if (page?.state === 'unavailable') beginPageRead(page.target, page.movement, keyboard);
  };

  const retireRevision = () => {
    closeSelection();
    unavailableCurrentPage();
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
    commandController.current?.abort();
    readbackSequence.current++;
    setCommandFeedback(null);
    setEditingSource(source);
  };

  const acknowledged = (action: 'save' | 'publish') => {
    const entry = readySelection?.entry;
    if (!entry || !current()) return;
    commandController.current?.abort();
    readbackSequence.current++;
    selectionController.current?.abort();
    localWritingController.current?.abort();
    selectionGeneration.current++;
    setEditingSource(null);
    setSelectionState(null);
    setLocalWritingState(null);
    setEraseState(null);
    if (!operationRef.current) unavailableCurrentPage();
    setCommandFeedback({
      intentId: ++commandFeedbackSequence.current,
      action,
      postId: entry.id,
      state: 'acknowledged',
    });
  };

  const checkCurrent = () => {
    if (!commands || !commandFeedback || !commandCurrent()) return;
    commandController.current?.abort();
    const controller = new AbortController();
    commandController.current = controller;
    const { postId, intentId } = commandFeedback;
    const readbackId = ++readbackSequence.current;
    setCommandFeedback({ ...commandFeedback, state: 'reading' });
    void commands
      .readback(postId, controller.signal)
      .then((readback) => {
        if (
          controller.signal.aborted ||
          !commandCurrent() ||
          identityRef.current !== identityKey ||
          readbackSequence.current !== readbackId
        )
          return;
        setCommandFeedback((previous) =>
          previous?.intentId === intentId ? { ...previous, state: 'readback', readback } : previous,
        );
      })
      .catch(() => {
        if (
          !controller.signal.aborted &&
          commandCurrent() &&
          identityRef.current === identityKey &&
          readbackSequence.current === readbackId
        )
          setCommandFeedback((previous) =>
            previous?.intentId === intentId ? { ...previous, state: 'readback', readback: 'unavailable' } : previous,
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
    readbackSequence.current++;
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
          recoveryFocus.current = `${controlId}-command-result`;
          selectionController.current?.abort();
          localWritingController.current?.abort();
          selectionGeneration.current++;
          setSelectionState(null);
          setLocalWritingState(null);
          setEditingSource(null);
          setEraseState(null);
          if (!operationRef.current) unavailableCurrentPage();
          commandController.current?.abort();
          readbackSequence.current++;
          setCommandFeedback({
            intentId: ++commandFeedbackSequence.current,
            action: 'erase',
            postId: intent.postId,
            state: 'acknowledged',
          });
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
        <h2 id={`${controlId}-erase-recovery`} className="font-semibold [overflow-wrap:anywhere]">
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
            {eraseState.reason === 'conflict' && editingSource === null ? (
              <Button type="button" variant="outline" className={control} {...movementHandlers(restart)}>
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

  if (!active || !current()) {
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
        <Button
          type="button"
          variant="outline"
          className={control}
          onClick={() => departure.requestNavigation(closeSelection)}
        >
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
              <a
                className="underline"
                href={localizeHref(`/boards/${encodeURIComponent(selection.entry.board.id)}`, { locale })}
              >
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
            <Button type="button" className={control} {...movementHandlers(restart)}>
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
                            <a
                              className="underline"
                              href={subjectHref({ id, label: '' }, locale).href}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {m.own_drafts_inspect_subject({}, { locale })}: <code>{id}</code>
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
          <Button type="button" className={control} {...movementHandlers(restart)}>
            {m.own_drafts_restart({}, { locale })}
          </Button>
        </div>
      ) : null}
      {page?.state === 'denied' ? <p role="status">{m.own_drafts_denied({}, { locale })}</p> : null}
      {page?.state === 'unavailable' ? (
        <div className="space-y-2" role="alert">
          <p>{m.own_drafts_unavailable({}, { locale })}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" className={control} {...movementHandlers(retryPage)}>
              {m.own_drafts_retry({}, { locale })}
            </Button>
            <Button type="button" variant="outline" className={control} {...movementHandlers(restart)}>
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
                    <a
                      className="underline"
                      href={localizeHref(threadHref({ id: entry.threadId, title: entry.title }), { locale })}
                    >
                      {entry.title ?? m.own_drafts_no_title({}, { locale })}
                    </a>
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {kindLabel(entry, locale)} · {documentKindLabel(entry, locale)} ·{' '}
                    <a
                      className="underline"
                      href={localizeHref(`/boards/${encodeURIComponent(entry.board.id)}`, { locale })}
                    >
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
          <div className="flex flex-wrap gap-2">
            {coordinates.length > 1 ? (
              <Button type="button" variant="outline" className={control} {...movementHandlers(previousPage)}>
                {m.own_drafts_previous({}, { locale })}
              </Button>
            ) : null}
            <Button type="button" variant="outline" className={control} {...movementHandlers(restart)}>
              {m.own_drafts_restart({}, { locale })}
            </Button>
            {isOwnDraftCursor(page.page.next) ? (
              <Button type="button" variant="outline" className={control} {...movementHandlers(continuePage)}>
                {m.own_drafts_continue({}, { locale })}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </main>
  );
}
