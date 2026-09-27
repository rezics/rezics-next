'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Textarea } from '@rezics/ui/textarea';
import { materializeData } from 'native-i18n';
import { useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { actionLabel } from './labels.ts';
import type { ManageMessages } from './messages.ts';
import type { Decision, QueueAction } from './queue-state.ts';

export const REASON_LIMIT = 2000;

/**
 * Asks for the reason Main requires before a rejection, a change request or an
 * escalation. The decision is not sent here; it enters the undo window.
 */
export function ReasonDialog({ action, count, onDecide, onClose, finalFocus, locale, messages }: {
  action: Exclude<QueueAction, 'approve'> | null; count: number; onDecide: (decision: Decision) => void;
  onClose: () => void; locale: UiLocale; messages: ManageMessages;
  /** Where focus goes when the dialog closes: the queue's next item, so shortcuts keep working. */
  finalFocus?: () => HTMLElement | null;
}) {
  const t = materializeData(messages, { locale });
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  // The dialog animates out after `action` clears; keep its words until it is gone.
  const [shown, setShown] = useState(action ?? 'reject');
  const [opened, setOpened] = useState(action !== null);
  // A fresh decision starts empty; the text stays while the last dialog animates out.
  if ((action !== null) !== opened) {
    setOpened(action !== null);
    if (action) { setShown(action); setReason(''); setNote(''); setError(null); }
  }
  const escalating = shown === 'escalate';
  const title = shown === 'reject' ? t.reasonRejectTitle(count)
    : shown === 'request-changes' ? t.reasonChangesTitle(count) : t.reasonEscalateTitle(count);
  const close = () => onClose();
  const submit = () => {
    const text = reason.trim();
    if (!text) { setError(t.reasonRequired); return; }
    if (text.length > REASON_LIMIT || note.length > 4000) { setError(t.reasonTooLong); return; }
    onDecide({ action: shown, reason: text, note: escalating ? null : note.trim() || null });
  };
  return <Dialog open={action !== null} onOpenChange={details => { if (!details.open) close(); }}
    initialFocusEl={() => reasonRef.current} {...finalFocus ? { finalFocusEl: finalFocus } : {}}>
    <DialogContent size="md">
      <form noValidate onSubmit={event => { event.preventDefault(); submit(); }} className="contents">
        <DialogHeader title={title} description={t.undoHint} />
        <DialogBody className="grid gap-4">
          <Field invalid={error !== null}>
            <FieldLabel>{escalating ? t.escalateReasonLabel : t.publicReasonLabel}</FieldLabel>
            <Textarea ref={reasonRef} value={reason} maxLength={REASON_LIMIT + 200} rows={4}
              onChange={event => { setReason(event.currentTarget.value); setError(null); }}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }} />
            {error ? <FieldError>{error}</FieldError>
              : <FieldHelper>{escalating ? t.escalateReasonHelp : t.publicReasonHelp}</FieldHelper>}
          </Field>
          {escalating ? null : <Field>
            <FieldLabel>{t.noteLabel}</FieldLabel>
            <Textarea value={note} rows={2} maxLength={4000} onChange={event => setNote(event.currentTarget.value)} />
            <FieldHelper>{t.noteHelp}</FieldHelper>
          </Field>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>{t.cancel}</Button>
          <Button type="submit" variant={shown === 'reject' ? 'destructive' : 'default'}>{actionLabel(shown, t)}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
