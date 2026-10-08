'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/field';
import { Textarea } from '@rezics/ui/textarea';
import { cn } from '@rezics/ui/utils';
import { BanIcon, CircleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { appealClient, type AppealSubmit } from './api.ts';
import type { RealmAppealMessages } from './messages.ts';
import type { BanReading } from './reading.ts';
import { appealPresentation, banSchedule, shownReading, statementProblem } from './view.ts';

export interface AppealActions {
  submit(statement: string, key: string): Promise<AppealSubmit>;
}

function formatWhen(value: string, locale: UiLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date);
}

/** The ban, its one appeal, and the resolution. A member who is not banned renders nothing. */
export function RealmBanPanel({ reading, realm, locale, messages, actions, className }: {
  reading: BanReading | null;
  realm: string;
  locale: UiLocale;
  messages: RealmAppealMessages;
  actions?: AppealActions;
  className?: string;
}) {
  const t = materializeData(messages, { locale });
  const [pendingReading, setPendingReading] = useState<BanReading | null>(null);
  const [statement, setStatement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const keyFor = useRef<{ statement: string; key: string } | null>(null);
  if (!reading) return null;
  const current = shownReading(reading, pendingReading);
  const schedule = banSchedule(current, Date.now());
  const appeal = appealPresentation(current);
  const problems: Record<NonNullable<ReturnType<typeof statementProblem>>, string> = {
    empty: t.statementEmpty, long: t.statementLong,
  };

  async function submit() {
    const problem = statementProblem(statement);
    if (problem) {
      setError(problems[problem]);
      return;
    }
    const text = statement.trim();
    const held = keyFor.current?.statement === text ? keyFor.current.key : crypto.randomUUID();
    keyFor.current = { statement: text, key: held };
    setPending(true);
    setError(null);
    const client = actions ?? appealClient(realm, current.receiptId);
    const result = await client.submit(text, held).catch((): AppealSubmit => ({ kind: 'failed', reuseKey: true }));
    setPending(false);
    if (result.kind === 'sent') {
      setPendingReading(result.reading);
      setStatement('');
      return;
    }
    if (result.kind === 'invalid') {
      setError(t.statementEmpty);
      return;
    }
    if (!result.reuseKey) keyFor.current = null;
    setError(t.sendFailed);
  }

  return <section aria-label={t.region} className={cn(
    'mx-auto mt-4 w-[calc(100%-2rem)] max-w-6xl rounded-2xl border border-warning/40 bg-warning/8 px-4 py-4 sm:w-[calc(100%-3rem)] sm:px-5 lg:w-[calc(100%-5rem)]',
    className,
  )}>
    <div className="flex gap-3">
      <BanIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
      <div className="min-w-0 space-y-4">
        <div className="space-y-1">
          <h2 className="font-semibold text-warning-foreground tracking-tight">
            {schedule === 'ended' ? t.endedTitle : t.title}</h2>
          <p className="text-sm">{schedule === 'permanent' ? t.permanent
            : schedule === 'until' ? t.until({ date: formatWhen(current.bannedUntil!, locale) })
              : t.ended({ date: formatWhen(current.bannedUntil!, locale) })}</p>
          <p className="text-muted-foreground text-sm">{t.recorded({ date: formatWhen(current.happenedAt, locale) })}</p>
        </div>
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{t.reasonLabel}</h3>
          <blockquote className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{current.reason}</blockquote>
        </div>
        {appeal.kind === 'appeal' ? <form noValidate className="space-y-3" onSubmit={event => {
          event.preventDefault();
          void submit();
        }}>
          <div className="space-y-1">
            <h3 className="font-medium text-sm">{t.appealTitle}</h3>
            <p className="text-muted-foreground text-sm">{t.appealHelp}</p>
          </div>
          <Field invalid={Boolean(error)}>
            <FieldLabel>{t.statementLabel}</FieldLabel>
            <Textarea value={statement} disabled={pending} aria-invalid={Boolean(error)}
              onChange={event => { setStatement(event.target.value); if (error) setError(null); }} />
            <FieldDescription>{t.statementHint}</FieldDescription>
          </Field>
          {error ? <Alert variant="destructive" role="alert">
            <CircleAlertIcon aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
          <Button type="submit" isLoading={pending} className="w-full sm:w-auto">{t.send}</Button>
        </form> : <div className="space-y-2">
          <h3 className="font-medium text-sm">{appeal.kind === 'received' ? t.receivedTitle
            : appeal.kind === 'upheld' ? t.upheldTitle : t.reversedTitle}</h3>
          <p className="text-sm">{appeal.kind === 'received' ? t.receivedBody
            : appeal.kind === 'upheld' ? t.upheldBody : t.reversedBody}</p>
          {appeal.kind !== 'received' && appeal.decidedAt
            ? <p className="text-muted-foreground text-sm">{t.decided({ date: formatWhen(appeal.decidedAt, locale) })}</p>
            : null}
          <h4 className="font-medium text-sm">{t.statementHeading}</h4>
          <blockquote className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{appeal.statement}</blockquote>
          {appeal.kind !== 'received' && appeal.rationale ? <>
            <h4 className="font-medium text-sm">{t.sharedLabel}</h4>
            <blockquote className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{appeal.rationale}</blockquote>
          </> : null}
        </div>}
      </div>
    </div>
  </section>;
}
