'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button, buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { useMemo, useRef } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { WriteRound } from '../api/command.ts';
import { zoneCommandLane as commandLane } from './api.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { browserZoneLifecycle, commitCommand, type SavedZoneLifecycle, type WriteResult, type ZoneLifecycleClient,
  type ZoneLifecycleSnapshot } from './api.ts';
import type { ZoneEditorMessages } from './messages.ts';
import { initialZoneLifecycleState, reduceZoneLifecycle, zoneLifecycleTarget, type ZoneLifecycleAction,
  type ZoneLifecycleEditorState, type ZoneLifecycleNotice } from './lifecycle.ts';
import { zoneEditorPath, zoneLifecyclePath } from './routes.ts';
import { reopenAuthoringNotice } from './draft-state.ts';
import { useZoneEditorDraft, useZoneEditorExit, useZoneEditorExitActions, useZoneEditorRef, useZoneEditorSessionState } from './draft-provider.tsx';

const actionClass = 'h-auto min-h-9 whitespace-normal px-3';
type LifecycleIntent = { expectedHead: string; action: ZoneLifecycleAction };

/** Retire or recover a saved site while retaining an explicit review after a stale head. */
export function ZoneLifecycleEditor({ zoneId, actingSubject, locale, copy, initial, signInHref, returnAddress, api,
  onRetired, onCompleted }: {
  zoneId: string;
  actingSubject: string;
  locale: UiLocale;
  copy: ZoneEditorMessages;
  initial: ZoneLifecycleSnapshot;
  signInHref: string;
  returnAddress?: string;
  api?: ZoneLifecycleClient;
  /** Stories keep the confirmation on screen instead of navigating away. */
  onRetired?: () => void;
  onCompleted?: () => void;
}) {
  const admitted = useMemo(() => initialZoneLifecycleState(initial), [initial]);
  const [state, setState] = useZoneEditorDraft('lifecycle', admitted, () => false, isLifecycleEditorState, reopenAuthoringNotice);
  const [busy, updateBusy] = useZoneEditorSessionState<null | 'write' | 'review'>('lifecycle-busy', null);
  const busyRef = useZoneEditorRef('lifecycle-busy-ref', busy);
  busyRef.current = busy;
  const stateRef = useZoneEditorRef('lifecycle-state', state);
  stateRef.current = state;
  const captured = useZoneEditorRef<LifecycleIntent | null>('lifecycle-choice', null);
  const requestExit = useZoneEditorExit();
  const client = useRef<ZoneLifecycleClient | null>(null);
  const lane = useZoneEditorRef<ReturnType<typeof commandLane<LifecycleIntent, WriteResult<SavedZoneLifecycle>>> | null>('lifecycle-lane', null);
  if (!client.current) client.current = api ?? browserZoneLifecycle();
  if (!lane.current) lane.current = commandLane({ ok: false, failure: 'unavailable' });
  useZoneEditorExitActions('lifecycle', async () => {
    if (busyRef.current || stateRef.current.needsReview) return false;
    const intent = captured.current;
    if (!intent) return true;
    setBusy('write');
    try {
      return (await submitLifecycle(intent)).ok;
    } finally {
      setBusy(null);
    }
  }, () => {
    captured.current = null;
    put({ type: 'cancel' });
  }, () => captured.current !== null);

  function setBusy(next: typeof busy) {
    busyRef.current = next;
    updateBusy(next);
  }

  function put(event: Parameters<typeof reduceZoneLifecycle>[1]) {
    setState(current => {
      const next = reduceZoneLifecycle(current, event);
      stateRef.current = next;
      return next;
    });
  }

  async function review() {
    if (busyRef.current) return;
    setBusy('review');
    try {
      const result = await client.current!.readConfiguration(zoneId, actingSubject);
      if (result.ok) put({ type: 'reviewed', snapshot: result.data });
      else put({ type: 'review-failed', failure: reviewFailure(result.failure) });
    } catch {
      put({ type: 'review-failed', failure: 'unavailable' });
    } finally {
      setBusy(null);
    }
  }

  function save(action: ZoneLifecycleAction) {
    requestExit(() => { void applyLifecycle(action); });
  }

  async function applyLifecycle(action: ZoneLifecycleAction) {
    const intent = captured.current ?? { expectedHead: stateRef.current.expectedHead, action };
    if (busyRef.current || stateRef.current.needsReview) return;
    if (!captured.current && stateRef.current.status === zoneLifecycleTarget(intent.action)) {
      finishLifecycle(intent.action);
      return;
    }
    setBusy('write');
    try {
      const result = await submitLifecycle(intent);
      if (!result.ok) return;
      finishLifecycle(intent.action);
    } finally {
      setBusy(null);
    }
  }

  function finishLifecycle(action: ZoneLifecycleAction) {
    if (onCompleted) { onCompleted(); return; }
    if (action === 'retire') {
      if (onRetired) onRetired();
      else requestExit(() => window.location.replace(localizedPath(zoneLifecyclePath(zoneId, returnAddress), locale)));
    } else {
      requestExit(() => window.location.replace(localizedPath(zoneEditorPath(returnAddress ?? zoneId), locale)));
    }
  }

  async function submitLifecycle(intent: LifecycleIntent): Promise<WriteResult<SavedZoneLifecycle>> {
    captured.current = intent;
    const result = await lane.current!.submit(intent, (chosen, round) => apply(chosen, round));
    if (result.ok || !lane.current!.needsConfirmation(result)) captured.current = null;
    if (result.ok) {
      const snapshot = { revision: result.data.revision, status: zoneLifecycleTarget(intent.action) } as const;
      put({ type: 'saved', action: intent.action, snapshot, replayed: result.data.replayed });
    } else if (result.failure === 'stale') put({ type: 'stale' });
    else put({ type: 'failed', failure: noticeFailure(result.failure) });
    return result;
  }

  function apply(intent: LifecycleIntent, round: WriteRound): Promise<WriteResult<SavedZoneLifecycle>> {
    const body = { expectedHead: intent.expectedHead, actingSubject };
    return commitCommand(round, key => intent.action === 'retire'
      ? client.current!.retire(zoneId, body, key)
      : client.current!.recover(zoneId, body, key));
  }

  const authorityRefused = state.notice === 'denied' || state.notice === 'sign-in';
  const selected = state.selection;
  const alreadyApplied = selected !== null && state.status === zoneLifecycleTarget(selected);
  return <section className="grid min-w-0 max-w-3xl gap-4" aria-labelledby="zone-lifecycle-title">
    <div className="min-w-0 space-y-2">
      <h2 id="zone-lifecycle-title" className="font-semibold text-lg tracking-tight sm:text-xl">{copy.lifecycleTitle}</h2>
      <p className="text-pretty text-muted-foreground text-sm">{copy.lifecycleHelp}</p>
      <p role="status" className="text-sm font-medium">
        {state.status === 'active' ? copy.lifecycleStatusActive : copy.lifecycleStatusRetired}
      </p>
      {state.status === 'retired'
        ? <p className="text-pretty text-muted-foreground text-sm">{copy.lifecycleRetiredBody}</p>
        : null}
    </div>

    <p className="break-all font-mono text-xs text-muted-foreground">{state.expectedHead}</p>

    <LifecycleNotice state={state} copy={copy} signInHref={signInHref} busy={busy} onReview={() => void review()} />

    {alreadyApplied ? <Alert variant="info" role="status">
      <AlertDescription>{copy.lifecycleChoiceAlreadyApplied}</AlertDescription>
      <Button variant="outline" size="sm" className={cn(actionClass, 'mt-3')} disabled={busy !== null}
        onClick={() => put({ type: 'cancel' })}>{copy.lifecycleClearChoice}</Button>
    </Alert> : null}

    {selected && !alreadyApplied ? <Alert variant={selected === 'retire' ? 'warning' : 'info'}>
      <div className="min-w-0 space-y-1">
        <AlertTitle>{selected === 'retire' ? copy.lifecycleRetireConfirmTitle : copy.lifecycleRecoverConfirmTitle}</AlertTitle>
        <AlertDescription>{selected === 'retire' ? copy.lifecycleRetireConfirmBody : copy.lifecycleRecoverConfirmBody}</AlertDescription>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant={selected === 'retire' ? 'destructive' : 'secondary'} size="sm" className={actionClass}
          disabled={authorityRefused || busy !== null || state.needsReview} isLoading={busy === 'write'}
          onClick={() => void save(selected)}>
          {busy === 'write' ? selected === 'retire' ? copy.lifecycleRetiring : copy.lifecycleRecovering : state.notice === 'pending' ? copy.checkConfirmation : copy.lifecycleConfirmAction}
        </Button>
        <Button variant="outline" size="sm" className={actionClass} disabled={busy !== null || state.notice === 'pending'}
          onClick={() => put({ type: 'cancel' })}>{copy.lifecycleCancel}</Button>
      </div>
    </Alert> : null}

    {!selected ? <div className="flex flex-wrap items-center gap-2">
      <Button variant={state.status === 'active' ? 'destructive' : 'secondary'} size="sm" className={actionClass}
        disabled={authorityRefused || busy !== null} onClick={() => put({ type: 'select', action: state.status === 'active' ? 'retire' : 'recover' })}>
        {state.status === 'active' ? copy.lifecycleRetire : copy.lifecycleRecover}
      </Button>
      {state.status === 'retired' ? <p className="text-pretty text-muted-foreground text-sm">{copy.lifecycleRecoveredBody}</p> : null}
    </div> : null}
  </section>;
}

