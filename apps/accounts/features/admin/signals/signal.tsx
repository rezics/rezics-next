'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/field';
import { Textarea } from '@rezics/ui/textarea';
import { toast } from '@rezics/ui/toast';
import { cn } from '@rezics/ui/utils';
import { AppWindowIcon, CheckIcon, FingerprintIcon, KeyRoundIcon, MailWarningIcon, ShieldAlertIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { Signal, SignalKind } from '../api/types.ts';
import { ErrorAlert, useDismiss, useReauth } from '../actions/confirm.tsx';
import { userHref } from '../audit/entry.tsx';
import { DateOnly, duration, Time } from '../format.tsx';
import { useAdmin } from '../shell/admin-context.tsx';
import { useLocale, useTranslation } from '../../../i18n/client.ts';

type AdminText = ReturnType<typeof useTranslation<'admin'>>['t'];

const icons: Record<SignalKind, typeof ShieldAlertIcon> = { 'failed-sign-ins': ShieldAlertIcon, 'email-after-password': MailWarningIcon,
  'new-passkey': FingerprintIcon, 'mass-consent': AppWindowIcon };
/** Who may review each kind; mirrors the Account service's `signalPermissions`. */
export const reviewPermission = { 'failed-sign-ins': 'notes:write', 'email-after-password': 'notes:write', 'new-passkey': 'notes:write',
  'mass-consent': 'clients:manage' } as const satisfies Record<SignalKind, string>;

export const subjectHref = (signal: Signal) => signal.subject.kind === 'user' ? userHref(signal.subject.id)
  : `/admin/clients?client=${encodeURIComponent(signal.subject.id)}`;

/** What a signal says in words: its headline, why it matters, and its evidence. */
export function signalText(signal: Signal, t: AdminText, locale: string): { title: string; why: string; evidence: ReactNode } {
  switch (signal.kind) {
    case 'failed-sign-ins': return { title: t.signals.titles.failed(signal.evidence.failures), why: t.signals.why['failed-sign-ins'],
      evidence: <>{t.signals.first} <Time iso={signal.evidence.firstAt} /> · {t.signals.latest} <Time iso={signal.evidence.lastAt} /></> };
    case 'email-after-password': {
      const { emailChangedAt: email, passwordChangedAt: password } = signal.evidence;
      const gap = duration(Date.parse(email) - Date.parse(password), locale);
      return { title: password <= email ? t.signals.titles.emailAfterPassword({ gap }) : t.signals.titles.passwordAfterEmail({ gap }),
        why: t.signals.why['email-after-password'],
        evidence: <>{t.signals.passwordChanged} <Time iso={password} /> · {t.signals.emailChanged} <Time iso={email} /></> };
    }
    case 'new-passkey': return { title: t.signals.titles.newPasskey({ age: duration(Date.parse(signal.evidence.addedAt)
      - Date.parse(signal.evidence.accountCreatedAt), locale) }), why: t.signals.why['new-passkey'],
    evidence: <>{t.signals.added} <Time iso={signal.evidence.addedAt} /> · {t.signals.accountCreated} <DateOnly iso={signal.evidence.accountCreatedAt} /></> };
    case 'mass-consent': return { title: t.signals.titles.massConsent({ count: signal.evidence.accounts, app: signal.subject.name }),
      why: t.signals.why['mass-consent'],
      evidence: <>{t.signals.usually({ value: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(signal.evidence.dailyAverage) })}
        {' · '}{t.signals.latest} <Time iso={signal.evidence.lastAt} /></> };
  }
}

/** One signal as a list row: severity, headline, who, evidence and its actions. */
export function SignalRow({ signal, active, onReview, showSubject = true, rowIndex }: { signal: Signal; active?: boolean;
  onReview?(signal: Signal): void; showSubject?: boolean; rowIndex?: number }) {
  const { t } = useTranslation('admin');
  const locale = useLocale().current;
  const { can } = useAdmin();
  const Icon = icons[signal.kind];
  const text = signalText(signal, t, locale);
  const high = signal.severity === 'high';
  return <li data-active={active || undefined} className="group/signal relative flex gap-3 px-5 py-3.5 data-active:bg-accent/40
    group-data-[density=compact]/admin:py-2.5">
    <span aria-hidden="true" className={cn('mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl',
      high ? 'bg-destructive/10 text-destructive-foreground' : 'bg-warning/10 text-warning-foreground')}><Icon className="size-4.5" /></span>
    <div className="min-w-0 flex-1">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={high ? 'destructive' : 'warning'} size="sm">{high ? t.signals.high : t.signals.medium}</Badge>
        <span className="font-medium">{text.title}</span>
        {signal.kind === 'failed-sign-ins' && signal.evidence.signedInAfter
          ? <Badge variant="outline" size="sm" className="border-destructive/30 text-destructive-foreground">{t.signals.signedInAfter}</Badge> : null}
      </p>
      {showSubject ? <p className="mt-0.5 text-sm">
        <a href={subjectHref(signal)} data-signal-link={rowIndex} className="font-medium outline-none hover:underline focus-visible:underline">
          {signal.subject.kind === 'client' ? <KeyRoundIcon className="me-1 inline size-3.5 align-[-2px] text-muted-foreground" aria-hidden="true" /> : null}
          {signal.subject.name || signal.subject.email}</a>
        {signal.subject.email && signal.subject.name ? <span className="text-muted-foreground"> · {signal.subject.email}</span> : null}
      </p> : null}
      <p className="mt-0.5 text-xs text-muted-foreground">{text.evidence}</p>
      <p className="mt-1 text-xs text-muted-foreground max-sm:hidden">{text.why}</p>
    </div>
    {onReview && can(reviewPermission[signal.kind]) ? <div className="shrink-0 self-center">
      <Button size="sm" variant="outline" onClick={() => onReview(signal)} aria-label={t.signals.reviewLabel({ title: text.title })}>
        <CheckIcon aria-hidden="true" /><span className="max-sm:sr-only">{t.signals.review}</span></Button>
    </div> : null}
  </li>;
}

/** Marks a signal reviewed with an optional note of what was checked. It
 * leaves the list only when the service has recorded it. */
export function ReviewDialog({ signal, onClose, onDone }: { signal: Signal; onClose(): void; onDone(signal: Signal): void }) {
  const { t } = useTranslation('admin');
  const locale = useLocale().current;
  const { api } = useAdminClient();
  const [note, setNote] = useState('');
  const [commandId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reauth = useReauth(false);
  const dismiss = useDismiss(onClose, { enabled: !pending });
  const text = signalText(signal, t, locale);
  async function submit() {
    if (reauth.missing) return;
    setPending(true); setError(null);
    const result = await reauth.run(() => api.reviewSignal({ key: signal.key, commandId, ...(note.trim() ? { note: note.trim() } : {}) }));
    setPending(false);
    if (!result.ok) { setError(result.message); return; }
    toast.success({ title: t.signals.reviewed, description: t.requestId({ id: result.data.requestId }) });
    onDone(signal);
  }
  return <Dialog open {...dismiss.root}>
    <DialogContent ref={dismiss.content} size="md" showCloseButton={false}>
      <form className="contents" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <DialogHeader title={t.signals.reviewTitle} description={signal.kind === 'failed-sign-ins' || signal.kind === 'mass-consent'
          ? t.signals.reviewCounting : t.signals.reviewOnce} />
        <DialogBody className="flex flex-col gap-4">
          <div className="rounded-2xl bg-muted/60 px-4 py-3 text-sm">
            <p className="font-medium">{text.title}</p>
            <p className="text-muted-foreground">{signal.subject.name}{signal.subject.email ? ` · ${signal.subject.email}` : ''}</p>
          </div>
          <Field disabled={pending}>
            <FieldLabel>{t.signals.noteLabel}</FieldLabel>
            <Textarea value={note} maxLength={1000} className="min-h-20" data-autofocus placeholder={t.signals.notePlaceholder}
              onChange={event => setNote(event.currentTarget.value)} />
            <FieldDescription>{t.signals.noteHelp}</FieldDescription>
          </Field>
          {reauth.fields(pending)}
          <ErrorAlert message={error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>{t.cancel}</Button>
          <Button type="submit" isLoading={pending} disabled={reauth.missing}>{pending ? t.signals.reviewing : t.signals.markReviewed}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
