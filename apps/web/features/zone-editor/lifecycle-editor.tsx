'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button, buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { commandLane, type WriteRound } from '../api/command.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { browserZoneLifecycle, commitCommand, type SavedZoneLifecycle, type WriteResult, type ZoneLifecycleClient,
  type ZoneLifecycleSnapshot } from './api.ts';
import type { ZoneEditorMessages } from './messages.ts';
import { initialZoneLifecycleState, reduceZoneLifecycle, zoneLifecycleTarget, type ZoneLifecycleAction,
  type ZoneLifecycleEditorState, type ZoneLifecycleNotice } from './lifecycle.ts';
import { zoneEditorPath, zoneLifecyclePath } from './routes.ts';

const actionClass = 'h-auto min-h-9 whitespace-normal px-3';
type LifecycleIntent = { expectedHead: string; action: ZoneLifecycleAction };

/** Retire or recover a saved site while retaining an explicit review after a stale head. */
export function ZoneLifecycleEditor({ zoneId, actingSubject, locale, copy, initial, signInHref, returnAddress, api,
  onRetired }: {
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
}) {
  const [state, setState] = useState(() => initialZoneLifecycleState(initial));
  const [busy, setBusy] = useState<null | 'write' | 'review'>(null);
  const client = useRef<ZoneLifecycleClient | null>(null);
  const lane = useRef<ReturnType<typeof commandLane<LifecycleIntent, WriteResult<SavedZoneLifecycle>>> | null>(null);
  if (!client.current) client.current = api ?? browserZoneLifecycle();
  if (!lane.current) lane.current = commandLane({ ok: false, failure: 'unavailable' });

  function put(event: Parameters<typeof reduceZoneLifecycle>[1]) {
    setState(current => reduceZoneLifecycle(current, event));
  }

  async function review() {
    if (busy) return;
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

  async function save(action: ZoneLifecycleAction) {
    if (busy || state.needsReview || state.status === zoneLifecycleTarget(action)) return;
    setBusy('write');
    const intent = { expectedHead: state.expectedHead, action };
    const result = await lane.current!.submit(intent, (chosen, round) => apply(chosen, round));
    if (result.ok) {
      const snapshot = { revision: result.data.revision, status: zoneLifecycleTarget(action) } as const;
      put({ type: 'saved', action, snapshot, replayed: result.data.replayed });
      if (action === 'retire') {
        if (onRetired) onRetired();
        else window.location.replace(localizedPath(zoneLifecyclePath(zoneId, returnAddress), locale));
      } else if (returnAddress) {
        window.location.replace(localizedPath(zoneEditorPath(returnAddress), locale));
      }
    } else if (result.failure === 'stale') put({ type: 'stale' });
    else put({ type: 'failed', failure: noticeFailure(result.failure) });
    setBusy(null);
  }

  function apply(intent: LifecycleIntent, round: WriteRound): Promise<WriteResult<SavedZoneLifecycle>> {
    const body = { expectedHead: intent.expectedHead, actingSubject };
    return commitCommand(round, key => intent.action === 'retire'
      ? client.current!.retire(zoneId, body, key)
      : client.current!.recover(zoneId, body, key));
  }

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
          disabled={busy !== null || state.needsReview} isLoading={busy === 'write'}
          onClick={() => void save(selected)}>
          {busy === 'write' ? selected === 'retire' ? copy.lifecycleRetiring : copy.lifecycleRecovering : copy.lifecycleConfirmAction}
        </Button>
        <Button variant="outline" size="sm" className={actionClass} disabled={busy !== null}
          onClick={() => put({ type: 'cancel' })}>{copy.lifecycleCancel}</Button>
      </div>
    </Alert> : null}

    {!selected ? <div className="flex flex-wrap items-center gap-2">
      <Button variant={state.status === 'active' ? 'destructive' : 'secondary'} size="sm" className={actionClass}
        disabled={busy !== null} onClick={() => put({ type: 'select', action: state.status === 'active' ? 'retire' : 'recover' })}>
        {state.status === 'active' ? copy.lifecycleRetire : copy.lifecycleRecover}
      </Button>
      {state.status === 'retired' ? <p className="text-pretty text-muted-foreground text-sm">{copy.lifecycleRecoveredBody}</p> : null}
    </div> : null}
  </section>;
}

function LifecycleNotice({ state, copy, signInHref, busy, onReview }: {
  state: ZoneLifecycleEditorState;
  copy: ZoneEditorMessages;
  signInHref: string;
  busy: null | 'write' | 'review';
  onReview: () => void;
}) {
  if (state.notice === 'idle') return null;
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

function noticeFailure(failure: string): 'denied' | 'sign-in' | 'invalid' | 'conflict' | 'unavailable' {
  switch (failure) {
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