function isLifecycleEditorState(value: unknown): value is ZoneLifecycleEditorState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<ZoneLifecycleEditorState>;
  return typeof state.expectedHead === 'string' && (state.status === 'active' || state.status === 'retired')
    && typeof state.needsReview === 'boolean' && typeof state.notice === 'string';
}

function LifecycleNotice({ state, copy, signInHref, busy, onReview }: {
  state: ZoneLifecycleEditorState;
  copy: ZoneEditorMessages;
  signInHref: string;
  busy: null | 'write' | 'review';
  onReview: () => void;
}) {
  if (state.notice === 'idle') return null;
  if (state.notice === 'pending') return <p role="status" className="text-sm">{copy.commandPending}</p>;
  if (state.notice === 'retired') return <p role="status" className="text-sm">{copy.lifecycleRetiredSaved}</p>;
  if (state.notice === 'retired-replayed') return <p role="status" className="text-sm">{copy.lifecycleRetiredReplay}</p>;
  if (state.notice === 'recovered') return <p role="status" className="text-sm">{copy.lifecycleRecoveredSaved}</p>;
  if (state.notice === 'recovered-replayed') return <p role="status" className="text-sm">{copy.lifecycleRecoveredReplay}</p>;
  if (state.notice === 'reviewed') return <p role="status" className="text-sm">{copy.lifecycleReviewed}</p>;

  const stale = state.notice === 'stale';
  const failure = failureCopy(copy, state.notice);
  return <Alert variant={stale ? 'warning' : state.notice === 'sign-in' ? 'info' : 'destructive'} role="alert"
    className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
    <div className="min-w-0 space-y-1">
      <AlertTitle>{stale ? copy.lifecycleStaleTitle : failure.title}</AlertTitle>
      <AlertDescription>{stale ? copy.lifecycleStaleBody : failure.body}</AlertDescription>
    </div>
    {state.needsReview ? <Button variant="outline" size="sm" className={cn(actionClass, 'mt-3 sm:mt-0')}
      disabled={busy !== null} isLoading={busy === 'review'} onClick={onReview}>
      {busy === 'review' ? copy.lifecycleReviewing : copy.lifecycleReview}
    </Button> : null}
    {state.notice === 'sign-in' ? <LocalizedLink href={signInHref}
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), actionClass, 'mt-3 sm:mt-0')}>
      {copy.signInTitle}
    </LocalizedLink> : null}
  </Alert>;
}

function failureCopy(copy: ZoneEditorMessages, notice: ZoneLifecycleNotice): { title: string; body: string } {
  switch (notice) {
    case 'denied': return { title: copy.deniedTitle, body: copy.lifecycleFailureDenied };
    case 'sign-in': return { title: copy.signInTitle, body: copy.lifecycleFailureSignIn };
    case 'invalid': return { title: copy.invalidTitle, body: copy.lifecycleFailureInvalid };
    case 'conflict': return { title: copy.conflictTitle, body: copy.lifecycleFailureConflict };
    default: return { title: copy.unavailableTitle, body: copy.lifecycleFailureUnavailable };
  }
}

function noticeFailure(failure: string): 'denied' | 'sign-in' | 'invalid' | 'conflict' | 'pending' | 'unavailable' {
  switch (failure) {
    case 'pending': return 'pending';
    case 'denied': return 'denied';
    case 'sign-in': return 'sign-in';
    case 'invalid': return 'invalid';
    case 'conflict': return 'conflict';
    default: return 'unavailable';
  }
}

function reviewFailure(failure: string): 'denied' | 'sign-in' | 'unavailable' {
  if (failure === 'denied' || failure === 'sign-in') return failure;
  return 'unavailable';
}
