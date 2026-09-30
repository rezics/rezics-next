'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { RadioGroup, RadioGroupItem, RadioGroupLabel } from '@rezics/ui/radio-group';
import { Textarea } from '@rezics/ui/textarea';
import { materializeData } from 'native-i18n';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { type ActionRequest, decisionOf } from './actions.ts';
import { evidenceOf, type Source } from './candidate.ts';
import type { ProposalMessages } from './messages.ts';
import { SourcesField } from './sources-field.tsx';
import type { AllowedAction, ReviewOutcome } from './types.ts';

export type DialogAction = Extract<AllowedAction, 'review' | 'apply' | 'approve-and-apply' | 'reject' | 'withdraw' | 'revert'>;

const MESSAGE_LIMIT = 4000;

/**
 * The words an action needs before it is sent: a stance and message for a
 * review, a message for a decision, a confirmation for a withdrawal and
 * optional sources for a revert. It builds the one request the control
 * stands for; Main decides whether it may go through.
 */
export function ActionDialog({ action, revision, pending, error, onSend, onClose, locale, messages }: {
  action: DialogAction; revision: number; pending: boolean; error: string | null;
  onSend: (request: ActionRequest) => void; onClose: () => void; locale: UiLocale; messages: ProposalMessages;
}) {
  const t = materializeData(messages, { locale });
  const [outcome, setOutcome] = useState<ReviewOutcome>('approve');
  const [message, setMessage] = useState('');
  const [sources, setSources] = useState<Source[]>([{ source: '', locator: '' }]);
  const [tooLong, setTooLong] = useState(false);
  const title = { review: t.reviewTitle, apply: t.applyTitle, 'approve-and-apply': t.approveApplyTitle,
    reject: t.rejectTitle, withdraw: t.withdrawTitle, revert: t.revertTitle }[action];
  const description = { review: t.reviewDescription, apply: t.applyDescription,
    'approve-and-apply': t.approveApplyDescription, reject: t.rejectDescription, withdraw: t.withdrawDescription,
    revert: t.revertDescription }[action];
  const confirm = { review: t.send, apply: t.actionApply, 'approve-and-apply': t.actionApprove, reject: t.actionReject,
    withdraw: t.confirmWithdraw, revert: t.confirmRevert }[action];
  const wantsMessage = action !== 'withdraw' && action !== 'revert';
  const submit = () => {
    if (wantsMessage && message.length > MESSAGE_LIMIT) { setTooLong(true); return; }
    if (action === 'review') onSend({ kind: 'review', revision, outcome, message: message.trim() });
    else if (action === 'withdraw') onSend({ kind: 'withdraw', revision });
    else if (action === 'revert') onSend({ kind: 'revert', evidence: evidenceOf(sources, new Date().toISOString().slice(0, 10)) });
    else onSend({ kind: 'decide', revision, ...decisionOf(action), message: message.trim() });
  };
  return <Dialog open onOpenChange={details => { if (!details.open) onClose(); }}>
    <DialogContent size="md">
      <form noValidate className="contents" onSubmit={event => { event.preventDefault(); submit(); }}>
        <DialogHeader title={title} description={description} />
        <DialogBody className="grid gap-4">
          {action === 'review' ? <RadioGroup value={outcome} className="gap-2"
            onValueChange={details => setOutcome(details.value as ReviewOutcome)}>
            <RadioGroupLabel>{t.outcomeLabel}</RadioGroupLabel>
            <RadioGroupItem value="approve"><span className="grid"><span>{t.outcomeApprove}</span>
              <span className="text-muted-foreground text-xs">{t.outcomeApproveHelp}</span></span></RadioGroupItem>
            <RadioGroupItem value="request_changes"><span className="grid"><span>{t.outcomeChanges}</span>
              <span className="text-muted-foreground text-xs">{t.outcomeChangesHelp}</span></span></RadioGroupItem>
            <RadioGroupItem value="comment"><span className="grid"><span>{t.outcomeComment}</span>
              <span className="text-muted-foreground text-xs">{t.outcomeCommentHelp}</span></span></RadioGroupItem>
          </RadioGroup> : null}
          {wantsMessage ? <Field invalid={tooLong}>
            <FieldLabel>{t.messageLabel}</FieldLabel>
            <Textarea value={message} rows={4} maxLength={MESSAGE_LIMIT + 200} dir="auto"
              onChange={event => { setMessage(event.currentTarget.value); setTooLong(false); }} />
            {tooLong ? <FieldError>{t.messageTooLong}</FieldError> : <FieldHelper>{t.messageHelp}</FieldHelper>}
          </Field> : null}
          {action === 'revert' ? <SourcesField sources={sources} onChange={setSources} t={t} /> : null}
          {error ? <Field invalid><FieldError role="alert">{error}</FieldError></Field> : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t.cancel}</Button>
          <Button type="submit" disabled={pending} variant={action === 'reject' ? 'destructive' : 'default'}>{confirm}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
