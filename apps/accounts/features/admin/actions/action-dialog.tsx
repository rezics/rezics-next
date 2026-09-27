'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { NativeSelect } from '@rezics/ui/native-select';
import { Progress, ProgressTrack, ProgressRange } from '@rezics/ui/progress';
import { Textarea } from '@rezics/ui/textarea';
import { toast } from '@rezics/ui/toast';
import { CheckIcon, CircleAlertIcon, LoaderIcon, MinusIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { AdminAction, BulkAction, Job, ReasonCode } from '../api/types.ts';
import { useAdmin } from '../shell/admin-context.tsx';
import { type ActionTarget, damage, type Duration, sanctions, suspensionEnd } from './actions.ts';
import { ErrorAlert, type Reason, ReasonFields, TypedConfirmation, useReauth } from './confirm.tsx';
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

function ActionForm({ request, onClose, onDone }: { request: ActionRequest; onClose(): void; onDone(): void }) {
  const { t } = useTranslation('admin');
  const locale = useLocale().current;
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
  const expected = single ? single.email : String(targets.length);
  const label = single ? single.name || single.email : '';

  const end = action === 'suspend' ? suspensionEnd(duration, customDate) : undefined;
  const invalid = (sanction && (!reason.code || reason.detail.trim().length < 3))
    || (action === 'add-note' && !note.trim()) || end === null
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
      userMessage: message, expiresAt: end ?? undefined, userIds: targets.map(target => target.id) }));
    setPending(false);
    if (!result.ok) { setError(result.message); return; }
    setJobId(result.data.jobId);
  }

  if (jobId) return <BulkProgress jobId={jobId} action={action as BulkAction} onClose={onDone} />;
  const title = single ? t.actionTitles[action]({ name: label }) : t.bulkTitles[action as BulkAction](targets.length);
  const sample = targets.slice(0, 3).map(target => target.name || target.email);
  return <Dialog open onOpenChange={details => { if (!details.open && !pending) onClose(); }}
    closeOnInteractOutside={!pending} closeOnEscape={!pending} role={level === 'low' ? 'dialog' : 'alertdialog'}>
    <DialogContent size="md" showCloseButton={!pending}>
      <form className="contents" onSubmit={event => { event.preventDefault(); void submit(); }} noValidate>
        <DialogHeader title={title} description={t.consequences[action]} />
        <DialogBody className="flex flex-col gap-4">
          {single ? <p className="rounded-2xl bg-muted/60 px-4 py-3 text-sm">
            <span className="font-medium">{single.name}</span>{' '}
            <span className="text-muted-foreground">{single.email}</span></p>
            : <p className="rounded-2xl bg-muted/60 px-4 py-3 text-sm">
              {t.bulkSample({ names: nameList(sample, locale) })}
              {targets.length > sample.length ? ` ${t.bulkMore(targets.length - sample.length)}` : null}
              <span className="mt-1 block text-muted-foreground">{t.bulkSkipNote}</span></p>}
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
          {level === 'high' ? <TypedConfirmation expected={expected} value={typed} onChange={setTyped} disabled={pending}
            showError={showErrors} /> : null}
          {reauth.fields(pending)}
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

const stateIcons = { pending: LoaderIcon, succeeded: CheckIcon, skipped: MinusIcon, failed: CircleAlertIcon };

/** A bulk job's progress and per-user results, polled until it finishes. */
function BulkProgress({ jobId, action, onClose }: { jobId: string; action: BulkAction; onClose(): void }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await api.job(jobId);
      if (stopped) return;
      if (result.ok) setJob(result.data);
      if (!result.ok || !result.data.finishedAt) timer = setTimeout(() => void poll(), 600);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, jobId]);
  const done = job ? job.total - job.pending : 0;
  const total = job?.total ?? 0;
  return <Dialog open onOpenChange={details => { if (!details.open) onClose(); }}>
    <DialogContent size="md">
      <DialogHeader title={t.bulkTitles[action](total || 1)}
        description={job?.finishedAt ? t.jobResult({ succeeded: job.succeeded, skipped: job.skipped, failed: job.failed })
          : t.bulkRunning} />
      <DialogBody className="flex flex-col gap-4">
        <Progress value={total ? Math.round(done / total * 100) : undefined} aria-label={t.jobProgress({ done, total })}>
          <ProgressTrack><ProgressRange /></ProgressTrack>
        </Progress>
        <p className="text-sm text-muted-foreground" aria-live="polite">{t.jobProgress({ done, total })}</p>
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
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t.bulkClose}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
