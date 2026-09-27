'use client';

import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldLabel } from '@rezics/ui/field';
import { MailIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { localizedPath } from '../../../i18n/locale.ts';
import { browserMainApi } from '../../api/browser.ts';
import { type MainClient, settle, uuidOf } from '../../feed/types.ts';
import { CommunityIcon } from '../community-icon.tsx';
import { useShell } from '../shell-provider.tsx';
import type { PendingInvitation } from './invitations-read.ts';

type Answer = 'accept' | 'decline';
type Outcome = { answer: Answer } | { failed: 'retry' | 'gone' };

/**
 * One invitation to join a Realm: who asked, where, until when, and the
 * choice to be listed publicly. Main records the answer once per key, so a
 * retried press never joins twice.
 */
function InvitationRow({ invitation, actingSubject, main }: { invitation: PendingInvitation; actingSubject: string;
  main: () => MainClient }) {
  const { t, locale } = useShell();
  const [listed, setListed] = useState(false);
  const [busy, setBusy] = useState<Answer | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const realm = invitation.realmName;

  async function answer(action: Answer) {
    setBusy(action);
    const result = await settle(() => main().v1.realms({ realm: uuidOf(invitation.realm) })
      .invitations({ invitation: invitation.id }).response.post({ actingSubject, action, listed },
        { headers: { 'idempotency-key': `${key}:${action}` } }));
    setBusy(null);
    setOutcome(result.ok ? { answer: action }
      : { failed: result.failure === 'sign-in' || result.failure === 'missing' || result.failure === 'moved' ? 'gone' : 'retry' });
  }

  if (outcome && 'answer' in outcome) {
    return <li className="px-4 py-3.5 text-sm"><p role="status">
      {outcome.answer === 'accept'
        ? <>{t.joinedRealm({ realm })}{' '}<Link href={localizedPath(invitation.realmHref, locale)}
          className="font-medium text-primary hover:underline">{realm}</Link></>
        : t.declinedInvitation({ realm })}
    </p></li>;
  }
  return <li className="flex flex-wrap items-start gap-3 px-4 py-3.5">
    <CommunityIcon icon={invitation.realmIcon} name={realm} size="md" />
    <div className="grid min-w-0 flex-1 gap-1">
      <p className="text-pretty font-semibold text-sm">
        <Link href={localizedPath(invitation.realmHref, locale)} lang={invitation.realmLanguage}
          className="outline-none hover:underline focus-visible:underline">
          {t.invitedTo({ name: invitation.inviterName ?? t.someone, realm })}</Link></p>
      <p className="text-muted-foreground text-xs">{t.invitationExpires({ date: new Intl.DateTimeFormat(locale,
        { dateStyle: 'medium' }).format(new Date(invitation.expiresAt)) })}</p>
      <Field orientation="horizontal" className="mt-1">
        <Checkbox checked={listed} onCheckedChange={details => setListed(details.checked === true)} />
        <FieldLabel className="font-normal">{t.listMe}</FieldLabel>
      </Field>
      {outcome && 'failed' in outcome ? <p role="alert" className="text-destructive-foreground text-sm">
        {outcome.failed === 'gone' ? t.invitationGone : t.invitationFailed}</p> : null}
    </div>
    <div className="flex gap-2">
      <Button size="sm" variant="outline" isLoading={busy === 'decline'} disabled={busy !== null}
        onClick={() => void answer('decline')}>{t.declineInvitation}</Button>
      <Button size="sm" isLoading={busy === 'accept'} disabled={busy !== null}
        onClick={() => void answer('accept')}>{t.acceptInvitation}</Button>
    </div>
  </li>;
}

/** Pending invitations to join a Realm, above the notifications. `main` is the browser client; stories pass one. */
export function RealmInvitations({ invitations, actingSubject, main }: { invitations: readonly PendingInvitation[];
  actingSubject: string; main?: MainClient }) {
  const { t } = useShell();
  const client = () => main ?? browserMainApi();
  if (!invitations.length) return null;
  return <section aria-labelledby="realm-invitations" className="grid gap-2">
    <h2 id="realm-invitations" className="flex items-center gap-2 font-semibold text-sm">
      <MailIcon aria-hidden="true" className="size-4 text-muted-foreground" />{t.invitationsTitle}</h2>
    <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-card
      shadow-(--aura-shadow-card)">
      {invitations.map(invitation => <InvitationRow key={invitation.id} invitation={invitation}
        actingSubject={actingSubject} main={client} />)}
    </ul>
  </section>;
}
