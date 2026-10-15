'use client';

import { Button } from '@rezics/ui/button';
import type { FormEvent, SetStateAction } from 'react';
import { useMemo } from 'react';
import { zoneCommandLane as commandLane } from './api.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { browserZoneRealmAttachment, commitCommand, type ZoneRealmAttachmentClient,
  type ZoneRealmAttachmentSnapshot, type ZoneRealmAttachmentWrite, type ZoneRealmAttachmentWritten } from './api.ts';
import { reopenAuthoringNotice } from './draft-state.ts';
import { useZoneEditorDraft, useZoneEditorExitActions, useZoneEditorRef, useZoneEditorResource, useZoneEditorSessionState } from './draft-provider.tsx';
import type { ZoneEditorMessages } from './messages.ts';

const handlePattern = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{1,28})[A-Za-z0-9]$/;
const fieldClass = 'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

interface AttachmentChoice { body: ZoneRealmAttachmentWrite; handle: string; name: string | null }
interface AttachmentDraft {
  head: string;
  attachedRealm: string | null;
  attachedName: string | null;
  handle: string;
  command: AttachmentChoice | null;
  needsReview: boolean;
  review: ZoneRealmAttachmentSnapshot | null;
  notice: null | 'pending' | 'saved' | 'removed' | 'unavailable' | 'limit' | 'sign-in' | 'failed' | 'denied' | 'stale' | 'reviewed';
}

const isDirty = (draft: AttachmentDraft) => Boolean(draft.handle.trim() || draft.command);
function accepts(value: unknown): value is AttachmentDraft {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<AttachmentDraft>;
  return typeof row.head === 'string' && typeof row.handle === 'string'
    && (typeof row.attachedName === 'string' || row.attachedName === null)
    && (typeof row.attachedRealm === 'string' || row.attachedRealm === null)
    && typeof row.needsReview === 'boolean' && 'command' in row && 'review' in row && 'notice' in row;
}

