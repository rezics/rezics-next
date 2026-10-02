'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@rezics/ui/field';
import { cn } from '@rezics/ui/utils';
import { CircleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { mainRelationships, RelationshipError } from '../relationships/api.ts';
import { RelationshipControl } from '../relationships/control.tsx';
import { relationshipsChanged } from '../relationships/events.ts';
import { storyFollowApi } from '../relationships/legacy.ts';
import { messages as relationshipMessages } from '../relationships/messages.ts';
import type { RelationshipsApi } from '../relationships/types.ts';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import type { RealmMessages } from './messages.ts';
import { type JoinPolicy, type Membership, offerOf } from './membership-state.ts';

export type JoinOutcome = { kind: 'joined' } | { kind: 'stale' } | { kind: 'denied' } | { kind: 'failed' };
export type FollowOutcome = { kind: 'saved'; following: boolean; revision: string } | { kind: 'stale' }
  | { kind: 'failed' };

/**
 * The seam between the header control and Main, as `FollowActions` is for
 * profiles. Signed out, the control leads to sign-in; signed in without an
 * Agent to act as, none is drawn; stories supply an in-memory `ready` adapter.
 */
export type MembershipActions =
  | { kind: 'unavailable' }
  | { kind: 'signed-out'; signInHref: string }
  | {
    kind: 'ready';
    /** Self-join on the policy's terms; `listed` puts the reader on the public roster. */
    join: (policy: JoinPolicy, listed: boolean, key?: string) => Promise<JoinOutcome>;
    follow: (following: boolean, expectedRevision: string | null) => Promise<FollowOutcome>;
    /** The reader's membership and follow, read again after a stale write. */
    refresh: () => Promise<Membership | null>;
  };

/** Joins and follows through the BFF as the session's Agent. Each press is its own idempotent command. */
export function mainMembershipActions(realm: string, actingSubject: string): Extract<MembershipActions, { kind: 'ready' }> {
  const api = mainRelationships(actingSubject);
  return {
    kind: 'ready',
    async join(policy, listed, key) {
      try { await api.join(realm, policy, listed, key); return { kind: 'joined' }; }
      catch (error) { return error instanceof RelationshipError && error.status === 409 ? { kind: 'stale' }
        : error instanceof RelationshipError && error.status === 403 ? { kind: 'denied' } : { kind: 'failed' }; }
    },
    async follow(following, expectedRevision) {
      try { const receipt = await api.set({ target: realm, following, expectedRevision });
        return { kind: 'saved', following: receipt.following, revision: receipt.revision }; }
      catch (error) { return error instanceof RelationshipError && error.status === 409 ? { kind: 'stale' } : { kind: 'failed' }; }
    },
    async refresh() {
      const [policy, follow] = await Promise.all([api.joining(realm).catch(() => null), api.state(realm, 'realm').catch(() => null)]);
      return { policy, following: follow?.following ?? null, followRevision: follow?.revision ?? null,
        level: follow?.level ?? null, source: follow?.source ?? null, pinPosition: follow?.pinPosition ?? null };
    },
  };
}

/** Realm membership supplies admission and consent; the shared control owns its follow, level and pin. */
export function RealmMembership({ realm, realmName, initial, signedIn, actingSubject, signInHref, rulesHref,
  actions, locale, messages, className, relationshipApi }: {
  realm: string; realmName: string; initial: Membership | null; signedIn: boolean; actingSubject?: string | null;
  signInHref: string; rulesHref: string; actions?: MembershipActions; locale: UiLocale; messages: RealmMessages; className?: string;
  relationshipApi?: RelationshipsApi;
}) {
  const router = useRouter();
  const copy = relationshipMessages[locale];
  const [state, setState] = useState<Membership>(initial ?? { policy: null, following: null, followRevision: null });
  const [joining, setJoining] = useState(false);
  const pendingJoin = useRef<{ policy: JoinPolicy; listed: boolean; key: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adapter] = useState(() => actions ?? (!signedIn ? { kind: 'signed-out' as const, signInHref }
    : actingSubject ? mainMembershipActions(realm, actingSubject) : { kind: 'unavailable' as const }));
  const follow = { following: state.following, revision: state.followRevision, level: state.level ?? null,
    source: state.source ?? null, pinPosition: state.pinPosition ?? null };
  const api = useMemo(() => {
    if (relationshipApi) return relationshipApi;
    const base = mainRelationships(actingSubject ?? '');
    return actions?.kind === 'ready' ? storyFollowApi(base, { send: actions.follow, refresh: async () => {
      const fresh = await actions.refresh();
      return fresh && fresh.following !== null ? { following: fresh.following, revision: fresh.followRevision } : null;
    } }, { ...follow, level: state.level ?? 'highlights' }) : base;
  }, [actions, actingSubject, realm, relationshipApi]);
  const offer = offerOf(state);
  return <div className={cn('flex flex-wrap items-center justify-end gap-2', className)}>
    <RelationshipControl target={realm} kind="realm" realm={realm} name={realmName} locale={locale}
      signedIn={signedIn} actingSubject={adapter.kind === 'unavailable' ? null : actingSubject}
      signInHref={adapter.kind === 'signed-out' ? adapter.signInHref : signInHref} api={adapter.kind === 'ready' ? api : undefined} initial={follow}
      membership={offer === 'joined' ? { joined: true, leave: () => {
        if (!state.policy || !window.confirm(copy.confirmLeave + '\n' + copy.leaveHelp)) return;
        void api.leave(realm, state.policy.membershipGeneration).then(async () => {
          const fresh = adapter.kind === 'ready' ? await adapter.refresh() : null;
          if (fresh) setState(fresh);
          router.refresh();
        }).catch(async error => {
          if (error instanceof RelationshipError && error.status === 409 && adapter.kind === 'ready') {
            const fresh = await adapter.refresh().catch(() => null);
            if (fresh) setState(fresh);
            setNotice(copy.stale);
          } else setNotice(copy.failed);
        });
      } } : offer === 'join' || !signedIn ? { joined: false, join: () => setJoining(true) } : undefined}
      onChange={fresh => setState(previous => ({ ...previous, following: fresh.following, followRevision: fresh.revision,
        level: fresh.level, source: fresh.source, pinPosition: fresh.pinPosition }))} />
    {notice ? <p role="status" className="basis-full text-sm">{notice}</p> : null}
    {state.policy && adapter.kind === 'ready' ? <JoinDialog open={joining} realmName={realmName}
      rulesHref={rulesHref} locale={locale} messages={messages} onClose={() => setJoining(false)}
      join={async listed => {
        const pending = pendingJoin.current && pendingJoin.current.listed === listed ? pendingJoin.current
          : { policy: state.policy!, listed, key: crypto.randomUUID() };
        pendingJoin.current = pending;
        const outcome = await adapter.join(pending.policy, listed, pending.key).catch((): JoinOutcome => ({ kind: 'failed' }));
        if (outcome.kind === 'joined') {
          pendingJoin.current = null;
          // Main's Join writes its follow atomically. Never issue a second Follow command.
          setJoining(false);
          relationshipsChanged();
          const fresh = await adapter.refresh().catch(() => null);
          if (fresh?.policy?.state === 'joined') setState(fresh);
          else { setState(previous => ({ ...previous, policy: previous.policy && { ...previous.policy, state: 'joined' } }));
            setNotice(copy.unavailable); }
          router.refresh();
        } else if (outcome.kind === 'stale') {
          pendingJoin.current = null;
          const fresh = await adapter.refresh().catch(() => null);
          if (fresh) setState(fresh);
        }
        return outcome;
      }} /> : null}
  </div>;
}

/** Consent before joining: the rules the reader agrees to, and whether their name appears on the member list. */
function JoinDialog({ open, realmName, rulesHref, locale, messages, join, onClose }: {
  open: boolean; realmName: string; rulesHref: string; locale: UiLocale; messages: RealmMessages;
  join: (listed: boolean) => Promise<JoinOutcome>; onClose: () => void;
}) {
  const t = materializeData(messages, { locale });
  const [listed, setListed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors: Record<Exclude<JoinOutcome['kind'], 'joined'>, string> = {
    stale: t.joinStale, denied: t.joinDenied, failed: t.joinFailed };
  async function submit() {
    setPending(true);
    setError(null);
    const outcome = await join(listed);
    setPending(false);
    if (outcome.kind !== 'joined') setError(errors[outcome.kind]);
  }
  return <Dialog open={open} pending={pending} onOpenChange={details => { if (!details.open) { setError(null); onClose(); } }}>
    <DialogContent size="md">
      <form noValidate className="contents" onSubmit={event => {
        event.preventDefault();
        void submit();
      }}>
        <DialogHeader title={t.joinTitle({ realm: realmName })} description={t.joinBody} />
        <DialogBody className="grid gap-4">
          <p className="text-sm">{t.joinAgree}{' '}
            <Link href={rulesHref} className="font-medium text-primary underline-offset-4 hover:underline">{t.readRules}</Link></p>
          <Field orientation="horizontal">
            <Checkbox checked={listed} onCheckedChange={details => setListed(details.checked === true)} />
            <FieldContent>
              <FieldLabel>{t.joinListed}</FieldLabel>
              <FieldDescription>{t.joinListedHelp}</FieldDescription>
            </FieldContent>
          </Field>
          {error ? <Alert variant="destructive" role="alert">
            <CircleAlertIcon aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>{t.cancel}</Button>
          <Button type="submit" isLoading={pending}>{t.join}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
