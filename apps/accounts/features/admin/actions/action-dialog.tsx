'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { NativeSelect } from '@rezics/ui/native-select';
import { Progress, ProgressTrack, ProgressRange } from '@rezics/ui/progress';
import { Textarea } from '@rezics/ui/textarea';
import { toast } from '@rezics/ui/toast';
import { cn } from '@rezics/ui/utils';
import { BanIcon, CheckIcon, CircleAlertIcon, LoaderIcon, MinusIcon, ShieldIcon, Undo2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { AdminAction, BulkAction, Job, ReasonCode } from '../api/types.ts';
import { useAdmin } from '../shell/admin-context.tsx';
import { type ActionTarget, bulkOutcome, bulkUndoSeconds, damage, type Duration, sanctions,
  suspensionEnd } from './actions.ts';
import { ErrorAlert, errorMessage, type Reason, ReasonFields, TypedConfirmation, useDismiss, useReauth } from './confirm.tsx';
import { actionLabel } from '../audit/entry.tsx';
import { nameList } from '../format.tsx';
import { useLocale, useTranslation } from '../../../i18n/client.ts';

export interface ActionRequest { action: AdminAction; targets: ActionTarget[] }

const emptyReason: Reason = { code: '', detail: '', message: '' };

/** One dialog for every user action, single or bulk. It stays open with a
 * pending button until the service confirms; nothing changes on screen before. */
export function ActionDialog({ request, onClose, onDone }: { request: ActionRequest | null; onClose(): void;
  onDone(): void }) {
  // A fresh form (and command ID) for every request.
  return request ? <ActionForm key={`${request.action}:${request.targets.map(target => target.id).join(',')}`}
    request={request} onClose={onClose} onDone={onDone} /> : null;
}

const outcomeIcons = { change: CheckIcon, unchanged: MinusIcon, staff: ShieldIcon } as const;

/** Before a bulk action: how many of the selection it would change, and who
 * it leaves out and why. Only the users it would change are sent. */
function BulkPreview({ action, targets }: { action: BulkAction; targets: ActionTarget[] }) {
  const { t } = useTranslation('admin');
  const locale = useLocale().current;
  const { me } = useAdmin();
  const groups = (['change', 'unchanged', 'staff'] as const).map(outcome => ({ outcome,
    names: targets.filter(target => bulkOutcome(action, target, me) === outcome).map(target => target.name || target.email) }))
    .filter(group => group.names.length);
  return <div className="flex flex-col gap-1.5 rounded-2xl bg-muted/60 px-4 py-3 text-sm">
    <p className="font-medium">{t.undo.previewTitle}</p>
    <ul className="flex flex-col gap-1">{groups.map(({ outcome, names }) => {
      const Icon = outcomeIcons[outcome];
      const sample = names.slice(0, 3);
      return <li key={outcome} className="flex items-start gap-2">
        <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', outcome === 'change' ? 'text-success-foreground' : 'text-muted-foreground')} />
        <span><span className={outcome === 'change' ? 'font-medium' : undefined}>{t.undo.outcomes[outcome](names.length)}</span>
          <span className="text-muted-foreground">{' — '}{nameList(sample, locale)}
            {names.length > sample.length ? ` ${t.bulkMore(names.length - sample.length)}` : null}</span></span>
      </li>;
    })}</ul>
  </div>;
}

function ActionForm({ request, onClose, onDone }: { request: ActionRequest; onClose(): void; onDone(): void }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const { me } = useAdmin();
  const { action, targets } = request;
  const single = targets.length === 1 ? targets[0]! : null;
  const level = !single && damage[action] === 'low' ? 'medium' : damage[action];
  const sanction = sanctions.includes(action);
  const codes = (me.reasonCodes[action] ?? []) as ReasonCode[];
  const [commandId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState<Reason>(emptyReason);
  const [note, setNote] = useState('');
  const [duration, setDuration] = useState<Duration>('week');
  const [customDate, setCustomDate] = useState('');
  const [typed, setTyped] = useState('');
  const reauth = useReauth(level === 'high');
  const [showErrors, setShowErrors] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const changing = single ? targets : targets.filter(target => bulkOutcome(action as BulkAction, target, me) === 'change');
  const expected = single ? single.email : String(changing.length);
  const dismiss = useDismiss(onClose, { enabled: !pending, outside: level === 'low' });
  const label = single ? single.name || single.email : '';

  const end = action === 'suspend' ? suspensionEnd(duration, customDate) : undefined;
  const invalid = (sanction && (!reason.code || reason.detail.trim().length < 3))
    || (action === 'add-note' && !note.trim()) || end === null || !changing.length
    || (level === 'high' && typed.trim() !== expected) || reauth.missing;

  async function submit() {
    setShowErrors(true);
    if (invalid) return;
    setPending(true); setError(null);
    const code = reason.code || undefined;
    // The service wants a reason for every action; a note or a resend without
    // details records the chosen reason's name, or the action's.
    const text = reason.detail.trim() || (code ? t.reasonCodes[code] : t.actionLabels[action]);
    const message = sanction && reason.message.trim() ? reason.message.trim() : undefined;
    if (single) {
      const result = await reauth.run(() => api.act(single.id, { action, commandId, reason: text, reasonCode: code,
        userMessage: message, expiresAt: end ?? undefined, note: action === 'add-note' ? note.trim() : undefined }));
      setPending(false);
      if (!result.ok) { setError(result.message); return; }
      toast.success({ title: t.done[action]({ name: label }), description: t.requestId({ id: result.data.requestId }) });
      onDone();
      return;
    }
    const result = await reauth.run(() => api.bulk({ action: action as BulkAction, commandId, reason: text, reasonCode: code!,
      userMessage: message, expiresAt: end ?? undefined, userIds: changing.map(target => target.id),
      undoSeconds: Math.min(bulkUndoSeconds, me.bulkUndoLimit) }));
    setPending(false);
    if (!result.ok) { setError(result.message); return; }
    setJobId(result.data.jobId);
  }

  if (jobId) return <JobDialog jobId={jobId} action={action} count={changing.length} onClose={onDone} />;
  const title = single ? t.actionTitles[action]({ name: label }) : t.bulkTitles[action as BulkAction](changing.length || targets.length);
  return <Dialog open {...dismiss.root} role={level === 'low' ? 'dialog' : 'alertdialog'}>
    <DialogContent ref={dismiss.content} size="md" showCloseButton={false}>
      <form className="contents" onSubmit={event => { event.preventDefault(); void submit(); }} noValidate>
        <DialogHeader title={title} description={t.consequences[action]} />
        <DialogBody className="flex flex-col gap-4">
          {single ? <p className="rounded-2xl bg-muted/60 px-4 py-3 text-sm">
            <span className="font-medium">{single.name}</span>{' '}
            <span className="text-muted-foreground">{single.email}</span></p>
            : <BulkPreview action={action as BulkAction} targets={targets} />}
          {!single && !changing.length ? <p role="status" className="text-sm text-warning-foreground">{t.undo.noneWouldChange}</p> : null}
          {action === 'add-note' ? <Field invalid={showErrors && !note.trim()} disabled={pending}>
            <FieldLabel>{t.user.noteLabel}</FieldLabel>
            <Textarea value={note} maxLength={4000} placeholder={t.user.notePlaceholder} autoFocus
              onChange={event => setNote(event.currentTarget.value)} />
            <FieldError>{t.reasonTooShort}</FieldError>
          </Field> : null}
          {action === 'suspend' ? <div className="grid gap-4 sm:grid-cols-2">
            <Field disabled={pending}>
              <FieldLabel>{t.duration}</FieldLabel>
              <NativeSelect value={duration} className="w-full" onChange={event => setDuration(event.currentTarget.value as Duration)}>
                {(['day', 'week', 'month', 'quarter', 'indefinite', 'custom'] as const).map(value =>
                  <option key={value} value={value}>{t.durations[value]}</option>)}
              </NativeSelect>
            </Field>
            {duration === 'custom' ? <Field invalid={showErrors && end === null} disabled={pending}>
              <FieldLabel>{t.endsOn}</FieldLabel>
              <Input type="date" value={customDate} onChange={event => setCustomDate(event.currentTarget.value)} />
              <FieldError>{t.endsInPast}</FieldError>
            </Field> : null}
          </div> : null}
          {action === 'add-note' ? null : <ReasonFields codes={codes} value={reason} onChange={setReason} required={sanction}
            withMessage={sanction} disabled={pending} showErrors={showErrors} />}
          {level === 'high' && changing.length ? <TypedConfirmation expected={expected} value={typed} onChange={setTyped} disabled={pending}
            showError={showErrors} /> : null}
          {reauth.fields(pending)}
          {!single ? <p className="text-xs text-muted-foreground">{t.undo.windowNote({ seconds: Math.min(bulkUndoSeconds, me.bulkUndoLimit) })}</p> : null}
          <ErrorAlert message={error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>{t.cancel}</Button>
          <Button type="submit" variant={level === 'high' || action === 'revoke-sessions' ? 'destructive' : 'default'}
            isLoading={pending}>{pending ? t.pendingActions[action] : t.confirmActions[action]}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

const stateIcons = { pending: LoaderIcon, succeeded: CheckIcon, skipped: MinusIcon, failed: CircleAlertIcon, cancelled: BanIcon };

/** A bulk job: while its undo window lasts, a countdown and Undo (nothing has
 * changed yet); then progress and Stop (the rest stays unchanged); then each
 * user's result. Polled until it finishes; closing leaves it running. */
export function JobDialog({ jobId, action, count, onClose }: { jobId: string; action: string; count: number; onClose(): void }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const [job, setJob] = useState<Job | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [poll, setPoll] = useState(0);
  const dismiss = useDismiss(onClose);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const result = await api.job(jobId);
      if (stopped) return;
      if (result.ok) setJob(result.data);
      if (!result.ok || !result.data.finishedAt) timer = setTimeout(() => void read(), 600);
    };
    void read();
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, jobId, poll]);
  const startsAt = job ? Date.parse(job.startsAt) : 0;
  const waiting = !!job && !job.finishedAt && startsAt > now;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [waiting]);
  async function stop() {
    setStopping(true); setError(null);
    const result = await api.cancelJob(jobId);
    setStopping(false);
    if (!result.ok) { setError(errorMessage(result, t)); return; }
    toast.success({ title: waiting ? t.undo.undone : t.undo.stopped });
    setPoll(value => value + 1);
  }
  const done = job ? job.total - job.pending : 0;
  const total = job?.total ?? count;
  const seconds = Math.max(1, Math.ceil((startsAt - now) / 1000));
  const title = (t.bulkTitles as Record<string, (count: number) => string>)[action]?.(total) ?? actionLabel(action, t);
  const description = !job ? t.bulkRunning : waiting ? `${t.undo.startsIn(seconds)} ${t.undo.nothingYet}`
    : job.cancelledAt ? t.undo.stoppedSummary({ done: job.succeeded + job.skipped + job.failed, cancelled: job.cancelled })
      : job.finishedAt ? t.jobResult({ succeeded: job.succeeded, skipped: job.skipped, failed: job.failed }) : t.bulkRunning;
  return <Dialog open {...dismiss.root}>
    <DialogContent ref={dismiss.content} size="md" showCloseButton={false}>
      <DialogHeader title={title} description={description} />
      <DialogBody className="flex flex-col gap-4">
        {waiting ? <div className="flex items-center gap-3 rounded-2xl border border-primary/25 bg-primary/5 px-4 py-3 text-sm">
          <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full border-2 border-primary/40 font-semibold tabular-nums text-primary">
            {seconds}</span>
          <span>{t.undo.undoHelp}</span>
        </div> : <>
          <Progress value={total ? Math.round(done / total * 100) : undefined} aria-label={t.jobProgress({ done, total })}>
            <ProgressTrack><ProgressRange /></ProgressTrack>
          </Progress>
          <p className="text-sm text-muted-foreground" aria-live="polite">{t.jobProgress({ done, total })}</p>
        </>}
        <ul className="flex max-h-72 flex-col divide-y divide-border/60 overflow-auto rounded-2xl border border-border/60">
          {job?.items.map(item => {
            const Icon = stateIcons[item.state];
            return <li key={item.userId} className="flex items-center gap-3 px-4 py-2 text-sm">
              <Icon aria-hidden="true" className={item.state === 'failed' ? 'size-4 text-destructive-foreground'
                : item.state === 'succeeded' ? 'size-4 text-success-foreground' : 'size-4 text-muted-foreground'} />
              <span className="min-w-0 flex-1"><span className="block truncate">{item.name ?? item.userId}
                {item.email ? <span className="text-muted-foreground"> · {item.email}</span> : null}</span>
                {item.error ? <span className="block text-xs text-destructive-foreground">
                  {(t.itemErrors as Record<string, string>)[item.error] ?? t.itemErrors.other}</span> : null}</span>
              <span className={item.state === 'failed' ? 'text-destructive-foreground' : 'text-muted-foreground'}>
                {t.itemStates[item.state]}</span>
            </li>;
          })}
        </ul>
        {job && !job.finishedAt && !waiting ? <p className="text-xs text-muted-foreground">{t.undo.stopHelp}</p> : null}
        <ErrorAlert message={error} />
      </DialogBody>
      <DialogFooter>
        {job && !job.finishedAt ? <Button variant={waiting ? 'default' : 'outline'} isLoading={stopping} onClick={() => void stop()}>
          {waiting ? <><Undo2Icon aria-hidden="true" />{stopping ? t.undo.undoing : t.undo.undo}</> : stopping ? t.undo.stopping : t.undo.stop}
        </Button> : null}
        <Button variant={job && !job.finishedAt ? 'ghost' : 'default'} onClick={onClose}>
          {job && !job.finishedAt ? t.undo.keepGoing : t.bulkClose}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