/** Stale attachment changes require review; unresolved commands retain their original envelope across sections. */
export function RealmAttachmentEditor({ zoneId, actingSubject, copy, zoneHead, attachedName, attachedRealm = null,
  signInHref, startingNotice = null, api }: {
  zoneId: string;
  actingSubject: string;
  copy: ZoneEditorMessages;
  zoneHead: string;
  attachedName: string | null;
  attachedRealm?: string | null;
  signInHref: string;
  startingNotice?: null | 'limit';
  api?: ZoneRealmAttachmentClient;
}) {
  const admitted = useMemo<AttachmentDraft>(() => ({
    head: zoneHead, attachedName, attachedRealm, handle: '', command: null, needsReview: false, review: null, notice: startingNotice,
  }), [zoneHead, attachedName, attachedRealm, startingNotice]);
  const [state, updateState, ready] = useZoneEditorDraft<AttachmentDraft>('attachment', admitted, isDirty, accepts, reopenAuthoringNotice);
  const [busy, updateBusy] = useZoneEditorSessionState<null | 'attach' | 'remove' | 'review'>('attachment-busy', null);
  const stateRef = useZoneEditorRef('attachment-state', state);
  stateRef.current = state;
  const busyRef = useZoneEditorRef('attachment-busy-ref', busy);
  busyRef.current = busy;
  function setState(next: SetStateAction<AttachmentDraft>) {
    updateState(current => {
      const value = typeof next === 'function' ? next(current) : next;
      stateRef.current = value;
      return value;
    });
  }
  function setBusy(value: typeof busy) {
    busyRef.current = value;
    updateBusy(value);
  }
  const client = useZoneEditorResource('attachment-client', () => api ?? browserZoneRealmAttachment());
  const lane = useZoneEditorResource('attachment-command', () =>
    commandLane<AttachmentChoice, ZoneRealmAttachmentWritten>({ ok: false, failure: 'unavailable' }));
  const reviewing = state.needsReview;
  const disabled = !ready || busy !== null || state.notice === 'denied' || state.notice === 'sign-in';
  useZoneEditorExitActions('attachment', async () => {
    if (!stateRef.current.command || stateRef.current.needsReview || busyRef.current) return false;
    return await write(stateRef.current.command) && !isDirty(stateRef.current);
  }, () => setState(value => ({ ...value, handle: '', command: null, needsReview: false, review: null, notice: null })));

  async function write(choice: AttachmentChoice) {
    setBusy(choice.body.defaultRealm ? 'attach' : 'remove');
    setState(current => ({ ...current, command: choice, needsReview: false, review: null, notice: null }));
    try {
      const answer = await lane.submit(choice, (captured, round) => commitCommand(round,
        key => client.saveConfiguration(zoneId, captured.body, key)));
      setState(current => {
        if (answer.ok) return { ...current, head: answer.data.revision, attachedRealm: choice.body.defaultRealm,
          attachedName: choice.body.defaultRealm ? choice.name : null,
          handle: choice.body.defaultRealm && current.handle === choice.handle ? '' : current.handle,
          command: null, needsReview: false, review: null, notice: choice.body.defaultRealm ? 'saved' : 'removed' };
        if (answer.failure === 'stale') return { ...current, command: choice, needsReview: true, review: null, notice: 'stale' };
        if (answer.failure === 'pending') return { ...current, command: choice, notice: 'pending' };
        if (answer.failure === 'unavailable') return { ...current, command: choice, notice: 'failed' };
        return { ...current, command: lane.needsConfirmation(answer) ? choice : null, needsReview: false, review: null,
          notice: answer.failure === 'sign-in' ? 'sign-in' : answer.failure === 'denied' ? 'denied'
            : 'reason' in answer && answer.reason === 'attachment-limit' ? 'limit' : 'unavailable' };
      });
      return answer.ok;
    } finally {
      setBusy(null);
    }
  }

  async function attach(event: FormEvent) {
    event.preventDefault();
    if (disabled || state.command) return;
    const capturedHandle = state.handle;
    const typed = capturedHandle.trim().replace(/^@/, '');
    if (!handlePattern.test(typed)) { setState(current => ({ ...current, notice: 'unavailable' })); return; }
    const expectedHead = state.head;
    setBusy('attach');
    setState(current => ({ ...current, notice: null }));
    try {
      const found = await client.resolveRealmHandle(typed, actingSubject);
      if (!found.ok) {
        setState(current => ({ ...current, notice: found.failure === 'sign-in' ? 'sign-in' : 'unavailable' }));
        return;
      }
      await write({ body: { expectedHead, actingSubject, defaultRealm: found.data.realm },
        handle: capturedHandle, name: found.data.name });
    } catch {
      setState(current => ({ ...current, notice: 'failed' }));
    } finally {
      setBusy(null);
    }
  }

  async function reviewAttachment() {
    if (!state.command || !state.needsReview || disabled) return;
    setBusy('review');
    try {
      const read = await client.readConfiguration(zoneId, actingSubject);
      if (!read.ok) {
        setState(current => ({ ...current, review: null,
          notice: read.failure === 'sign-in' ? 'sign-in' : read.failure === 'denied' ? 'denied'
            : read.failure === 'stale' ? 'stale' : 'failed' }));
        return;
      }
      setState(current => ({ ...current, attachedRealm: read.data.realm, attachedName: read.data.name,
        review: read.data, notice: 'reviewed' }));
    } catch {
      setState(current => ({ ...current, review: null, notice: 'failed' }));
    } finally {
      setBusy(null);
    }
  }

  function applyReviewed() {
    if (!state.review || !state.command || disabled) return;
    void write({ ...state.command, body: { ...state.command.body, expectedHead: state.review.revision } });
  }

  const attached = state.attachedName ?? (state.attachedRealm ? copy.realmAttachedNameless : null);
  return <section className="grid min-w-0 max-w-xl gap-3" aria-labelledby="zone-realm-title">
    <div className="min-w-0 space-y-2">
      <h2 id="zone-realm-title" className="font-semibold text-lg tracking-tight sm:text-xl">{copy.realmTitle}</h2>
      <p className="text-pretty text-muted-foreground text-sm">{copy.realmHelp}</p>
    </div>
    {state.notice === 'pending' ? <p role="status" className="text-sm">{copy.commandPending}</p> : null}
    {state.notice === 'saved' ? <p className="text-sm" role="status">{copy.realmSaved}</p> : null}
    {state.notice === 'removed' ? <p className="text-sm" role="status">{copy.realmRemoved}</p> : null}
    {state.notice === 'unavailable' ? <p className="text-pretty text-destructive-foreground text-sm" role="alert">{copy.realmUnavailable}</p> : null}
    {state.notice === 'limit' ? <p className="text-pretty text-destructive-foreground text-sm" role="alert">{copy.realmAttachmentLimit}</p> : null}
    {state.notice === 'failed' ? <p className="text-pretty text-sm" role="alert">{copy.realmFailedBody}</p> : null}
    {state.notice === 'denied' ? <p className="text-pretty text-sm" role="alert">{copy.realmDenied}</p> : null}
    {state.notice === 'sign-in' ? <p className="text-sm" role="alert"><LocalizedLink href={signInHref}
      className="underline-offset-4 hover:underline">{copy.signInTitle}</LocalizedLink></p> : null}
    {state.notice === 'stale' ? <p className="text-pretty text-sm" role="alert">{copy.realmStaleBody}</p> : null}
    {state.needsReview && !state.review ? <Button variant="outline" size="sm" className="justify-self-start" disabled={disabled}
      onClick={() => void reviewAttachment()}>{copy.realmReview}</Button> : null}
    {state.review ? <div className="grid gap-2" role="status">
      <p className="text-pretty text-sm">{copy.realmReviewedBody}</p>
      <Button variant="outline" size="sm" className="justify-self-start" disabled={disabled}
        onClick={applyReviewed}>{copy.realmApplyReviewed}</Button>
    </div> : null}
    {state.command && !state.needsReview && (state.notice === 'failed' || state.notice === 'pending') ? <Button variant="outline" size="sm" className="justify-self-start"
      disabled={disabled} onClick={() => void write(state.command!)}>{copy.realmRetry}</Button> : null}
    {attached ? <div className="grid min-w-0 gap-2 rounded-xl border border-border/60 p-3">
      <p className="truncate font-medium">{attached}</p>
      <p className="text-pretty text-muted-foreground text-sm">{copy.realmAttached}</p>
      <Button variant="outline" size="sm" className="justify-self-start" disabled={disabled || reviewing || Boolean(state.command)}
        isLoading={busy === 'remove'} onClick={() => void write({ body: { expectedHead: state.head, actingSubject, defaultRealm: null },
          handle: state.handle, name: null })}>{busy === 'remove' ? copy.realmRemoving : copy.realmRemove}</Button>
    </div> : <p className="text-pretty text-muted-foreground text-sm">{copy.realmNone}</p>}
    {attached && !state.handle.trim() ? null : <form className="grid min-w-0 gap-2" onSubmit={event => void attach(event)}>
      <label className="grid gap-1 text-sm">
        <span className="text-muted-foreground">{copy.realmHandle}</span>
        <input className={fieldClass} name="realm-handle" aria-label={copy.realmHandle} value={state.handle}
          disabled={!ready} autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={30}
          onChange={event => { const handle = event.target.value; setState(current => ({ ...current, handle })); }} />
      </label>
      <Button type="submit" variant="secondary" size="sm" className="justify-self-start"
        disabled={disabled || !state.handle.trim() || Boolean(state.command)} isLoading={busy === 'attach'}>
        {busy === 'attach' ? copy.realmAttaching : copy.realmAttach}</Button>
    </form>}
  </section>;
}
