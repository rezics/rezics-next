import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { useAuthoringDeparture } from '../../threads/authoring-departure';
import type {
  MemberAdditionIntent,
  MemberAdditionResult,
  MemberSelectionRead,
  MemberSelectionAddress,
} from './source';

type Selected = Extract<MemberSelectionRead, { kind: 'ready' }>;
type State =
  | { kind: 'idle' | 'rejected' | 'complete' }
  | { kind: 'review'; intent: MemberAdditionIntent }
  | { kind: 'submitting' | 'uncertain' | 'pending' | 'checking'; intent: MemberAdditionIntent };

/** Selected-account addition uses the native membership command and requires explicit readback. */
export function MemberAddition({
  realmLabel,
  selected,
  address,
  current,
  sameSelection,
  addMember,
  refreshSelected,
}: {
  realmLabel: string;
  selected: Selected;
  address: MemberSelectionAddress;
  current: () => boolean;
  sameSelection: () => boolean;
  addMember?: RealmMembersSource['addMember'];
  refreshSelected: () => Promise<MemberSelectionRead | null>;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const stateNow = useRef<State>(state);
  stateNow.current = state;
  const intentNow = useRef<MemberAdditionIntent | null>(null);
  const sequence = useRef(0);
  const working = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const focusResult = useRef(false);

  useLayoutEffect(() => {
    if (state.kind === 'review') confirm.current?.focus();
    else if (focusResult.current && ['uncertain', 'pending', 'rejected', 'complete'].includes(state.kind)) {
      focusResult.current = false;
      status.current?.focus();
    }
  }, [state.kind]);

  useAuthoringDeparture(
    () => current() && (working.current || stateNow.current.kind === 'review' || stateNow.current.kind === 'uncertain'),
    () => working.current || stateNow.current.kind === 'uncertain',
    JSON.stringify([address.realmId, address.accountId, address.authority, address.membershipInterval, state.kind]),
    undefined,
    () => {
      sequence.current++;
      working.current = false;
      intentNow.current = null;
    },
    undefined,
  );

  function startReview() {
    if (!current() || selected.membership !== 'none' || selected.advice.add !== 'available' || !addMember) return;
    const intent = Object.freeze({
      realmId: address.realmId,
      accountId: selected.identity.accountId,
      membershipInterval: selected.membershipInterval,
      authority: address.authority,
      idempotencyKey: crypto.randomUUID(),
    });
    intentNow.current = intent;
    setState({ kind: 'review', intent });
  }

  async function submit(intent: MemberAdditionIntent) {
    if (!current() || !addMember || working.current || intentNow.current !== intent) return;
    const operation = ++sequence.current;
    working.current = true;
    setState({ kind: 'submitting', intent });
    let result: MemberAdditionResult;
    try {
      result = await addMember(intent);
    } catch {
      result = { kind: 'unknown' };
    }
    if (!current() || sequence.current !== operation || intentNow.current !== intent) return;
    working.current = false;
    focusResult.current = true;
    setState(
      result.kind === 'accepted'
        ? { kind: 'pending', intent }
        : result.kind === 'unknown'
          ? { kind: 'uncertain', intent }
          : { kind: 'rejected' },
    );
  }

  async function checkStatus(intent: MemberAdditionIntent) {
    if (!current() || working.current || intentNow.current !== intent) return;
    const operation = ++sequence.current;
    working.current = true;
    setState({ kind: 'checking', intent });
    try {
      const read = await refreshSelected();
      if (!sameSelection() || sequence.current !== operation || intentNow.current !== intent) return;
      if (!current()) {
        working.current = false;
        if (read?.kind === 'ready' && read.membership === 'current') return;
        focusResult.current = true;
        setState({ kind: 'pending', intent });
        return;
      }
      const complete =
        read?.kind === 'ready' &&
        read.realmId === intent.realmId &&
        read.authority === intent.authority &&
        read.identity.accountId === intent.accountId &&
        read.membership === 'current' &&
        typeof read.membershipInterval === 'string' &&
        read.membershipInterval.length > 0;
      working.current = false;
      focusResult.current = true;
      setState(complete ? { kind: 'complete' } : { kind: 'pending', intent });
    } catch {
      if (!sameSelection() || sequence.current !== operation || intentNow.current !== intent) return;
      working.current = false;
      focusResult.current = true;
      setState({ kind: 'pending', intent });
    }
  }

  const workPending = state.kind === 'pending' || state.kind === 'checking';
  if (selected.membership === 'current') return null;
  if (selected.membership !== 'none' && !workPending) return null;
  if (selected.membership === 'none' && selected.advice.add === 'unavailable' && !workPending) return null;
  if (selected.membership === 'none' && selected.advice.add === 'unknown' && !workPending)
    return <p role="status" className="text-sm">{m.realm_members_actions_unavailable()}</p>;
  if (!addMember && !workPending) return null;

  const intent = 'intent' in state ? state.intent : null;
  return (
    <section aria-labelledby="realm-member-add-heading" className="space-y-3 rounded-lg border p-4">
      <h3 id="realm-member-add-heading" className="font-semibold">{m.realm_members_add_member()}</h3>
      {state.kind === 'review' && intent ? (
        <div role="group" aria-label={m.realm_members_add_member()} className="space-y-3">
          <p>{m.realm_members_add_review({ account: selected.identity.label, realm: realmLabel })}</p>
          <p className="text-sm text-muted-foreground">
            <bdi>{selected.identity.reference}</bdi>
            {' · '}
            <bdi>{selected.identity.accountId}</bdi>
            {' · '}
            <bdi>{intent.realmId}</bdi>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={confirm}
              type="button"
              className="min-h-11 whitespace-normal"
              disabled={!current()}
              onClick={() => {
                focusResult.current = true;
                void submit(intent);
              }}
            >
              {m.realm_bans_confirm()}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 whitespace-normal"
              disabled={!current()}
              onClick={() => {
                if (!current()) return;
                intentNow.current = null;
                setState({ kind: 'idle' });
                queueMicrotask(() => trigger.current?.focus());
              }}
            >
              {m.realm_bans_cancel()}
            </Button>
          </div>
        </div>
      ) : null}
      {state.kind === 'idle' || state.kind === 'rejected' ? (
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          className="min-h-11 whitespace-normal"
          disabled={!current()}
          onClick={startReview}
        >
          {m.realm_members_add_member()}
        </Button>
      ) : null}
      {state.kind === 'submitting' ? <p role="status">{m.realm_members_loading()}</p> : null}
      {state.kind === 'uncertain' && intent ? (
        <div className="space-y-3">
          <p ref={status} role="status" tabIndex={-1}>{m.realm_members_unknown_command()}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!current()}
            onClick={() => void submit(intent)}
          >
            {m.realm_members_retry_command()}
          </Button>
        </div>
      ) : null}
      {(state.kind === 'pending' || state.kind === 'checking') && intent ? (
        <div className="space-y-3">
          <p ref={status} role="status" tabIndex={-1}>
            {state.kind === 'checking' ? m.realm_members_loading() : m.realm_members_add_pending()}
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={state.kind === 'checking' || !current()}
            onClick={() => void checkStatus(intent)}
          >
            {m.realm_members_check_status()}
          </Button>
        </div>
      ) : null}
      {state.kind === 'rejected' ? (
        <p ref={status} role="alert" tabIndex={-1}>{m.realm_members_add_rejected()}</p>
      ) : null}
      {state.kind === 'complete' ? (
        <p ref={status} role="status" tabIndex={-1}>{m.realm_members_add_complete()}</p>
      ) : null}
    </section>
  );
}
