'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button, buttonVariants } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@rezics/ui/field';
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuTrigger } from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import { CheckIcon, ChevronDownIcon, CircleAlertIcon, PlusIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import Link from '../shell/localized-link.tsx';
import type { RealmMessages } from './messages.ts';
import { type JoinPolicy, type Membership, offerOf, readMembership } from './membership-state.ts';

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
    join: (policy: JoinPolicy, listed: boolean) => Promise<JoinOutcome>;
    follow: (following: boolean, expectedRevision: string | null) => Promise<FollowOutcome>;
    /** The reader's membership and follow, read again after a stale write. */
    refresh: () => Promise<Membership | null>;
  };

/** Joins and follows through the BFF as the session's Agent. Each press is its own idempotent command. */
export function mainMembershipActions(realm: string, actingSubject: string,
  main: () => MainClient = browserMainApi): Extract<MembershipActions, { kind: 'ready' }> {
  const id = realm.slice(-36);
  const key = () => ({ headers: { 'idempotency-key': crypto.randomUUID() } });
  return {
    kind: 'ready',
    async join(policy, listed) {
      const { data, error } = await main().v1.realms({ realm: id }).join.post({ actingSubject,
        expectedMembershipGeneration: policy.membershipGeneration, expectedPolicyRevision: policy.policyRevision,
        termsRevision: policy.termsRevision, listed }, key());
      if (data) return { kind: 'joined' };
      return error?.status === 409 ? { kind: 'stale' } : error?.status === 403 ? { kind: 'denied' } : { kind: 'failed' };
    },
    async follow(following, expectedRevision) {
      const { data, error } = await main().v1.follows.post({ profile: 'follow-command-v1', target: realm, kind: 'realm',
        actingSubject, following, expectedRevision }, key());
      if (data) return { kind: 'saved', following: data.following, revision: data.revision };
      return error?.status === 409 ? { kind: 'stale' } : { kind: 'failed' };
    },
    refresh: () => readMembership(main(), realm, actingSubject),
  };
}

type Status = 'idle' | 'saving' | 'follow-failed';

/**
 * Join or Follow in a Realm's header. A Realm that lets people join on their
 * own asks for consent to its rules (and whether to appear on its public
 * member list) before joining; joining also follows it into Home. Any other
 * Realm can be followed. Members see that they joined, with their Home follow
 * in a menu.
 */
export function RealmMembership({ realm, realmName, initial, signedIn, actingSubject, signInHref, rulesHref,
  actions, locale, messages, className }: {
  /** The Realm IRI. */
  realm: string; realmName: string;
  /** The reader's membership as the page read it; nothing is known for a signed-out reader. */
  initial: Membership | null;
  signedIn: boolean; actingSubject?: string | null; signInHref: string;
  /** The About tab, where the rules are. */
  rulesHref: string;
  /** Stories supply these; pages derive them from the session. */
  actions?: MembershipActions;
  locale: UiLocale; messages: RealmMessages; className?: string;
}) {
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const [adapter] = useState<MembershipActions>(() => actions ?? (!signedIn ? { kind: 'signed-out', signInHref }
    : actingSubject ? mainMembershipActions(realm, actingSubject) : { kind: 'unavailable' }));
  const [state, setState] = useState<Membership>(initial ?? { policy: null, following: null, followRevision: null });
  const [status, setStatus] = useState<Status>('idle');
  const [joining, setJoining] = useState(false);

  if (adapter.kind === 'unavailable') return null;
  if (adapter.kind === 'signed-out') {
    return <Link href={adapter.signInHref} className={cn(buttonVariants({ size: 'sm', pill: true }), 'min-w-24', className)}>
      <PlusIcon aria-hidden="true" />{t.join}<span className="sr-only"> — {t.signInToJoin}</span></Link>;
  }
  const ready = adapter;

  /** Sets the Home follow; a follow changed elsewhere is read again and the reader's choice applied once more. */
  async function follow(next: boolean): Promise<boolean> {
    if (status === 'saving') return false;
    const before = state;
    setState({ ...before, following: next });
    setStatus('saving');
    let outcome = await ready.follow(next, before.followRevision).catch((): FollowOutcome => ({ kind: 'failed' }));
    if (outcome.kind === 'stale') {
      const fresh = await ready.refresh().catch(() => null);
      outcome = !fresh || fresh.following === null ? { kind: 'failed' }
        : fresh.following === next && fresh.followRevision
          ? { kind: 'saved', following: next, revision: fresh.followRevision }
          : await ready.follow(next, fresh.followRevision).catch((): FollowOutcome => ({ kind: 'failed' }));
    }
    if (outcome.kind === 'saved') {
      const saved = outcome;
      setState(current => ({ ...current, following: saved.following, followRevision: saved.revision }));
      setStatus('idle');
      return true;
    }
    setState(before);
    setStatus('follow-failed');
    return false;
  }

  const offer = offerOf(state);
  const failed = status === 'follow-failed'
    ? <p role="status" className="basis-full text-destructive-foreground text-sm">{t.followFailed}</p> : null;
  let control;
  if (offer === 'joined') {
    control = <Menu>
      <MenuTrigger asChild>
        <Button size="sm" pill variant="outline" className="min-w-24 bg-card/80 backdrop-blur">
          <CheckIcon aria-hidden="true" className="text-primary" />{t.joined}
          <ChevronDownIcon aria-hidden="true" className="opacity-60" /></Button>
      </MenuTrigger>
      <MenuContent className="w-64">
        <MenuCheckboxItem value="follow" checked={state.following === true}
          onCheckedChange={checked => void follow(checked === true)}>{t.showInHome}</MenuCheckboxItem>
        <MenuItem value="rules" asChild><Link href={rulesHref}>{t.readRules}</Link></MenuItem>
      </MenuContent>
    </Menu>;
  } else if (offer === 'join') {
    control = <Button size="sm" pill className="min-w-24" onClick={() => setJoining(true)}>
      <PlusIcon aria-hidden="true" />{t.join}</Button>;
  } else {
    // The label says the state; while following, its hidden end says what a press does.
    control = <Button size="sm" pill variant={state.following ? 'outline' : 'default'}
      className={cn('min-w-24', state.following && 'bg-card/80 backdrop-blur')}
      aria-disabled={status === 'saving' || undefined} onClick={() => void follow(!state.following)}>
      {state.following ? <><CheckIcon aria-hidden="true" className="text-primary" />{t.following}
        <span className="sr-only"> · {t.unfollowRealm({ realm: realmName })}</span></>
        : <><PlusIcon aria-hidden="true" />{t.follow}<span className="sr-only"> · {realmName}</span></>}</Button>;
  }
  return <div className={cn('flex flex-wrap items-center justify-end gap-2', className)}>
    {control}
    {failed}
    {state.policy && offer === 'join' ? <JoinDialog open={joining} realmName={realmName}
      rulesHref={rulesHref} locale={locale} messages={messages} onClose={() => setJoining(false)}
      join={async listed => {
        const outcome = await ready.join(state.policy!, listed).catch((): JoinOutcome => ({ kind: 'failed' }));
        if (outcome.kind === 'joined') {
          setState(current => ({ ...current, policy: current.policy && { ...current.policy, state: 'joined' } }));
          setJoining(false);
          // Joining follows the Realm into Home, as joining a community does elsewhere.
          if (!state.following) await follow(true);
          router.refresh();
        } else if (outcome.kind === 'stale') {
          const fresh = await ready.refresh().catch(() => null);
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
